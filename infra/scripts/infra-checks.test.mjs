// Static checks on the Terraform tree. Terraform itself is not installed in every
// developer environment, so these guard the parts that carry policy: the org
// policies, the prod gate, the backend rule, "no account ids or keys", and
// "block-public-access + KMS on every bucket" (CONSTRAINTS; dev-alignment 0.10).
// Run: node --test infra/scripts/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'terraform');
const read = (...p) => readFileSync(join(root, ...p), 'utf8');
const json = (...p) => JSON.parse(read(...p));

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === '.terraform') continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

// Services the product uses, all on the AWS HIPAA-eligible list. Adding one
// here is a PR with the eligibility citation in docs/subprocessors.md.
const requiredServices = [
  'ec2', 'rds', 's3', 'sqs', 'kms', 'cognito-idp', 'bedrock', 'textract',
  'cloudwatch', 'logs', 'iam', 'sts', 'ecs', 'ecr',
];
const forbiddenServices = ['lambda', 'ses', 'sns', 'sagemaker', 'comprehend', 'comprehendmedical', 'transcribe'];

test('SCP allowlist names every service we use and nothing we rejected', () => {
  const policy = json('modules', 'org-guardrails', 'policies', 'scp-hipaa-allowlist.json');
  const deny = policy.Statement.find((s) => s.Sid === 'DenyServicesOutsideHipaaEligibleAllowlist');
  assert.equal(deny.Effect, 'Deny');
  const allowed = deny.NotAction.map((a) => a.replace(/:\*$/, ''));
  for (const s of requiredServices) assert.ok(allowed.includes(s), `missing ${s}`);
  for (const s of forbiddenServices) assert.ok(!allowed.includes(s), `${s} must not be allowlisted`);
  const logging = policy.Statement.find((s) => s.Sid === 'DenyBedrockInvocationLogging');
  assert.deepEqual(logging.Action, ['bedrock:PutModelInvocationLoggingConfiguration']);
});

test('region SCP permits only us-east-1 and us-west-2', () => {
  const policy = json('modules', 'org-guardrails', 'policies', 'scp-region-restriction.json');
  const regions = policy.Statement[0].Condition.StringNotEquals['aws:RequestedRegion'];
  assert.deepEqual([...regions].sort(), ['us-east-1', 'us-west-2']);
});

test('AI services opt-out applies to every service and cannot be overridden', () => {
  const policy = json('modules', 'org-guardrails', 'policies', 'ai-services-opt-out.json');
  assert.equal(policy.services.default.opt_out_policy['@@assign'], 'optOut');
  assert.deepEqual(policy.services['@@operators_allowed_for_child_policies'], ['@@none']);
});

test('every env root uses an empty s3 backend block (values via -backend-config)', () => {
  for (const env of ['dev', 'test', 'prod', 'org']) {
    const versions = read('envs', env, 'versions.tf');
    assert.match(versions, /backend\s+"s3"\s+\{\s*\}/, `${env}: backend must be empty`);
  }
});

test('prod is gated: enabled defaults to false and every module is count-guarded', () => {
  const vars = read('envs', 'prod', 'variables.tf');
  assert.match(vars, /variable\s+"enabled"\s+\{[^}]*default\s+=\s+false/s);
  const main = read('envs', 'prod', 'main.tf');
  const modules = main.split(/\nmodule\s+/).slice(1);
  assert.equal(modules.length, 8, 'expected the eight env modules');
  for (const block of modules) assert.match(block, /count\s+=\s+local\.n/, block.split('\n')[0]);
});

test('no AWS account ids, access keys or real-looking emails anywhere in infra', () => {
  for (const file of walk(root)) {
    const text = readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /\b\d{12}\b/, `${file}: 12-digit number looks like an account id`);
    assert.doesNotMatch(text, /AKIA[0-9A-Z]{16}/, `${file}: access key`);
    for (const email of text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) ?? []) {
      assert.ok(email.endsWith('example.invalid'), `${file}: ${email} is not a placeholder`);
    }
  }
});

test('every bucket has block-public-access, KMS encryption and a TLS-only policy', () => {
  for (const file of walk(join(root, 'modules')).filter((f) => f.endsWith('.tf'))) {
    const text = readFileSync(file, 'utf8');
    for (const [, name] of text.matchAll(/resource\s+"aws_s3_bucket"\s+"([^"]+)"/g)) {
      assert.match(text, new RegExp(`resource\\s+"aws_s3_bucket_public_access_block"\\s+"${name}"`), `${file}: ${name} public access block`);
      assert.match(text, new RegExp(`resource\\s+"aws_s3_bucket_server_side_encryption_configuration"\\s+"${name}"`), `${file}: ${name} sse`);
      assert.match(text, /sse_algorithm\s+=\s+"aws:kms"/, `${file}: ${name} must use KMS`);
      assert.match(text, /aws:SecureTransport/, `${file}: ${name} needs the TLS-only policy`);
    }
  }
});

test('network egress allowlist is exactly s3, sqs, bedrock-runtime, textract, logs, kms', () => {
  const text = read('modules', 'network', 'main.tf');
  const iface = text.split(/\nresource\s+/).find((b) => b.startsWith('"aws_vpc_endpoint" "interface"'));
  const list = iface.match(/for_each\s+=\s+toset\(\[([^\]]+)\]\)/)[1];
  const services = [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(services, ['bedrock-runtime', 'kms', 'logs', 'sqs', 'textract']);
  assert.match(text, /service_name\s+=\s+"com\.amazonaws\.\$\{data\.aws_region\.current\.name\}\.s3"/);
  const vars = read('modules', 'network', 'variables.tf');
  assert.match(vars, /variable\s+"allow_nat"\s+\{[^}]*default\s+=\s+false/s, 'allow_nat must default to false');
});

test('every aws_vpc_endpoint carries a policy; S3 and Bedrock are pinned to variables', () => {
  const text = read('modules', 'network', 'main.tf');
  const endpoints = text.split(/\nresource\s+/).filter((b) => b.startsWith('"aws_vpc_endpoint"'));
  assert.equal(endpoints.length, 2, 'expected the s3 gateway and the interface endpoints');
  for (const block of endpoints) assert.match(block, /\n\s+policy\s+=\s+\S/, block.split('\n')[0]);
  assert.match(text, /var\.documents_bucket_arn/);
  assert.match(text, /var\.audit_anchor_bucket_arn/);
  assert.match(text, /resources\s+=\s+var\.bedrock_model_arns/);
  assert.match(text, /"bedrock:InvokeModel",\s+"bedrock:InvokeModelWithResponseStream",/);
  assert.equal((text.match(/variable\s+=\s+"aws:PrincipalAccount"/g) ?? []).length, 3, 's3, bedrock and the shared account-scoped policy');
  for (const env of ['dev', 'test', 'prod']) {
    const main = read('envs', env, 'main.tf');
    for (const v of ['documents_bucket_arn', 'audit_anchor_bucket_arn', 'bedrock_model_arns']) {
      assert.match(main, new RegExp(`\\n\\s+${v}\\s+=`), `${env}: network.${v} not wired`);
    }
  }
});

test('audit-anchor bucket: writer is a role ARN, keys are write-once, nobody deletes', () => {
  const text = read('modules', 'audit-anchor', 'main.tf');
  const bucketPolicy = text.match(/data "aws_iam_policy_document" "anchor" \{[\s\S]*?\nresource "aws_s3_bucket_policy"/)[0];
  assert.doesNotMatch(bucketPolicy, /:root/, 'bucket policy must not grant the account root');
  assert.match(bucketPolicy, /identifiers\s+=\s+\[var\.writer_role_arn\]/);
  assert.doesNotMatch(text, /writer_account_id/);
  const deny = text.match(/sid\s+=\s+"DenyOverwriteWriteOnceKeys"[\s\S]*?\n  \}\n/)[0];
  assert.match(deny, /actions\s+=\s+\["s3:PutObject"\]/);
  assert.match(deny, /test\s+=\s+"StringNotEquals"\s+variable\s+=\s+"s3:if-none-match"\s+values\s+=\s+\["\*"\]/);
  const del = text.match(/sid\s+=\s+"DenyDeleteForEveryone"[\s\S]*?\n  \}\n/)[0];
  assert.match(del, /actions\s+=\s+\["s3:DeleteObject\*"\]/);
  assert.match(del, /identifiers\s+=\s+\["\*"\]/);
  for (const env of ['dev', 'test', 'prod']) {
    assert.match(read('envs', env, 'main.tf'), /writer_role_arn\s+=\s+"arn:aws:iam::\$\{data\.aws_caller_identity\.current\.account_id\}:role\//, env);
  }
});

test('RDS parameter group closes the error-path PHI leaks', () => {
  const text = read('modules', 'database', 'main.tf');
  const expected = {
    log_statement: 'none',
    log_min_duration_statement: '-1',
    log_min_error_statement: 'panic',
    log_error_verbosity: 'terse',
    log_parameter_max_length_on_error: '0',
    log_min_messages: 'warning',
  };
  for (const [name, value] of Object.entries(expected)) {
    assert.match(text, new RegExp(`name\\s+=\\s+"${name}"\\s+value\\s+=\\s+"${value}"`), name);
  }
  assert.match(text, /enabled_cloudwatch_logs_exports\s+=\s+\[\]/);
  assert.match(text, /performance_insights_enabled\s+=\s+false/);
});

test('test and prod never open NAT or force_destroy; prod and test keep deletion protection', () => {
  for (const env of ['test', 'prod']) {
    for (const file of walk(join(root, 'envs', env))) {
      const text = readFileSync(file, 'utf8');
      assert.doesNotMatch(text, /\b(allow_nat|force_destroy)\s*=\s*true\b/, file);
      assert.doesNotMatch(text, /variable\s+"(allow_nat|force_destroy)"/, `${file}: ${env} must not even expose the knob`);
    }
    const main = read('envs', env, 'main.tf');
    assert.doesNotMatch(main, /deletion_protection\s*=\s*false/, `${env}: deletion protection off`);
    const database = main.split(/\nmodule\s+/).find((b) => b.startsWith('"database"'));
    assert.match(database, /deletion_protection\s+=\s+true/, `${env}: database must set deletion_protection = true`);
  }
});

test('auth: no SMS template; token validity is not the idle timeout', () => {
  const text = read('modules', 'auth', 'main.tf');
  assert.doesNotMatch(text, /sms_message/);
  assert.match(text, /client[^\n]*M3/i, 'token-validity comment must say the 15-minute idle timeout is client-enforced at M3');
});

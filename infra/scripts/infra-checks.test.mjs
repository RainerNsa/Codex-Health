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
  'cloudwatch', 'logs', 'iam', 'sts', 'ecs', 'ecr', 'cloudtrail', 'guardduty',
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
  const blocks = main.split(/\n(?=module\s+|resource\s+)/).slice(1);
  assert.equal(blocks.length, 11, 'expected the ten env modules and the GuardDuty detector');
  for (const block of blocks) assert.match(block, /count\s+=\s+local\.n/, block.split('\n')[0]);
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
    assert.match(read('envs', env, 'main.tf'), /writer_role_arn\s+=\s+module\.compute_roles(\[0\])?\.role_arns\["anchor_writer"\]/, env);
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

// --- M1 close-out (SPEC §12.4 "still M1"; decision log 2026-10-29) ----------

// The statement block that carries one sid, by string search (no regex built from data): from the `sid = "<sid>"`
// line back to the statement's opening brace, forward to its matching close.
const policyBlock = (text, sid) => {
  const marker = `"${sid}"`;
  let at = -1;
  for (const line of text.split('\n')) {
    if (line.includes('sid') && line.includes('=') && line.includes(marker)) { at = text.indexOf(line); break; }
  }
  if (at < 0) return undefined;
  const open = text.lastIndexOf('{', at);
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') { depth -= 1; if (depth === 0) return text.slice(open, i + 1); }
  }
  return undefined;
};
const envMains = ['dev', 'test', 'prod'].map((env) => [env, read('envs', env, 'main.tf')]);

test('queue policy: SendMessage only for sender_role_arns, consume only for consumer_role_arns, TLS required', () => {
  const text = read('modules', 'queue', 'main.tf');
  assert.match(text, /resource\s+"aws_sqs_queue_policy"\s+"processing"/);
  const send = text.match(/sid\s+=\s+"DenySendExceptSenderRoles"[\s\S]*?\n  \}\n/)[0];
  assert.match(send, /actions\s+=\s+\["sqs:SendMessage"\]/);
  assert.match(send, /aws:PrincipalArn[\s\S]*values\s+=\s+var\.sender_role_arns/);
  const consume = text.match(/sid\s+=\s+"DenyConsumeExceptConsumerRoles"[\s\S]*?\n  \}\n/)[0];
  for (const a of ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:ChangeMessageVisibility']) assert.match(consume, new RegExp(`"${a}"`));
  assert.match(consume, /values\s+=\s+var\.consumer_role_arns/);
  assert.match(text, /aws:SecureTransport/);
  const vars = read('modules', 'queue', 'variables.tf');
  for (const v of ['sender_role_arns', 'consumer_role_arns']) assert.match(vars, new RegExp(`variable\\s+"${v}"\\s+\\{[^}]*default\\s+=\\s+\\[\\]`, 's'), `${v} defaults to nobody`);
  for (const [env, main] of envMains) {
    assert.match(main, /sender_role_arns\s+=\s+\[module\.compute_roles(\[0\])?\.role_arns\["api"\]\]/, env);
    assert.match(main, /consumer_role_arns\s+=\s+\[module\.compute_roles(\[0\])?\.role_arns\["worker"\]\]/, env);
  }
});

test('compute roles: no DeleteObject, Bedrock invoke-only on pinned ARNs, logs limited to own group, session role trusts the worker only', () => {
  const text = read('modules', 'compute-roles', 'main.tf');
  assert.doesNotMatch(text, /s3:DeleteObject/);
  assert.doesNotMatch(text, /"s3:\*"/);
  const bedrock = [...text.matchAll(/"bedrock:[^"]+"/g)].map((m) => m[0]);
  assert.deepEqual([...new Set(bedrock)].sort(), ['"bedrock:InvokeModel"', '"bedrock:InvokeModelWithResponseStream"']);
  assert.match(text, /"bedrock:InvokeModelWithResponseStream"\]\s+resources\s+=\s+var\.bedrock_model_arns/);
  const logs = [...text.matchAll(/"logs:[^"]+"/g)].map((m) => m[0]);
  assert.deepEqual([...new Set(logs)].sort(), ['"logs:CreateLogStream"', '"logs:PutLogEvents"']);
  assert.doesNotMatch(text, /"kms:\*"|"iam:|"sts:\*"/);
  assert.match(text, /identifiers\s+=\s+\["ecs-tasks\.amazonaws\.com"\]/);
  assert.match(text, /"worker_session_trust"[\s\S]*?identifiers\s+=\s+\[aws_iam_role\.ecs\["worker"\]\.arn\]/);
  assert.match(text, /"worker_session"\s+\{[\s\S]*?resources\s+=\s+\["\$\{var\.documents_bucket_arn\}\/documents\/\*"\]/);
  const worker = text.match(/data "aws_iam_policy_document" "worker" \{[\s\S]*?\n\}\n/)[0];
  assert.doesNotMatch(worker, /"s3:/, 'the worker reaches S3 only through the per-job session role');
  for (const [env, main] of envMains) assert.match(main, /module\s+"compute_roles"/, env);
});

test('audit-anchor: writer and verifier are distinct role variables; the verifier never puts', () => {
  const text = read('modules', 'audit-anchor', 'main.tf');
  const vars = read('modules', 'audit-anchor', 'variables.tf');
  for (const v of ['writer_role_arn', 'verifier_role_arn']) assert.match(vars, new RegExp(`variable\\s+"${v}"[\\s\\S]*?role/`), `${v} validated as a role ARN`);
  const put = policyBlock(text, 'WriterRolePutsAnchors');
  assert.match(put, /actions\s+=\s+\["s3:PutObject"\]/);
  assert.match(put, /identifiers\s+=\s+\[var\.writer_role_arn\]/);
  const get = policyBlock(text, 'VerifierRoleReadsAnchorsAndVersions');
  assert.doesNotMatch(get, /PutObject/);
  for (const a of ['s3:GetObject', 's3:GetObjectVersion', 's3:ListBucket', 's3:ListBucketVersions']) assert.match(get, new RegExp(`"${a}"`));
  assert.match(get, /identifiers\s+=\s+\[var\.verifier_role_arn\]/);
  const decrypt = policyBlock(text, 'VerifierRoleDecrypts');
  assert.doesNotMatch(decrypt, /Encrypt|GenerateDataKey/);
  assert.doesNotMatch(policyBlock(text, 'WriterRoleEncrypts'), /"kms:Decrypt"/);
  assert.match(text, /organization\/<organization_id>\/<date>\.json/, 'key scheme lists the platform chain');
  for (const [env, main] of envMains) assert.match(main, /verifier_role_arn\s+=\s+module\.compute_roles(\[0\])?\.role_arns\["anchor_verifier"\]/, env);
});

test('log groups: retention <= 30 days and the environment KMS key', () => {
  const text = read('modules', 'logs', 'main.tf');
  assert.match(text, /retention_in_days\s+=\s+var\.retention_days/);
  assert.match(text, /kms_key_id\s+=\s+var\.kms_key_arn/);
  const vars = read('modules', 'logs', 'variables.tf');
  const def = Number(vars.match(/variable\s+"retention_days"\s+\{[^}]*default\s+=\s+(\d+)/s)[1]);
  assert.ok(def <= 30, `default retention ${def} exceeds 30`);
  assert.match(vars, /contains\(\[1, 3, 5, 7, 14, 30\], var\.retention_days\)/);
  for (const [env, main] of envMains) assert.match(main, /module\s+"logs"/, env);
});

test('KMS key policy: no wildcard principal, kms:* only for the account root, logs service and ViaService statements', () => {
  const text = read('modules', 'kms', 'main.tf');
  const key = text.match(/resource "aws_kms_key" "this" \{[\s\S]*?\n\}\n/)[0];
  assert.match(key, /policy\s+=\s+data\.aws_iam_policy_document\.key\.json/, 'explicit key policy replaces the account-root default');
  assert.doesNotMatch(text, /identifiers\s+=\s+\["\*"\]/, 'no wildcard principal');
  const star = text.match(/actions\s+=\s+\["kms:\*"\][\s\S]*?identifiers\s+=\s+\[([^\]]+)\]/);
  assert.equal(star[1].trim(), 'local.account_root');
  assert.equal((text.match(/"kms:\*"/g) ?? []).length, 1, 'kms:* appears once, for the root');
  assert.match(text, /identifiers\s+=\s+\["logs\.\$\{data\.aws_region\.current\.name\}\.amazonaws\.com"\]/);
  assert.match(text, /kms:EncryptionContext:aws:logs:arn/);
  assert.match(text, /variable\s+=\s+"kms:ViaService"/);
  assert.match(text, /identifiers\s+=\s+var\.user_role_arns/);
  assert.match(read('modules', 'kms', 'variables.tf'), /variable\s+"user_role_arns"\s+\{[^}]*default\s+=\s+\[\]/s);
  for (const [env, main] of envMains) assert.match(main, /user_role_arns\s+=\s+\[for k in \["api", "worker", "worker_session"\]/, env);
});

test('documents bucket: principal deny is conditional on a non-empty role list and excludes the account root', () => {
  const text = read('modules', 'storage', 'main.tf');
  const deny = text.match(/dynamic "statement" \{\s+for_each = length\(var\.principal_role_arns\) > 0 \? \[1\] : \[\][\s\S]*?DenyDataAccessExceptListedRoles[\s\S]*?\n  \}\n/);
  assert.ok(deny, 'deny statement emitted only when principal_role_arns is non-empty');
  assert.match(deny[0], /actions\s+=\s+\["s3:\*"\]/);
  assert.match(deny[0], /test\s+=\s+"ArnNotEquals"\s+variable\s+=\s+"aws:PrincipalArn"\s+values\s+=\s+local\.data_principals/);
  assert.match(text, /data_principals\s+=\s+concat\(var\.principal_role_arns, \["arn:aws:iam::\$\{data\.aws_caller_identity\.current\.account_id\}:root"\]\)/);
  assert.match(text, /DenyListExceptListedRoles/);
  assert.match(read('modules', 'storage', 'variables.tf'), /variable\s+"principal_role_arns"\s+\{[^}]*default\s+=\s+\[\]/s);
  for (const [env, main] of envMains) assert.match(main, /principal_role_arns\s+=\s+\[module\.compute_roles(\[0\])?\.role_arns\["api"\], module\.compute_roles(\[0\])?\.role_arns\["worker_session"\]\]/, env);
});

test('CloudTrail: organization trail, multi-region, log file validation, KMS, no data events, 400-day bucket lifecycle', () => {
  const text = read('modules', 'detective', 'main.tf');
  const trail = text.match(/resource "aws_cloudtrail" "org" \{[\s\S]*?\n\}\n/)[0];
  for (const line of ['is_organization_trail\\s+=\\s+true', 'is_multi_region_trail\\s+=\\s+true', 'enable_log_file_validation\\s+=\\s+true', 'kms_key_id\\s+=\\s+aws_kms_key\\.trail\\.arn']) {
    assert.match(trail, new RegExp(line), line);
  }
  assert.doesNotMatch(trail, /data_resource|advanced_event_selector|insight_selector/);
  assert.match(text, /expiration \{\s+days = 400/);
  assert.match(read('envs', 'org', 'main.tf'), /module\s+"detective"/);
  const scp = json('modules', 'org-guardrails', 'policies', 'scp-hipaa-allowlist.json');
  assert.deepEqual(scp.Statement.find((s) => s.Sid === 'DenyDisablingCloudTrail').Action, ['cloudtrail:StopLogging', 'cloudtrail:DeleteTrail']);
});

test('GuardDuty: delegated admin in the org root; a detector in every workload root, count-guarded in prod', () => {
  const org = read('modules', 'detective', 'main.tf');
  assert.match(org, /resource "aws_guardduty_organization_admin_account"/);
  assert.match(org, /resource "aws_guardduty_detector" "management" \{\s+enable\s+=\s+true/);
  for (const [env, main] of envMains) {
    const detector = main.match(/resource "aws_guardduty_detector" "this" \{[\s\S]*?\n\}\n/)?.[0];
    assert.ok(detector, `${env}: detector`);
    assert.match(detector, /enable\s+=\s+true/, env);
    assert.match(detector, /finding_publishing_frequency\s+=\s+"FIFTEEN_MINUTES"/, env);
    if (env === 'prod') assert.match(detector, /count\s+=\s+local\.n/, 'prod detector must be gated');
  }
});

// CONSTRAINTS: no credentials in the repo. Uses gitleaks when installed, otherwise a built-in
// regex fallback. The result line names which mode ran.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { repoRoot, walk, scanFiles, formatHits, finish, SKIP_DIRS } from './lib.mjs';

const NAME = 'secrets';

function gitleaksInstalled() {
  const probe = spawnSync('gitleaks', ['version'], { encoding: 'utf8' });
  return !probe.error && probe.status === 0;
}

if (gitleaksInstalled()) {
  const args = ['detect', '--source', repoRoot, '--no-git', '--redact', '--no-banner', '--exit-code', '1'];
  const config = path.join(repoRoot, '.gitleaks.toml');
  if (fs.existsSync(config)) args.push('--config', config);
  const run = spawnSync('gitleaks', args, { encoding: 'utf8' });
  if (run.status === 0) finish('PASS', NAME, 'gitleaks mode, no leaks found');
  if (run.status === 1) finish('FAIL', NAME, `gitleaks mode, leaks found (output redacted):\n${(run.stdout + run.stderr).trim()}`);
  finish('FAIL', NAME, `gitleaks mode, gitleaks exited ${run.status}: ${(run.stderr || '').trim().slice(0, 300)}`);
}

// Fallback: regexes for the key shapes this stack can leak.
const PATTERNS = [
  { label: 'AWS access key id', re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { label: 'AWS secret access key assignment', re: /aws_secret_access_key\s*[=:]\s*['"]?[A-Za-z0-9/+=]{40}\b/i },
  { label: 'private key block', re: /-----BEGIN (RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY( BLOCK)?-----/ },
  { label: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { label: 'OpenAI key prefix', re: /\bsk-(proj-)?[A-Za-z0-9_-]{20,}/ },
  { label: 'Anthropic key prefix', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { label: 'Supabase secret key', re: /\bsb_secret_[A-Za-z0-9_-]{20,}/ },
  { label: 'GitHub token', re: /\b(ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{20,}\b/ },
  // user:password@host, unless the host is local (docker-compose "postgres", 127.0.0.1) or a
  // documented placeholder, or the password is a <PLACEHOLDER> / ${VAR}.
  { label: 'connection string with password', re: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:(?![<$])[^@\s]+@(?!(127\.0\.0\.1|localhost|example\.invalid|postgres|localstack)\b)[^\s/:]+/i },
  // Resource-shaped AWS hostnames: any RDS instance endpoint, or three or more labels before
  // amazonaws.com (<bucket>.s3.<region>, <id>.execute-api.<region>). Plain service endpoints
  // (bedrock-runtime.us-east-1.amazonaws.com) are not resources. "example" marks a placeholder.
  { label: 'AWS resource hostname', re: /\b(?![a-z0-9.-]*example)([a-z0-9][a-z0-9-]*\.)+rds\.amazonaws\.com\b|\b(?![a-z0-9.-]*example)([a-z0-9][a-z0-9-]*\.){3,}amazonaws\.com\b/i },
];
// 12-digit AWS account ids, outside lockfiles and *.test.* fixtures. 000000000000 is LocalStack's.
const ACCOUNT_ID = [{ label: 'AWS account id', re: /\b(?!0{12}\b)\d{12}\b/ }];
const isLockOrTest = (f) => /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|[^/]*\.lock|[^/]*\.test\.[^/]+)$/.test(f);
const skipDirs = new Set([...SKIP_DIRS, 'coverage']);
const MAX_BYTES = 2 * 1024 * 1024;

const files = walk(repoRoot, { skipDirs }).filter((f) => {
  try {
    return fs.statSync(f).size <= MAX_BYTES;
  } catch {
    return false;
  }
});
if (files.length === 0) finish('SKIP', NAME, 'fallback mode, no files to scan');

const hits = [...scanFiles(files, PATTERNS), ...scanFiles(files.filter((f) => !isLockOrTest(f)), ACCOUNT_ID)];
if (hits.length) finish('FAIL', NAME, `fallback regex mode, possible secrets: ${formatHits(hits)}`);
finish('PASS', NAME, `fallback regex mode (gitleaks not installed), ${files.length} files scanned`);

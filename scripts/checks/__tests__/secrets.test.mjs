import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRepo, removeRepo, runCheck } from './helpers.mjs';

// Fake secrets are assembled from pieces so this test file never contains a key-shaped literal.
const fakeAwsKey = 'AKIA' + 'ZZTESTFAKEKEYAAA';
const fakePrivateKey = ['-----BEGIN ' + 'RSA PRIVATE KEY-----', 'ZZTESTFAKEKEYMATERIALZZTESTFAKEKEYMATERIAL', '-----END ' + 'RSA PRIVATE KEY-----'].join('\n');

test('secrets passes on a tree with placeholders only and reports its mode', () => {
  const root = makeRepo({
    '.env.example': 'DATABASE_URL=postgres://<USER>:<PASSWORD>@example.invalid:5432/codex_health\nAWS_ACCOUNT_ID=<ACCOUNT_ID>\n',
    'README.md': '# fixture\n',
  });
  try {
    const r = runCheck('secrets', root);
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /^PASS secrets: (gitleaks|fallback regex) mode/);
  } finally {
    removeRepo(root);
  }
});

test('secrets fails on an AWS key id and a private key block', () => {
  const root = makeRepo({
    'infra/terraform/envs/dev/leak.tf': `provider "aws" { access_key = "${fakeAwsKey}" }\n`,
    'services/worker/id_rsa': fakePrivateKey + '\n',
  });
  try {
    const r = runCheck('secrets', root);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /^FAIL secrets: (gitleaks|fallback regex) mode/);
  } finally {
    removeRepo(root);
  }
});

// Fallback-only patterns: PATH is emptied so gitleaks (when installed) is not found.
const fallback = (root) => runCheck('secrets', root, { env: { PATH: root } });

test('secrets fallback allows local-only connection strings, LocalStack ids, lockfiles, test fixtures and service endpoints', () => {
  const root = makeRepo({
    '.env.example': 'DATABASE_URL=postgres://codex_app:app-local-only@127.0.0.1:5432/codex_health\nQ=http://127.0.0.1:4566/000000000000/q\n',
    'docker-compose.yml': 'DATABASE_URL: postgres://codex_app:app-local-only@postgres:5432/codex_health\n',
    'package-lock.json': '{"integrity":"sha512-123456789012"}\n',
    'packages/db/test/grants.test.ts': "const fake = '210987654321';\n",
    'infra/terraform/main.tf': 'url = "https://bedrock-runtime.us-east-1.amazonaws.com"\nx = "${var.password}"\ndb = "postgres://u:${var.password}@${var.host}/d"\n',
  });
  try {
    const r = fallback(root);
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /^PASS secrets: fallback regex mode/);
  } finally {
    removeRepo(root);
  }
});

test('secrets fallback fails on a connection string with a password, an AWS account id and an RDS hostname', () => {
  const root = makeRepo({
    'apps/api/src/db.ts': `export const url = '${'postgres'}://app:hunter2@db.internal.example.com:5432/app';\n`,
    'infra/terraform/envs/prod/main.tf': `role_arn = "arn:aws:iam::210987654321:role/x"\nhost = "codex-healthd.cabcdefghijk.us-east-1.rds.${'amazonaws'}.com"\n`,
  });
  try {
    const r = fallback(root);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /^FAIL secrets: fallback regex mode/);
    for (const label of ['connection string with password', 'AWS account id', 'AWS resource hostname']) assert.ok(r.stdout.includes(label), `${label} in ${r.stdout}`);
  } finally {
    removeRepo(root);
  }
});

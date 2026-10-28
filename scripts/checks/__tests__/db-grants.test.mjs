import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, removeRepo, runCheck } from './helpers.mjs';

// A fake psql on PATH keeps the test offline and deterministic. No real database is contacted.
// Contract under test: the SQL files RETURN violation rows (psql exits 0 either way), so any stdout is a FAIL.
const FAKE_URL = 'postgres://zztest:zztest@example.invalid:5432/zztest';
const SQL = {
  'packages/db/sql/checks/rls-enumeration.sql': 'SELECT 1 WHERE false;\n',
  'packages/db/sql/checks/grants.sql': 'SELECT 1 WHERE false;\n',
};

// PATH holds only this bin dir, so psql is exactly what the test puts there (or nothing).
function withFakePsql(root, stdout) {
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  if (stdout !== undefined) {
    fs.writeFileSync(path.join(bin, 'psql'), `#!/bin/sh\n[ "$1" = "--version" ] && exit 0\nprintf '%s' '${stdout}'\nexit 0\n`, { mode: 0o755 });
  }
  return { PATH: bin, DATABASE_URL: FAKE_URL };
}

test('db-grants skips with exit 2 when DATABASE_URL is unset', () => {
  const root = makeRepo(SQL);
  try {
    const r = runCheck('db-grants', root, { env: { DATABASE_URL: '' } });
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stdout, /^SKIP db-grants: DATABASE_URL is unset/);
  } finally {
    removeRepo(root);
  }
});

test('db-grants passes when both SQL checks return no rows', () => {
  const root = makeRepo(SQL);
  try {
    const r = runCheck('db-grants', root, { env: withFakePsql(root, '') });
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /^PASS db-grants: 2 SQL checks returned zero rows via psql/);
  } finally {
    removeRepo(root);
  }
});

test('db-grants fails when a SQL check returns a violation row even though psql exits 0', () => {
  const root = makeRepo(SQL);
  try {
    const r = runCheck('db-grants', root, { env: withFakePsql(root, 'public|referrals|RLS not forced\n') });
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /^FAIL db-grants: packages\/db\/sql\/checks\/rls-enumeration\.sql: violation rows: public\|referrals\|RLS not forced/);
  } finally {
    removeRepo(root);
  }
});

test('db-grants fails, not skips, when DATABASE_URL is set but no runner is available', () => {
  const root = makeRepo(SQL);
  try {
    const r = runCheck('db-grants', root, { env: withFakePsql(root) });
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /^FAIL db-grants: DATABASE_URL is set but neither node_modules\/pg nor psql is available/);
  } finally {
    removeRepo(root);
  }
});

test('db-grants prefers packages/db/check.mjs when pg is installed and fails on its exit 1', () => {
  const root = makeRepo({
    ...SQL,
    'node_modules/pg/package.json': '{"name":"pg"}\n',
    'packages/db/check.mjs': "console.error('FAIL grants.sql'); process.exit(1);\n",
  });
  try {
    const r = runCheck('db-grants', root, { env: withFakePsql(root, '') });
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /^FAIL db-grants: packages\/db\/check\.mjs exited 1: FAIL grants\.sql/);
  } finally {
    removeRepo(root);
  }
});

// CONSTRAINTS: every table with facility_id has FORCE ROW LEVEL SECURITY, and the app role has no
// BYPASSRLS and cannot UPDATE/DELETE audit_log. The SQL lives with the db package; this script only
// runs it. Contract with packages/db (check.mjs): each SQL file RETURNS one row per violation, zero
// rows means pass. A non-zero psql exit (connection or SQL error) is also a FAIL, never a PASS.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { repoRoot, finish } from './lib.mjs';

const NAME = 'db-grants';
const SQL_FILES = ['packages/db/sql/checks/rls-enumeration.sql', 'packages/db/sql/checks/grants.sql'];
const CHECK_MJS = 'packages/db/check.mjs';

const url = process.env.DATABASE_URL;
if (!url) finish('SKIP', NAME, 'DATABASE_URL is unset; set it (CI does) to run the RLS enumeration and grant checks');

const missing = SQL_FILES.filter((f) => !fs.existsSync(path.join(repoRoot, f)));
if (missing.length === SQL_FILES.length) finish('SKIP', NAME, `SQL check files not written yet: ${missing.join(', ')}`);
if (missing.length) finish('FAIL', NAME, `missing SQL check file(s): ${missing.join(', ')}`);

const tail = (run) => (run.error?.message || run.stderr || run.stdout || '').trim().split('\n').slice(-3).join(' ');

// Preferred path: the db package's own runner (same code the db tests use), when pg is installed.
if (fs.existsSync(path.join(repoRoot, CHECK_MJS)) && fs.existsSync(path.join(repoRoot, 'node_modules', 'pg'))) {
  const run = spawnSync(process.execPath, [path.join(repoRoot, CHECK_MJS)], { encoding: 'utf8', env: process.env });
  if (run.error || run.status !== 0) finish('FAIL', NAME, `${CHECK_MJS} exited ${run.status ?? 'with error'}: ${tail(run)}`);
  finish('PASS', NAME, `${SQL_FILES.length} SQL checks returned zero rows via ${CHECK_MJS}`);
}

// Fallback: psql. -tA prints bare rows, so any stdout at all is a violation row.
const probe = spawnSync('psql', ['--version'], { encoding: 'utf8' });
if (probe.error || probe.status !== 0) finish('FAIL', NAME, 'DATABASE_URL is set but neither node_modules/pg nor psql is available');

const failures = [];
for (const file of SQL_FILES) {
  const run = spawnSync('psql', [url, '-X', '-q', '-tA', '-v', 'ON_ERROR_STOP=1', '-f', path.join(repoRoot, file)], { encoding: 'utf8' });
  if (run.error || run.status !== 0) failures.push(`${file}: psql error: ${tail(run)}`);
  else if ((run.stdout || '').trim()) failures.push(`${file}: violation rows: ${run.stdout.trim().split('\n').slice(0, 3).join('; ')}`);
}

if (failures.length) finish('FAIL', NAME, failures.join(' | '));
finish('PASS', NAME, `${SQL_FILES.length} SQL checks returned zero rows via psql`);

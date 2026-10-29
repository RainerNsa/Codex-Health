// Orchestrator for the CONSTRAINTS checks. Runs each check as a subprocess, prints a summary
// table, exits 1 if any check FAILs. SKIP (exit 2) is reported but does not fail the run locally.
// --fast runs the edit-loop subset only. --ci (or CI=true) turns a SKIP from a must-run check into a
// FAIL (CONSTRAINTS.md §3: a skipped gate that looks green is worse than no gate).
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// Fast subset per CONSTRAINTS.md §3 "Fast subset": the greps only; no database, no build.
const FAST = ['secrets', 'bedrock-only', 'prohibited-claims', 'canary-phi', 'legal-basis'];
const ALL = [...FAST, 'web-bundle-hygiene', 'db-grants', 'rules-ci-offline', 'rule-tests'];
// "Must run in CI from M1" rows of CONSTRAINTS.md §3 that can run on every tree today; db-grants joins
// when CI provides a database. canary-phi and web-bundle-hygiene legitimately SKIP until artefacts exist.
const MUST_RUN_IN_CI = ['secrets', 'bedrock-only', 'prohibited-claims', 'legal-basis', 'rule-tests', ...(process.env.DATABASE_URL ? ['db-grants'] : [])];
const STATUS_BY_CODE = { 0: 'PASS', 1: 'FAIL', 2: 'SKIP' };

const fast = process.argv.includes('--fast');
const ci = process.argv.includes('--ci') || process.env.CI === 'true';
const names = fast ? FAST : ALL;
const rows = [];

for (const name of names) {
  const run = spawnSync(process.execPath, [path.join(here, `${name}.mjs`)], { encoding: 'utf8', env: process.env });
  const stdout = (run.stdout || '').trim();
  const line = stdout.split('\n').find((l) => /^(PASS|FAIL|SKIP) /.test(l)) || '';
  let status = STATUS_BY_CODE[run.status] || 'FAIL';
  let detail = line ? line.replace(/^(PASS|FAIL|SKIP) [^:]+: /, '') : `exit ${run.status}; ${(run.stderr || '').trim().split('\n').slice(-1)[0] || 'no output'}`;
  if (ci && status === 'SKIP' && MUST_RUN_IN_CI.includes(name)) {
    status = 'FAIL';
    detail = `SKIP is not allowed in CI for a must-run check: ${detail}`;
  }
  rows.push({ name, status, detail });
}

const width = Math.max(...rows.map((r) => r.name.length));
const mode = [fast && '--fast', ci && '--ci'].filter(Boolean).join(' ');
console.log(`CONSTRAINTS checks${mode ? ` (${mode})` : ''}`);
for (const r of rows) console.log(`  ${r.status}  ${r.name.padEnd(width)}  ${r.detail}`);
const failed = rows.filter((r) => r.status === 'FAIL').length;
const skipped = rows.filter((r) => r.status === 'SKIP').length;
console.log(`${rows.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped`);
process.exit(failed ? 1 : 0);

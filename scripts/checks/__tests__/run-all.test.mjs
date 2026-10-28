import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRepo, removeRepo, runCheck } from './helpers.mjs';

const cleanWeb = { 'apps/web/src/App.tsx': "export const App = () => <main>Admissions review</main>;\n" };
// The fixture trees have no rule examples, so legal-basis SKIPs: non-fatal locally, fatal under --ci.
// CI is pinned per test because GitHub Actions exports CI=true, which would switch the mode on by itself.
const local = { CI: '', DATABASE_URL: '' };

test('run-all --fast runs the edit-loop subset and exits 0 when nothing fails', () => {
  const root = makeRepo(cleanWeb);
  try {
    const r = runCheck('run-all', root, { args: ['--fast'], env: local });
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /CONSTRAINTS checks \(--fast\)/);
    // The fast subset is defined by CONSTRAINTS.md §3 "Fast subset": the greps only.
    for (const name of ['secrets', 'bedrock-only', 'prohibited-claims', 'canary-phi', 'legal-basis']) assert.match(r.stdout, new RegExp(`\\b${name}\\b`));
    assert.doesNotMatch(r.stdout, /web-bundle-hygiene|db-grants|rules-ci-offline/);
    assert.match(r.stdout, /SKIP {2}legal-basis/);
    assert.match(r.stdout, /0 failed/);
  } finally {
    removeRepo(root);
  }
});

test('run-all exits 1 and names the failing check when any check fails', () => {
  const root = makeRepo({ 'apps/web/src/Landing.tsx': "export const claim = 'HIPAA compliant admissions';\n" });
  try {
    const r = runCheck('run-all', root, { env: local });
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /FAIL {2}prohibited-claims/);
    assert.match(r.stdout, /SKIP {2}db-grants/);
    assert.match(r.stdout, /1 failed/);
  } finally {
    removeRepo(root);
  }
});

test('run-all --ci turns a SKIP from a must-run check into a FAIL but leaves the others non-fatal', () => {
  const root = makeRepo(cleanWeb);
  try {
    const r = runCheck('run-all', root, { args: ['--ci'], env: local });
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /CONSTRAINTS checks \(--ci\)/);
    assert.match(r.stdout, /FAIL {2}legal-basis +SKIP is not allowed in CI for a must-run check/);
    assert.match(r.stdout, /SKIP {2}db-grants/); // not must-run without DATABASE_URL
    assert.match(r.stdout, /SKIP {2}canary-phi/); // never must-run: artefacts may not exist yet
  } finally {
    removeRepo(root);
  }
});

test('run-all treats CI=true like --ci', () => {
  const root = makeRepo(cleanWeb);
  try {
    const r = runCheck('run-all', root, { args: ['--fast'], env: { ...local, CI: 'true' } });
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /CONSTRAINTS checks \(--fast --ci\)/);
    assert.match(r.stdout, /FAIL {2}legal-basis/);
  } finally {
    removeRepo(root);
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRepo, removeRepo, runCheck } from './helpers.mjs';

const canaryFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'canary-strings.json');
const { canaries } = JSON.parse(fs.readFileSync(canaryFile, 'utf8'));

test('canary-strings.json holds three unique synthetic identifiers', () => {
  assert.equal(canaries.length, 3);
  assert.deepEqual(canaries.map((c) => c.kind).sort(), ['dob', 'mrn', 'name']);
  assert.equal(new Set(canaries.map((c) => c.value)).size, 3);
  assert.match(canaries.find((c) => c.kind === 'name').value, /ZZTEST/);
});

test('canary-phi passes when logs and artefacts carry no canary', () => {
  const root = makeRepo({
    'services/worker/app.log': 'referral_id=abc123 stage=extract status=ok\n',
    'coverage/lcov.info': 'SF:src/index.ts\nend_of_record\n',
  });
  try {
    const r = runCheck('canary-phi', root);
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /^PASS canary-phi: 2 sink files/);
  } finally {
    removeRepo(root);
  }
});

test('canary-phi fails when a canary lands in a log or local data file', () => {
  const name = canaries.find((c) => c.kind === 'name').value;
  const mrn = canaries.find((c) => c.kind === 'mrn').value;
  const root = makeRepo({
    'worker.log': `extracted text: patient ${name.toLowerCase()} admitted\n`,
    'data/local/out.txt': `mrn ${mrn}\n`,
  });
  try {
    const r = runCheck('canary-phi', root);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /^FAIL canary-phi:.*worker\.log:1 \(canary name\)/);
    assert.match(r.stdout, /data\/local\/out\.txt:1 \(canary mrn\)/);
  } finally {
    removeRepo(root);
  }
});

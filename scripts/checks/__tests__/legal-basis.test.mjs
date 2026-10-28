import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRepo, removeRepo, runCheck } from './helpers.mjs';

const withBasis = { rule_id: 'hard_stop.ventilator', legal_basis: 'Facility is not licensed for ventilator care; ZZTEST state licence placeholder.' };
const withoutBasis = { rule_id: 'hard_stop.zztest' };

test('legal-basis passes when every rule example carries legal_basis', () => {
  const root = makeRepo({
    'packages/schemas/examples/rules/one.json': JSON.stringify(withBasis),
    'packages/schemas/examples/rules/many.json': JSON.stringify([withBasis, { ...withBasis, rule_id: 'payer.zztest' }]),
  });
  try {
    const r = runCheck('legal-basis', root);
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /^PASS legal-basis: 3 rule example\(s\) in 2 file\(s\)/);
  } finally {
    removeRepo(root);
  }
});

test('legal-basis fails when a rule example lacks legal_basis or has it empty', () => {
  const root = makeRepo({
    'packages/schemas/examples/rules/ok.json': JSON.stringify(withBasis),
    'packages/schemas/examples/rules/bad.json': JSON.stringify([withBasis, withoutBasis]),
    'packages/schemas/examples/rules/empty.json': JSON.stringify({ ...withBasis, legal_basis: '  ' }),
  });
  try {
    const r = runCheck('legal-basis', root);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /^FAIL legal-basis:/);
    assert.match(r.stdout, /bad\.json\[1\] \(missing legal_basis\)/);
    assert.match(r.stdout, /empty\.json \(missing legal_basis\)/);
  } finally {
    removeRepo(root);
  }
});

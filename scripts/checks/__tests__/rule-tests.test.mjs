import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRepo, removeRepo, runCheck } from './helpers.mjs';

const cases = [
  { name: 't', facts: { a: 'yes' }, profile: {}, expected: 'true' },
  { name: 'f', facts: { a: 'no' }, profile: {}, expected: 'false' },
  { name: 'u', facts: {}, profile: {}, expected: 'unknown' },
];
const good = { id: 'zztest.review', name: 'ZZTEST', kind: 'review', enabled: true, inputs: ['a'], expression: 'a is yes', sub_reason: 'clinical', tests: cases };
const at = (rules) => makeRepo(Object.fromEntries(rules.map((r, i) => [`packages/schemas/examples/rules/r${i}.json`, JSON.stringify(r)])));

test('rule-tests passes when every rule lints clean and passes its true/false/unknown cases', () => {
  const root = at([good, { ...good, id: 'zztest.hard', kind: 'hard_stop', sub_reason: null }]);
  try {
    const r = runCheck('rule-tests', root);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^PASS rule-tests: 2 rule\(s\), 6 case\(s\), 0 failure\(s\)/);
  } finally { removeRepo(root); }
});

test('rule-tests fails on a wrong case, a missing unknown case, an undeclared input, is unknown in a hard stop, and an unreviewed protected hard stop', () => {
  const bad = [
    { ...good, id: 'zztest.wrong', tests: [...cases.slice(0, 2), { ...cases[2], expected: 'true' }] },
    { ...good, id: 'zztest.nounknown', tests: cases.slice(0, 2) },
    { ...good, id: 'zztest.undeclared', expression: 'b is yes', tests: [] },
    { ...good, id: 'zztest.silence', kind: 'hard_stop', sub_reason: null, expression: 'a is unknown' },
    { ...good, id: 'zztest.protected', kind: 'hard_stop', sub_reason: null, protected_input: true, legal_reviewer: null },
  ];
  for (const rule of bad) {
    const root = at([good, rule]);
    try {
      const r = runCheck('rule-tests', root);
      assert.equal(r.status, 1, `${rule.id}: ${r.stdout}`);
      assert.match(r.stdout, new RegExp(`^FAIL rule-tests: .*${rule.id.replace('.', '\\.')}`), `${rule.id}: ${r.stdout}`);
    } finally { removeRepo(root); }
  }
});

test('rule-tests fails on a file that is not a rule record, and skips when there are no rules', () => {
  const root = makeRepo({ 'packages/schemas/examples/rules/a.json': JSON.stringify(good), 'packages/schemas/examples/rules/b.json': '{}' });
  try {
    const r = runCheck('rule-tests', root);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /not a rule record/);
  } finally { removeRepo(root); }
  const empty = makeRepo({ 'README.md': 'x' });
  try {
    assert.equal(runCheck('rule-tests', empty).status, 2);
  } finally { removeRepo(empty); }
});

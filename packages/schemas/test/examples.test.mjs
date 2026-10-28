import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const ajv = new Ajv2020({ allErrors: true });

// example dir -> schema file
const pairs = {
  facts: 'fact.v0.json',
  profiles: 'facility-profile.v0.json',
  rules: 'rule.v0.json',
};

const validators = {}; // dir -> compiled validator (ajv refuses to compile the same $id twice)

for (const [dir, schemaFile] of Object.entries(pairs)) {
  const validate = ajv.compile(readJson(`${root}schemas/${schemaFile}`));
  validators[dir] = validate;
  const files = readdirSync(`${root}examples/${dir}`).filter((f) => f.endsWith('.json'));
  assert.ok(files.length > 0, `no examples in examples/${dir}`);
  for (const f of files) {
    test(`examples/${dir}/${f} validates against ${schemaFile}`, () => {
      const ok = validate(readJson(`${root}examples/${dir}/${f}`));
      assert.ok(ok, JSON.stringify(validate.errors, null, 2));
    });
  }
}

const ventRule = () => readJson(`${root}examples/rules/seed.hard_stop.ventilator.json`);
const payerRule = () => readJson(`${root}examples/rules/seed.payer.medicaid_pending.json`);
const ventFact = () => readJson(`${root}examples/facts/ventilator_use.json`);

test('rule schema rejects a protected hard stop or payer rule without a structured legal reviewer', () => {
  const validate = validators.rules;
  assert.equal(validate({ ...ventRule(), protected_input: true, legal_reviewer: null }), false);
  assert.equal(validate({ ...payerRule(), legal_reviewer: null }), false);
  assert.equal(validate({ ...payerRule(), legal_reviewer: 'ZZTEST Counsel' }), false, 'a bare string is not a record');
  assert.equal(validate({ ...payerRule(), protected_input: false, legal_reviewer: null }), false, 'a payer rule cannot opt out: payer source is protected');
  const partial = { ...payerRule().legal_reviewer };
  delete partial.memo_ref;
  assert.equal(validate({ ...payerRule(), legal_reviewer: partial }), false, 'reviewer record missing memo_ref');
  assert.equal(validate({ ...payerRule(), legal_reviewer: { ...payerRule().legal_reviewer, firm: '  ' } }), false, 'whitespace firm');
  const favorable = readJson(`${root}examples/rules/seed.favorable.skilled_need_documented.json`);
  assert.equal(validate({ ...favorable, protected_input: true }), false, 'favorable on a protected input without a reviewer');
  assert.equal(validate({ ...favorable, protected_input: true, legal_reviewer: payerRule().legal_reviewer }), true, 'favorable with a reviewer');
  assert.equal(validate({ ...ventRule(), protected_input: true, legal_reviewer: payerRule().legal_reviewer }), true, 'hard stop with a reviewer');
});

test('rule schema keeps test cases tri-state and expected three-valued', () => {
  const validate = validators.rules;
  const rule = ventRule();
  const [first, ...rest] = rule.tests;
  assert.equal(validate({ ...rule, tests: [{ ...first, facts: { ventilator_use: true } }, ...rest] }), false, 'boolean fact in a test case');
  assert.equal(validate({ ...rule, tests: [{ ...first, expected: 'maybe' }, ...rest] }), false, 'expected outside true/false/unknown');
});

test('rule schema requires a true, a false and an unknown test case', () => {
  const validate = validators.rules;
  const rule = ventRule();
  for (const drop of ['true', 'false', 'unknown']) {
    assert.equal(validate({ ...rule, tests: rule.tests.filter((c) => c.expected !== drop) }), false, `no ${drop} case`);
  }
});

test('rule schema ties sub_reason to review rules and department to leadership', () => {
  const validate = validators.rules;
  assert.equal(validate({ ...ventRule(), sub_reason: 'clinical' }), false, 'hard stop with a sub_reason');
  const review = readJson(`${root}examples/rules/seed.review.behavioral_escalation.json`);
  assert.equal(validate({ ...review, sub_reason: null, department: null }), false, 'review rule without a sub_reason');
  assert.equal(validate({ ...review, sub_reason: 'clinical', department: 'director_of_nursing' }), false, 'department without leadership');
  assert.equal(validate({ ...review, department: null }), false, 'leadership without a department');
});

test('fact schema: a known ai value needs evidence; a user fact needs a note and no evidence', () => {
  const validate = validators.facts;
  const fact = ventFact();
  assert.equal(validate({ ...fact, evidence: null }), false, 'ai yes without evidence');
  assert.equal(validate({ ...fact, value: { type: 'tri_state', value: 'unknown' }, evidence: null, confidence_band: null }), true, 'ai unknown without evidence');
  assert.equal(validate({ ...fact, value: { type: 'count', value: null }, evidence: null }), true, 'typed unknown without evidence');
  assert.equal(validate({ ...fact, value: { type: 'tri_state', value: 'unknown' } }), false, 'ai unknown must not carry evidence');
  assert.equal(validate({ ...fact, value: { type: 'count', value: 0 }, evidence: null }), false, 'a known zero is a No and needs evidence');
  assert.equal(validate({ ...fact, value: { type: 'medication_list', value: [] }, evidence: null }), false, 'a known empty list needs evidence');
  assert.equal(validate({ ...fact, evidence: { ...fact.evidence, verified: undefined } }), false, 'evidence without verified');
  assert.equal(validate({ ...fact, evidence: { ...fact.evidence, page: 0 } }), false, 'page 0');
  assert.equal(validate({ ...fact, evidence: { ...fact.evidence, quote: '   ' } }), false, 'whitespace quote');
  assert.equal(validate({ ...fact, source: 'user', evidence: null, confidence_band: null, note: null }), false, 'user fact without a note');
  assert.equal(validate({ ...fact, source: 'user', confidence_band: null, note: 'SYNTHETIC note' }), false, 'user fact with evidence');
  assert.equal(validate({ ...fact, source: 'user', evidence: null, confidence_band: null, note: 'SYNTHETIC note' }), true);
  assert.equal(validate({ ...fact, source: 'user', evidence: null, confidence_band: 'high', note: 'SYNTHETIC note' }), false, 'user fact with a confidence band');
  assert.equal(validate({ ...fact, source: 'user', evidence: null, confidence_band: null, note: '   ' }), false, 'whitespace note');
});

test('fact schema rejects an untagged or mistyped value', () => {
  const validate = validators.facts;
  const fact = ventFact();
  assert.equal(validate({ ...fact, value: 'yes' }), false, 'bare string');
  assert.equal(validate({ ...fact, value: { type: 'count', value: -1 } }), false, 'negative count');
  assert.equal(validate({ ...fact, value: { type: 'tri_state', value: null } }), false, 'null tri-state');
  assert.equal(validate({ ...fact, value: { type: 'date', value: 'yesterday' } }), false, 'non-ISO date');
});

test('every example fact with a quote carries the canary name and MRN (ruling R1)', () => {
  const canaries = readJson(`${root}../../scripts/checks/canary-strings.json`).canaries.filter((c) => c.kind !== 'dob');
  const withQuote = readdirSync(`${root}examples/facts`)
    .filter((f) => f.endsWith('.json'))
    .filter((f) => readJson(`${root}examples/facts/${f}`).evidence !== null);
  assert.ok(withQuote.length > 0);
  for (const f of withQuote) {
    const text = readFileSync(`${root}examples/facts/${f}`, 'utf8').toLowerCase();
    for (const c of canaries) assert.ok(text.includes(c.value.toLowerCase()), `facts/${f} lacks canary ${c.kind}`);
  }
});

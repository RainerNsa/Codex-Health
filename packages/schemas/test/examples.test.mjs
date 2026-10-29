import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
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
// The golden label schema $refs the fact value union by its $id, so the fact schema must be known first.
ajv.addSchema(readJson(`${root}schemas/fact.v0.json`));

for (const [dir, schemaFile] of Object.entries(pairs)) {
  const validate = dir === 'facts' ? ajv.getSchema('urn:codex-health:schema:fact.v0') : ajv.compile(readJson(`${root}schemas/${schemaFile}`));
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

// Golden packets (SPEC §15): examples/golden/<packet_id>/label.json plus pages/<n>.txt reference text.
// The test proves what a label cannot merely claim: canaries in the text, quotes at their spans, negatives
// present on their page or absent from the whole packet, missing keys labelled absent, triggered rules real.
const golden = ajv.compile(readJson(`${root}schemas/golden-packet-label.v0.json`));
const canaries = readJson(`${root}../../scripts/checks/canary-strings.json`).canaries;
const packets = readdirSync(`${root}examples/golden`, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);

function verifyPacket(id, label) {
  const dir = `${root}examples/golden/${id}`;
  assert.ok(golden(label), JSON.stringify(golden.errors, null, 2));
  assert.equal(label.packet_id, id);
  const pageText = (n) => readFileSync(`${dir}/pages/${n}.txt`, 'utf8');
  const allPages = label.documents.flatMap((d) => d.pages);
  assert.equal(new Set(allPages).size, allPages.length, 'a page belongs to one document');
  const text = allPages.map(pageText).join('\n').toLowerCase();
  for (const c of canaries) assert.ok(text.includes(c.value.toLowerCase()), `canary ${c.kind} missing from the reference text`);
  for (const f of label.fields) {
    if (f.quote !== null) {
      assert.ok(allPages.includes(f.page), `${f.key}: page ${f.page} is not in any document`);
      const page = pageText(f.page);
      assert.ok(f.span.end > f.span.start && f.span.end <= page.length, `${f.key}: span is outside the page`);
      assert.equal(page.slice(f.span.start, f.span.end), f.quote, `${f.key}: quote is not the reference text at its span`);
      const doc = label.documents.find((d) => d.document_id === f.document_id);
      assert.ok(doc && doc.pages.includes(f.page), `${f.key}: page ${f.page} is not in document ${f.document_id}`);
    }
    for (const nq of f.negative_quotes) {
      assert.ok(allPages.includes(nq.page), `${f.key}: negative quote names page ${nq.page}, not in any document`);
      if (nq.fabricated) {
        assert.ok(!allPages.some((p) => pageText(p).includes(nq.quote)), `${f.key}: "${nq.quote}" is marked fabricated but is on a page`);
      } else {
        assert.ok(pageText(nq.page).includes(nq.quote), `${f.key}: "${nq.quote}" is not on page ${nq.page}`);
      }
    }
  }
  const keys = label.fields.map((f) => f.key);
  assert.equal(new Set(keys).size, keys.length, 'one label per fact key');
  const absent = label.fields.filter((f) => f.polarity === 'absent').map((f) => f.key).sort();
  assert.deepEqual([...label.expected.missing].sort(), absent, 'expected.missing is exactly the set of absent-labelled keys');
  for (const cf of label.expected.conflicts) {
    for (const v of cf.values) {
      const doc = label.documents.find((d) => d.document_id === v.document_id);
      assert.ok(doc && doc.pages.includes(v.page), `conflict on ${cf.fact_key}: page ${v.page} is not in document ${v.document_id}`);
    }
  }
  for (const r of label.expected.triggered_rules) {
    assert.ok(existsSync(`${root}examples/rules/${r.rule_id}.json`), `rule ${r.rule_id} is not an example rule`);
    for (const k of r.fact_keys) assert.ok(keys.includes(k), `rule ${r.rule_id} reads ${k}, which has no label`);
  }
  for (const f of label.fields) {
    const ref = `${root}examples/facts/${f.key}.json`;
    if (existsSync(ref)) {
      const known = readJson(ref);
      assert.equal(f.is_critical, known.is_critical, `${f.key}: is_critical disagrees with examples/facts`);
      assert.equal(f.specially_protected, known.specially_protected, `${f.key}: specially_protected disagrees with examples/facts`);
    }
  }
}

test('there is at least one golden packet', () => assert.ok(packets.length > 0));
for (const id of packets) {
  test(`examples/golden/${id}: label validates and every claim is backed by the reference text`, () => verifyPacket(id, readJson(`${root}examples/golden/${id}/label.json`)));
}

test('golden packet verification refuses a claim the text cannot back', () => {
  const label = readJson(`${root}examples/golden/eval_vent_0001/label.json`);
  const mutate = (fn) => { const l = structuredClone(label); fn(l); return l; };
  assert.throws(() => verifyPacket('eval_vent_0001', mutate((l) => { l.fields[0].span.start += 1; })), /quote is not the reference text/);
  assert.throws(() => verifyPacket('eval_vent_0001', mutate((l) => { l.fields[0].span.end = 9999; })), /span is outside the page/);
  assert.throws(() => verifyPacket('eval_vent_0001', mutate((l) => { l.fields[0].page = 2; })), /quote is not the reference text|not in document/);
  assert.throws(() => verifyPacket('eval_vent_0001', mutate((l) => { l.fields[0].negative_quotes[0].fabricated = true; })), /marked fabricated but is on a page/);
  assert.throws(() => verifyPacket('eval_vent_0001', mutate((l) => { l.fields[0].negative_quotes[1].fabricated = false; })), /is not on page/);
  assert.throws(() => verifyPacket('eval_vent_0001', mutate((l) => { l.fields[0].negative_quotes[1].page = 99; })), /not in any document/);
  assert.throws(() => verifyPacket('eval_vent_0001', mutate((l) => { l.expected.missing = []; })), /expected.missing is exactly/);
  assert.throws(() => verifyPacket('eval_vent_0001', mutate((l) => { l.expected.missing.push('no_such_key'); })), /expected.missing is exactly/);
  assert.throws(() => verifyPacket('eval_vent_0001', mutate((l) => { l.expected.triggered_rules[0].rule_id = 'seed.hard_stop.no_such_rule'; })), /not an example rule/);
  assert.throws(() => verifyPacket('eval_vent_0001', mutate((l) => { l.fields[0].is_critical = false; })), /is_critical disagrees/);
  assert.equal(golden({ ...label, set: 'case_library' }), false, 'case library needs a case_type');
  assert.equal(golden({ ...label, case_type: 'simple_skilled' }), false, 'extraction eval must not carry one');
  assert.equal(golden({ ...label, fields: [] }), false, 'extraction eval needs per-field labels');
  assert.equal(golden({ ...label, fields: [{ ...label.fields[3], polarity: 'positive' }] }), false, 'an unknown value is absent, never positive');
  assert.equal(golden({ ...label, fields: [{ ...label.fields[0], span: null }] }), false, 'a known value needs a span');
  assert.equal(golden({ ...label, fields: [{ ...label.fields[0], negative_quotes: [{ page: 1, quote: 'x' }] }] }), false, 'a negative quote says whether it is fabricated');
  assert.equal(golden({ ...label, reviewed_by: 'ZZTEST Nurse' }), false, 'reviewer is a role, not a name');
});

// Generative properties (dev-alignment 2.3; CONSTRAINTS I1, I6): random facts × random rule sets within the grammar.
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { evaluate, evaluateRule, lintRule, presence, type Fact, type Rule, type TriState } from '../src/index.ts';

const KEYS = ['a', 'b', 'c', 'd'] as const;
const PKEYS = ['p', 'q'] as const;
const ev = { document_id: 'doc_zztest', page: 1, quote: 'SYNTHETIC', verified: true, span: null, coordinates: null };

// Biased so the Admit path is reachable often enough to be tested (the review found 0 admits in 300 runs
// with uniform generation): mostly known, verified, high-confidence, non-critical facts.
const factArb: fc.Arbitrary<Fact> = fc.record({
  key: fc.constantFrom(...KEYS),
  value: fc.constantFrom<TriState>('yes', 'yes', 'no', 'no', 'no', 'unknown').map((v) => ({ type: 'tri_state' as const, value: v })),
  source: fc.constantFrom<Fact['source']>('ai', 'ai', 'user'),
  verified: fc.constantFrom(true, true, true, false),
  confidence_band: fc.constantFrom<Fact['confidence_band']>('high', 'high', 'medium', 'low', null),
  is_critical: fc.constantFrom(false, false, false, false, false, true),
}).map(({ verified, ...f }): Fact => ({
  ...f,
  evidence: f.source === 'ai' && f.value.value !== 'unknown' ? { ...ev, verified } : null,
  note: f.source === 'user' ? 'SYNTHETIC' : null,
  as_of_date: null, specially_protected: false, single_source: false,
  confidence_band: f.source === 'user' ? null : f.confidence_band,
}));

const condArb = fc.oneof(
  fc.tuple(fc.constantFrom(...KEYS), fc.constantFrom('yes', 'no')).map(([k, v]) => `${k} is ${v}`),
  fc.tuple(fc.constantFrom(...PKEYS), fc.boolean()).map(([k, v]) => `facility.${k} is ${v}`),
);
const exprArb: fc.Arbitrary<string> = fc.letrec((tie) => ({
  expr: fc.oneof({ depthSize: 'small' }, condArb, tie('expr').map((e) => `NOT ${e}`), fc.tuple(tie('expr'), fc.constantFrom('AND', 'OR'), tie('expr')).map(([l, o, r]) => `(${l} ${o} ${r})`)),
})).expr;

let n = 0;
const CASES: Rule['tests'] = [{ name: 't', facts: {}, profile: {}, expected: 'true' }, { name: 'f', facts: {}, profile: {}, expected: 'false' }, { name: 'u', facts: {}, profile: {}, expected: 'unknown' }];
const ruleArb: fc.Arbitrary<Rule> = fc.tuple(fc.constantFrom<Rule['kind']>('hard_stop', 'review', 'favorable', 'favorable', 'payer'), exprArb).map(([kind, expression]) => {
  const inputs = [...new Set(expression.match(/facility\.[a-z]+|\b[abcd]\b/g) ?? [])];
  return { id: `r${(n += 1)}`, kind, enabled: true, inputs, expression, sub_reason: kind === 'review' ? 'clinical' : null, tests: CASES };
});
const profileArb = fc.dictionary(fc.constantFrom(...PKEYS), fc.boolean());
const input = fc.record({ facts: fc.array(factArb, { maxLength: 8 }), rules: fc.array(ruleArb, { maxLength: 6 }), profile: profileArb, flag: fc.boolean(), complete: fc.constantFrom(true, true, true, false) });
type Input = typeof input extends fc.Arbitrary<infer T> ? T : never;

/** An independent view of the inputs: what I1 says must hold, computed from the facts, not from the engine. */
function independent(i: Input) {
  const byKey = new Map<string, Fact[]>();
  for (const f of i.facts) byKey.set(f.key, [...(byKey.get(f.key) ?? []), f]);
  const knownValues = (list: Fact[]) => new Set(list.filter((f) => presence(f) !== 'unknown').map((f) => f.value.value));
  const unknown = (k: string) => { const l = byKey.get(k) ?? []; const v = knownValues(l); return v.size !== 1; };
  const critical = new Set([...i.rules.filter((r) => r.kind === 'hard_stop' || r.kind === 'payer').flatMap((r) => r.inputs.filter((k) => !k.startsWith('facility.'))), ...i.facts.filter((f) => f.is_critical).map((f) => f.key)]);
  const hardInputs = i.rules.filter((r) => r.kind === 'hard_stop').flatMap((r) => r.inputs);
  return { criticalUnknown: [...critical].some(unknown), hardFactUnknown: hardInputs.some((k) => !k.startsWith('facility.') && unknown(k)), hardProfileEmpty: hardInputs.some((k) => k.startsWith('facility.') && typeof i.profile[k.slice(9)] !== 'boolean') };
}
const run = (i: Input) => evaluate({ facts: i.facts, profile: i.profile, rules: i.rules, referral_date: '2001-01-10', processing_complete: i.complete, flags: { favorable_rule_required: i.flag } });

describe('engine properties', () => {
  it('every generated rule parses and lints clean', () => {
    fc.assert(fc.property(ruleArb, (r) => { expect(lintRule(r)).toEqual([]); }));
  });
  it('I1: no Admit while any critical fact is unknown or in conflict, any hard-stop input is unknown or empty, or processing is incomplete (independent view)', () => {
    let admits = 0;
    fc.assert(fc.property(input, (i) => {
      const r = run(i);
      if (r.outcome !== 'admit') return;
      admits += 1;
      const v = independent(i);
      expect(i.complete).toBe(true);
      expect(v.criticalUnknown, 'a critical fact is unknown or conflicting').toBe(false);
      expect(v.hardFactUnknown, 'a hard-stop fact input is unknown').toBe(false);
      expect(v.hardProfileEmpty, 'a hard-stop profile input is empty').toBe(false);
    }), { numRuns: 600 });
    expect(admits, 'the Admit path must be reached often enough to test it').toBeGreaterThan(10);
  });
  it('a stub that admits everything, or refuses everything, is distinguishable: some inputs admit and some do not', () => {
    const outcomes = new Set<string>();
    fc.assert(fc.property(input, (i) => { outcomes.add(run(i).outcome); }), { numRuns: 400 });
    expect([...outcomes].sort()).toEqual(['admit', 'do_not_admit', 'needs_review']);
  });
  it('I1: silence never becomes Do Not Admit — a firing hard stop stays true under EVERY resolution of its unknown inputs (Kleene monotonicity)', () => {
    let fired = 0;
    fc.assert(fc.property(input, (i) => {
      const r = run(i);
      if (r.outcome !== 'do_not_admit') return;
      expect(i.complete).toBe(true);
      const firing = r.trace.filter((t) => t.kind === 'hard_stop' && t.result === 'yes');
      expect(firing.length).toBeGreaterThan(0);
      for (const t of firing) {
        fired += 1;
        const rule = i.rules.find((x) => x.id === t.rule_id)!;
        const unknownFacts = t.inputs.filter((inp) => inp.presence === 'unknown' && !inp.key.startsWith('facility.')).map((inp) => inp.key);
        const unknownProfile = t.inputs.filter((inp) => inp.presence === 'unknown' && inp.key.startsWith('facility.')).map((inp) => inp.key.slice(9));
        const known = i.facts.filter((f) => !unknownFacts.includes(f.key));
        const n = unknownFacts.length + unknownProfile.length;
        for (let mask = 0; mask < 1 << n; mask += 1) {
          const extra: Fact[] = unknownFacts.map((key, j) => ({ key, value: { type: 'tri_state', value: mask & (1 << j) ? 'yes' : 'no' }, source: 'user', evidence: null, note: 'SYNTHETIC', as_of_date: null, is_critical: false, specially_protected: false, single_source: false, confidence_band: null }));
          const profile = { ...i.profile, ...Object.fromEntries(unknownProfile.map((k, j) => [k, Boolean(mask & (1 << (unknownFacts.length + j)))])) };
          expect(evaluateRule(rule, [...known, ...extra], profile, '2001-01-10').result, `${rule.expression} resolved ${mask}`).toBe('yes');
        }
      }
    }), { numRuns: 400 });
    expect(fired).toBeGreaterThan(5);
  });
  it('no Admit on an empty confirmed set, whatever the flag (§13 row 3)', () => {
    fc.assert(fc.property(input, (i) => {
      const r = run({ ...i, facts: i.facts.map((f) => ({ ...f, value: { type: 'tri_state' as const, value: 'unknown' as const }, evidence: null })) });
      expect(r.outcome).not.toBe('admit');
    }));
  });
  it('I6 replay: byte-identical output for the same inputs, in any fact order', () => {
    fc.assert(fc.property(input, (i) => {
      expect(JSON.stringify(run(i))).toBe(JSON.stringify(run({ ...i, facts: [...i.facts].reverse() })));
    }));
  });
  it('a correction that makes a hard stop true flips to Do Not Admit (2.3)', () => {
    const hard: Rule = { id: 'h', kind: 'hard_stop', enabled: true, inputs: ['a'], expression: 'a is yes', sub_reason: null };
    fc.assert(fc.property(input, (i) => {
      const facts = i.facts.filter((f) => f.key !== 'a');
      const corrected: Fact = { key: 'a', value: { type: 'tri_state', value: 'yes' }, source: 'user', evidence: null, note: 'SYNTHETIC correction', as_of_date: null, is_critical: false, specially_protected: false, single_source: false, confidence_band: null };
      const r = evaluate({ facts: [...facts, corrected], profile: i.profile, rules: [hard, ...i.rules], referral_date: '2001-01-10', processing_complete: true, flags: { favorable_rule_required: i.flag } });
      expect(r.outcome).toBe('do_not_admit');
    }));
  });
  it('the trace never carries text: only keys, codes, numbers, tri-states and rule ids', () => {
    fc.assert(fc.property(input, (i) => {
      const s = JSON.stringify(run(i).trace);
      expect(s).not.toContain('SYNTHETIC');
      expect(s).not.toContain('doc_zztest');
    }));
  });
});

// Generative properties (dev-alignment 2.3; CONSTRAINTS I1, I6): random facts × random rule sets within the grammar.
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { evaluate, lintRule, type Fact, type Rule, type TriState } from '../src/index.ts';

const KEYS = ['a', 'b', 'c', 'd'] as const;
const PKEYS = ['p', 'q'] as const;
const ev = { document_id: 'doc_zztest', page: 1, quote: 'SYNTHETIC', verified: true, span: null, coordinates: null };

const factArb: fc.Arbitrary<Fact> = fc.record({
  key: fc.constantFrom(...KEYS),
  value: fc.constantFrom<TriState>('yes', 'no', 'unknown').map((v) => ({ type: 'tri_state' as const, value: v })),
  source: fc.constantFrom<Fact['source']>('ai', 'user'),
  verified: fc.boolean(),
  confidence_band: fc.constantFrom<Fact['confidence_band']>('high', 'medium', 'low', null),
  is_critical: fc.boolean(),
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
const ruleArb: fc.Arbitrary<Rule> = fc.tuple(fc.constantFrom<Rule['kind']>('hard_stop', 'review', 'favorable', 'payer'), exprArb).map(([kind, expression]) => {
  const inputs = [...new Set(expression.match(/facility\.[a-z]+|\b[abcd]\b/g) ?? [])];
  return { id: `r${(n += 1)}`, kind, enabled: true, inputs, expression, sub_reason: kind === 'review' ? 'clinical' : null };
});
const profileArb = fc.dictionary(fc.constantFrom(...PKEYS), fc.boolean());
const input = fc.record({ facts: fc.array(factArb, { maxLength: 8 }), rules: fc.array(ruleArb, { maxLength: 6 }), profile: profileArb, flag: fc.boolean(), complete: fc.boolean() });
const run = (i: typeof input extends fc.Arbitrary<infer T> ? T : never) => evaluate({ facts: i.facts, profile: i.profile, rules: i.rules, referral_date: '2001-01-10', processing_complete: i.complete, flags: { favorable_rule_required: i.flag } });

describe('engine properties', () => {
  it('every generated rule parses and lints clean', () => {
    fc.assert(fc.property(ruleArb, (r) => { expect(lintRule(r)).toEqual([]); }));
  });
  it('I1: no Admit while any critical fact is unknown or in conflict, while any hard-stop input is unknown, or while processing is incomplete', () => {
    fc.assert(fc.property(input, (i) => {
      const r = run(i);
      if (r.outcome !== 'admit') return;
      expect(i.complete).toBe(true);
      expect(r.missing).toEqual([]); // every critical key known (a conflicting critical key is unknown, so it would be listed)
      const critical = new Set([...i.rules.filter((x) => x.kind === 'hard_stop' || x.kind === 'payer').flatMap((x) => x.inputs), ...i.facts.filter((f) => f.is_critical).map((f) => f.key)]);
      for (const k of r.conflicts) expect(critical.has(k), `critical ${k} in conflict`).toBe(false);
      for (const t of r.trace) if (t.kind === 'hard_stop') for (const inp of t.inputs) expect(inp.presence).not.toBe('unknown');
    }));
  });
  it('I1: silence never becomes Do Not Admit — a hard stop only fires on a true result, never on unknown', () => {
    fc.assert(fc.property(input, (i) => {
      const r = run(i);
      if (r.outcome === 'do_not_admit') expect(r.trace.some((t) => t.kind === 'hard_stop' && t.result === 'yes')).toBe(true);
    }));
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

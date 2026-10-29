import { describe, expect, it } from 'vitest';
import { evaluate, runRuleTests, type Fact, type Rule, type EvaluateInput, type RuleTestCase } from '../src/index.ts';

const ev = { document_id: 'doc_zztest', page: 1, quote: 'SYNTHETIC', verified: true, span: null, coordinates: null };
const fact = (key: string, value: Fact['value'], extra: Partial<Fact> = {}): Fact => ({
  key, value, source: 'ai', evidence: ev, note: null, as_of_date: null, is_critical: false, specially_protected: false, single_source: false, confidence_band: 'high', ...extra,
});
const tri = (key: string, v: 'yes' | 'no' | 'unknown', extra: Partial<Fact> = {}) => fact(key, { type: 'tri_state', value: v }, v === 'unknown' ? { evidence: null, ...extra } : extra);
const rule = (id: string, kind: Rule['kind'], expression: string, inputs: string[], extra: Partial<Rule> = {}): Rule => ({ id, kind, enabled: true, inputs, expression, sub_reason: kind === 'review' ? 'clinical' : null, ...extra });

const HARD = rule('hs.vent', 'hard_stop', 'ventilator_use is yes AND facility.accepts_ventilator is false', ['ventilator_use', 'facility.accepts_ventilator']);
const REVIEW = rule('rv.aggr', 'review', 'recent_aggression is yes', ['recent_aggression'], { sub_reason: 'leadership' });
const FAV = rule('fv.skilled', 'favorable', 'daily_skilled_need is yes', ['daily_skilled_need']);
const PAYER = rule('py.pending', 'payer', 'payer_pending is yes', ['payer_pending']);
const RULES = [HARD, REVIEW, FAV, PAYER];
const PROFILE = { accepts_ventilator: false };
const run = (facts: Fact[], over: Partial<EvaluateInput> = {}) => evaluate({ facts, profile: PROFILE, rules: RULES, referral_date: '2001-01-10', processing_complete: true, ...over });

describe('§4 outcome resolution order (table test)', () => {
  const admitSet = [tri('ventilator_use', 'no'), tri('recent_aggression', 'no'), tri('daily_skilled_need', 'yes'), tri('payer_pending', 'no')];
  it('1 processing incomplete wins over everything', () => {
    const r = run([tri('ventilator_use', 'yes'), ...admitSet.slice(1)], { processing_complete: false });
    expect([r.outcome, r.sub_reasons, r.resolution_step]).toEqual(['needs_review', ['processing_incomplete'], 'processing_incomplete']);
  });
  it('2 a true hard stop is Do Not Admit even with a favorable rule true', () => {
    const r = run([tri('ventilator_use', 'yes'), ...admitSet.slice(1)]);
    expect([r.outcome, r.clinical_outcome, r.resolution_step]).toEqual(['do_not_admit', 'do_not_admit', 'hard_stop_true']);
  });
  it('3 an unknown hard-stop input, an unknown critical fact, a conflict, or an empty profile key is Needs Review missing_info', () => {
    expect(run([tri('ventilator_use', 'unknown'), ...admitSet.slice(1)]).resolution_step).toBe('hard_stop_or_critical_unknown');
    expect(run([...admitSet, tri('code_status', 'unknown', { is_critical: true })]).sub_reasons).toEqual(['missing_info']);
    const conflicting = run([tri('ventilator_use', 'no'), tri('ventilator_use', 'yes'), ...admitSet.slice(1)]);
    expect([conflicting.outcome, conflicting.conflicts]).toEqual(['needs_review', ['ventilator_use']]);
    const empty = run(admitSet, { profile: {} });
    expect([empty.outcome, empty.empty_profile_keys]).toEqual(['needs_review', ['accepts_ventilator']]);
  });
  it('4 a true review rule is Needs Review with its sub-reason; a true payer rule adds financial', () => {
    const r = run([tri('recent_aggression', 'yes'), tri('payer_pending', 'yes'), ...admitSet.filter((f) => !['recent_aggression', 'payer_pending'].includes(f.key))]);
    expect([r.outcome, r.sub_reasons.sort(), r.financial_status]).toEqual(['needs_review', ['financial', 'leadership'], 'hold']);
  });
  it('5 Admit only by a true favorable rule when the flag is on', () => {
    const r = run(admitSet);
    expect([r.outcome, r.clinical_outcome, r.financial_status, r.resolution_step]).toEqual(['admit', 'admit', 'clear', 'favorable_rule_true']);
    const noFav = run(admitSet.map((f) => (f.key === 'daily_skilled_need' ? tri('daily_skilled_need', 'no') : f)));
    expect([noFav.outcome, noFav.resolution_step]).toEqual(['needs_review', 'default_needs_review']);
  });
  it('5b with the flag off, Admit needs nothing fired AND a non-empty confirmed set (§13 row 3)', () => {
    const facts = admitSet.map((f) => (f.key === 'daily_skilled_need' ? tri('daily_skilled_need', 'no') : f));
    expect(run(facts, { flags: { favorable_rule_required: false } }).outcome).toBe('admit');
    const allUnknown = admitSet.map((f) => tri(f.key, 'unknown'));
    expect(run(allUnknown, { flags: { favorable_rule_required: false } }).outcome).toBe('needs_review');
    expect(run([], { rules: [], flags: { favorable_rule_required: false } }).outcome).toBe('needs_review');
  });
  it('6 nothing fired is Needs Review missing_info with blocking facts ranked', () => {
    const r = run([tri('ventilator_use', 'no'), tri('recent_aggression', 'no'), tri('payer_pending', 'no')]);
    expect([r.outcome, r.sub_reasons, r.blocking]).toEqual(['needs_review', ['missing_info'], ['daily_skilled_need']]);
  });
});

describe('financial status and the clinical split', () => {
  it('payer unknown blocks the merged outcome but not the clinical one', () => {
    const r = run([tri('ventilator_use', 'no'), tri('recent_aggression', 'no'), tri('daily_skilled_need', 'yes'), tri('payer_pending', 'unknown')]);
    expect([r.outcome, r.clinical_outcome, r.financial_status, r.missing]).toEqual(['needs_review', 'admit', 'unknown', ['payer_pending']]);
  });
});

describe('typed conditions', () => {
  const profile = { ventilator_beds: 2, accepts_ventilator: true };
  it('enum, count, recency and profile counts yield unknown on null and compare otherwise', () => {
    const rules = [
      rule('e', 'review', 'dialysis_schedule is mwf', ['dialysis_schedule']),
      rule('c', 'review', 'iv_days >= 7', ['iv_days']),
      rule('w', 'review', 'recent_aggression within 30 days', ['recent_aggression']),
      rule('p', 'review', 'facility.ventilator_beds > 0', ['facility.ventilator_beds']),
      rule('t', 'review', 'notes is yes', ['notes']),
    ];
    const r = evaluate({ facts: [
      fact('dialysis_schedule', { type: 'enum', value: 'mwf' }), fact('iv_days', { type: 'count', value: 10 }),
      tri('recent_aggression', 'yes', { as_of_date: '2000-12-20' }), fact('notes', { type: 'text', value: 'x' }),
    ], profile, rules, referral_date: '2001-01-10', processing_complete: true });
    expect(Object.fromEntries(r.trace.map((t) => [t.rule_id, t.result]))).toEqual({ e: 'yes', c: 'yes', w: 'yes', p: 'yes', t: 'unknown' });
    expect(r.trace.find((t) => t.rule_id === 'e')?.inputs).toEqual([{ key: 'dialysis_schedule', presence: 'unknown', value: 'mwf' }]);
    expect(r.trace.find((t) => t.rule_id === 'p')?.inputs).toEqual([{ key: 'facility.ventilator_beds', presence: 'yes', value: 2 }]);
    const r2 = evaluate({ facts: [fact('dialysis_schedule', { type: 'enum', value: null }), fact('iv_days', { type: 'count', value: null }), tri('recent_aggression', 'yes', { as_of_date: '2000-11-01' })], profile, rules, referral_date: '2001-01-10', processing_complete: true });
    expect(Object.fromEntries(r2.trace.map((t) => [t.rule_id, t.result]))).toEqual({ e: 'unknown', c: 'unknown', w: 'no', p: 'yes', t: 'unknown' });
    expect(JSON.stringify(r2)).not.toContain('2000-11-01');
  });
  it('a low-confidence or unverified ai fact is unknown to every rule (I2, §3)', () => {
    const r = run([tri('ventilator_use', 'yes', { confidence_band: 'low' }), tri('recent_aggression', 'no'), tri('daily_skilled_need', 'yes'), tri('payer_pending', 'no')]);
    expect(r.resolution_step).toBe('hard_stop_or_critical_unknown');
    const u = run([tri('ventilator_use', 'yes', { evidence: { ...ev, verified: false } }), tri('recent_aggression', 'no'), tri('daily_skilled_need', 'yes'), tri('payer_pending', 'no')]);
    expect(u.resolution_step).toBe('hard_stop_or_critical_unknown');
  });
});

describe('protected inputs and determinism', () => {
  it('refuses a rule set with a hard stop over a protected input and no legal reviewer', () => {
    expect(() => run([], { rules: [rule('x', 'hard_stop', 'psych is yes', ['psych'], { protected_input: true })] })).toThrow(/protected input without a legal_reviewer/);
    expect(() => run([], { rules: [rule('x', 'review', 'psych is yes', ['psych'], { protected_input: true })] })).not.toThrow();
  });
  it('the same inputs give byte-identical output', () => {
    const facts = [tri('ventilator_use', 'no'), tri('recent_aggression', 'no'), tri('daily_skilled_need', 'yes'), tri('payer_pending', 'no')];
    expect(JSON.stringify(run(facts))).toBe(JSON.stringify(run([...facts].reverse())));
  });
  it('disabled rules are ignored', () => {
    expect(run([tri('ventilator_use', 'yes')], { rules: [{ ...HARD, enabled: false }] }).outcome).not.toBe('do_not_admit');
  });
});

describe('runRuleTests', () => {
  it('runs tri-state and typed cases and reports mismatches', () => {
    const cases: RuleTestCase[] = [
      { name: 't', facts: { ventilator_use: 'yes' }, profile: { accepts_ventilator: false }, expected: 'true' },
      { name: 'f', facts: { ventilator_use: 'no' }, profile: { accepts_ventilator: false }, expected: 'false' },
      { name: 'u', facts: {}, profile: { accepts_ventilator: false }, expected: 'unknown' },
      { name: 'wrong', facts: { ventilator_use: 'yes' }, profile: { accepts_ventilator: false }, expected: 'false' },
    ];
    const r: Rule = { ...HARD, tests: cases };
    const typed: Rule = { ...rule('c', 'review', 'iv_days >= 7', ['iv_days']), tests: [{ name: 'typed', facts: { iv_days: { type: 'count', value: 10 } }, profile: {}, expected: 'true' }] };
    expect(runRuleTests([r, typed]).map((x) => [x.name, x.ok])).toEqual([['t', true], ['f', true], ['u', true], ['wrong', false], ['typed', true]]);
  });
});

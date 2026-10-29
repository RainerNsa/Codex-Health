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

describe('Prove-It cases from the reviews', () => {
  it("a non-literal tri-state value ('Yes') is unknown, never a value (I1)", () => {
    const r = run([fact('ventilator_use', { type: 'tri_state', value: 'Yes' as 'yes' }), tri('recent_aggression', 'no'), tri('daily_skilled_need', 'yes'), tri('payer_pending', 'no')]);
    expect([r.outcome, r.resolution_step, r.missing]).toEqual(['needs_review', 'hard_stop_or_critical_unknown', ['ventilator_use']]);
  });
  it('a malformed as_of_date or referral_date makes within unknown, never false', () => {
    const rules = [rule('h', 'hard_stop', 'aggr within 30 days', ['aggr']), FAV];
    const facts = [tri('aggr', 'yes', { as_of_date: '01/05/2001' }), tri('daily_skilled_need', 'yes')];
    expect(evaluate({ facts, profile: {}, rules, referral_date: '2001-01-10', processing_complete: true }).outcome).toBe('needs_review');
    expect(() => evaluate({ facts, profile: {}, rules, referral_date: '2001-13-45', processing_complete: true })).toThrow(/referral_date/);
    expect(() => evaluate({ facts: [tri('bad key', 'yes')], profile: {}, rules, referral_date: '2001-01-10', processing_complete: true })).toThrow(/snake_case/);
  });
  it('a hard stop over a fact flagged specially_protected with no legal reviewer is refused, not decided', () => {
    const rules = [rule('h', 'hard_stop', 'psych is yes', ['psych'])];
    expect(() => evaluate({ facts: [tri('psych', 'yes', { specially_protected: true })], profile: {}, rules, referral_date: '2001-01-10', processing_complete: true })).toThrow(/protected input/);
    const ok = evaluate({ facts: [tri('psych', 'yes', { specially_protected: true })], profile: {}, rules: [rule('h', 'hard_stop', 'psych is yes', ['psych'], { legal_reviewer: { name: 'ZZTEST', firm: 'ZZTEST LLP', date: '2001-01-01', memo_ref: 'M-1' } })], referral_date: '2001-01-10', processing_complete: true });
    expect(ok.outcome).toBe('do_not_admit');
  });
  it('an enum-keyed hard stop whose value is known and false lets the packet reach Admit', () => {
    const rules = [rule('h', 'hard_stop', 'dialysis is mwf', ['dialysis']), FAV];
    const r = evaluate({ facts: [fact('dialysis', { type: 'enum', value: 'tts' }), tri('daily_skilled_need', 'yes')], profile: {}, rules, referral_date: '2001-01-10', processing_complete: true });
    expect([r.outcome, r.missing, r.blocking]).toEqual(['admit', [], []]);
    const u = evaluate({ facts: [fact('dialysis', { type: 'enum', value: null }), tri('daily_skilled_need', 'yes')], profile: {}, rules, referral_date: '2001-01-10', processing_complete: true });
    expect([u.outcome, u.missing]).toEqual(['needs_review', ['dialysis']]);
  });
  it('a profile key that is null or the wrong type is as empty as an absent one', () => {
    const facts = [tri('ventilator_use', 'no'), tri('recent_aggression', 'no'), tri('daily_skilled_need', 'yes'), tri('payer_pending', 'no')];
    const profiles: Record<string, boolean | number>[] = [{}, { accepts_ventilator: null as unknown as boolean }, { accepts_ventilator: 1 }];
    for (const profile of profiles) {
      const r = run(facts, { profile });
      expect([r.outcome, r.empty_profile_keys]).toEqual(['needs_review', ['accepts_ventilator']]);
    }
  });
  it('flag off: a false review rule confirms nothing; merged and clinical never disagree on Admit', () => {
    const a = evaluate({ facts: [tri('a', 'no')], profile: {}, rules: [rule('r', 'review', 'a is yes', ['a'])], referral_date: '2001-01-10', processing_complete: true, flags: { favorable_rule_required: false } });
    expect(a.outcome).toBe('needs_review');
    const b = evaluate({ facts: [tri('a', 'no')], profile: {}, rules: [rule('p', 'payer', 'a is yes', ['a'])], referral_date: '2001-01-10', processing_complete: true, flags: { favorable_rule_required: false } });
    expect([b.outcome, b.clinical_outcome]).toEqual(['needs_review', 'needs_review']);
  });
  it('a profile-only favorable rule admits nothing, whatever the flag', () => {
    for (const flag of [true, false]) {
      const r = evaluate({ facts: [], profile: { q: false }, rules: [rule('f', 'favorable', 'facility.q is false', ['facility.q'])], referral_date: '2001-01-10', processing_complete: true, flags: { favorable_rule_required: flag } });
      expect(r.outcome).toBe('needs_review');
    }
  });
  it('lineage that is not a disagreement is not a conflict: a timeline, a confirmation, an option list', () => {
    const base = [tri('recent_aggression', 'no'), tri('daily_skilled_need', 'yes'), tri('payer_pending', 'no')];
    expect(run([tri('ventilator_use', 'no', { as_of_date: '2001-01-01' }), tri('ventilator_use', 'no', { as_of_date: '2001-01-05' }), ...base]).outcome).toBe('admit');
    expect(run([tri('ventilator_use', 'no', { source: 'user', evidence: null, note: 'SYNTHETIC', confidence_band: null }), tri('ventilator_use', 'no', { confidence_band: 'low' }), ...base]).outcome).toBe('admit');
    expect(run([tri('ventilator_use', 'no'), tri('ventilator_use', 'unknown'), ...base]).conflicts).toEqual([]);
    expect(run([tri('ventilator_use', 'no'), tri('ventilator_use', 'yes'), ...base]).conflicts).toEqual(['ventilator_use']);
  });
  it('the trace, missing and blocking never carry free text', () => {
    const rules = [rule('e', 'review', 'dialysis is mwf', ['dialysis']), rule('c', 'review', 'cnt >= 1', ['cnt'])];
    const r = evaluate({ facts: [fact('dialysis', { type: 'enum', value: 'Mon Wed Fri per Dr ZZTEST' }), fact('cnt', { type: 'count', value: 'see note' as unknown as number })], profile: {}, rules, referral_date: '2001-01-10', processing_complete: true });
    expect(JSON.stringify(r)).not.toMatch(/ZZTEST|see note/);
  });
  it('an is_critical fact read only by a payer rule still blocks the clinical answer (2.4: the flag only adds)', () => {
    const r = evaluate({ facts: [tri('pay', 'unknown', { is_critical: true }), tri('daily_skilled_need', 'yes')], profile: {}, rules: [PAYER.id === 'py.pending' ? rule('p', 'payer', 'pay is yes', ['pay']) : PAYER, FAV], referral_date: '2001-01-10', processing_complete: true });
    expect([r.outcome, r.clinical_outcome]).toEqual(['needs_review', 'needs_review']);
  });
  it('blocking is ranked by reads, empty when another reason stands, and never names profile keys', () => {
    const rules = [rule('h1', 'hard_stop', 'x is yes AND facility.k is true', ['x', 'facility.k']), rule('h2', 'hard_stop', 'x is yes OR y is yes', ['x', 'y']), FAV];
    const r = evaluate({ facts: [tri('daily_skilled_need', 'yes')], profile: {}, rules, referral_date: '2001-01-10', processing_complete: true });
    expect(r.blocking).toEqual(['x', 'y']);
    const withReview = evaluate({ facts: [tri('daily_skilled_need', 'yes'), tri('b', 'yes')], profile: { k: true }, rules: [...rules, rule('rv', 'review', 'b is yes', ['b'])], referral_date: '2001-01-10', processing_complete: true });
    expect(withReview.blocking).toEqual([]);
  });
  it('step 4 does not fire on an unknown review rule; step 5 confirmation needs a known fact input', () => {
    const r = evaluate({ facts: [tri('daily_skilled_need', 'yes')], profile: {}, rules: [rule('rv', 'review', 'b is yes', ['b']), FAV], referral_date: '2001-01-10', processing_complete: true });
    expect([r.outcome, r.resolution_step]).toEqual(['admit', 'favorable_rule_true']);
    const p = evaluate({ facts: [], profile: { p: false }, rules: [rule('rv', 'review', 'facility.p is true', ['facility.p'])], referral_date: '2001-01-10', processing_complete: true, flags: { favorable_rule_required: false } });
    expect(p.outcome).toBe('needs_review');
  });
  it('is unknown yields true or false, never unknown, and only in review rules', () => {
    const rules = [rule('rv', 'review', 'b is unknown', ['b'])];
    expect(evaluate({ facts: [], profile: {}, rules, referral_date: '2001-01-10', processing_complete: true }).trace[0]?.result).toBe('yes');
    expect(evaluate({ facts: [tri('b', 'no')], profile: {}, rules, referral_date: '2001-01-10', processing_complete: true }).trace[0]?.result).toBe('no');
  });
  it('within boundaries: 0 and N days inclusive, N+1 and a future as_of are no, null or unknown presence is unknown', () => {
    const rules = [rule('w', 'review', 'a within 30 days', ['a'])];
    const at = (as_of_date: string | null, v: 'yes' | 'unknown' = 'yes') => evaluate({ facts: [tri('a', v, { as_of_date })], profile: {}, rules, referral_date: '2001-01-31', processing_complete: true }).trace[0]?.result;
    expect([at('2001-01-31'), at('2001-01-01'), at('2000-12-31'), at('2001-02-01'), at(null), at('2001-01-20', 'unknown')]).toEqual(['yes', 'yes', 'no', 'no', 'unknown', 'unknown']);
  });
  it('every comparison operator at the boundary, and wrong types are unknown', () => {
    const cmp = (expr: string, value: Fact['value']) => evaluate({ facts: [fact('n', value)], profile: { b: true, c: 3 }, rules: [rule('c', 'review', expr, ['n'])], referral_date: '2001-01-10', processing_complete: true }).trace[0]?.result;
    const seven = { type: 'count' as const, value: 7 };
    expect(['n = 7', 'n != 7', 'n < 7', 'n <= 7', 'n > 7', 'n >= 7'].map((e) => cmp(e, seven))).toEqual(['yes', 'no', 'no', 'yes', 'no', 'yes']);
    expect(cmp('n is mwf', seven)).toBe('unknown');
    expect(cmp('n >= 1', { type: 'enum', value: 'mwf' })).toBe('unknown');
    const prof = (expr: string, key: string) => evaluate({ facts: [], profile: { b: true, c: 3 }, rules: [rule('p', 'review', expr, [key])], referral_date: '2001-01-10', processing_complete: true });
    expect([prof('facility.b > 0', 'facility.b').trace[0]?.result, prof('facility.c is true', 'facility.c').trace[0]?.result]).toEqual(['unknown', 'unknown']);
    expect(prof('facility.b > 0', 'facility.b').empty_profile_keys).toEqual(['b']);
  });
});

describe('financial status and the clinical split', () => {
  it('a true payer rule holds the merged outcome and the financial status while the clinical answer admits', () => {
    const r = run([tri('ventilator_use', 'no'), tri('recent_aggression', 'no'), tri('daily_skilled_need', 'yes'), tri('payer_pending', 'yes')]);
    expect([r.outcome, r.sub_reasons, r.clinical_outcome, r.financial_status]).toEqual(['needs_review', ['financial'], 'admit', 'hold']);
  });
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
    // for enum/date/text inputs `presence` reports known-ness (a non-null value), not the §8 presence
    expect(r.trace.find((t) => t.rule_id === 'e')?.inputs).toEqual([{ key: 'dialysis_schedule', presence: 'yes', value: 'mwf' }]);
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
    const recency: Rule = { ...rule('w', 'review', 'a within 30 days', ['a']), tests: [{ name: 'recent', facts: { a: { value: 'yes', as_of_date: '2000-12-20' } }, profile: {}, expected: 'true' }] };
    expect(runRuleTests([r, typed, recency]).map((x) => [x.name, x.ok])).toEqual([['t', true], ['f', true], ['u', true], ['wrong', false], ['typed', true], ['recent', true]]);
  });
});

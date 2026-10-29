import { describe, expect, it } from 'vitest';
import { parseExpression, referencedKeys, lintRule, usesIsUnknown, DslError } from '../src/index.ts';

describe('parseExpression', () => {
  it('parses the seed expressions and precedence (NOT > AND > OR, parentheses)', () => {
    expect(parseExpression('ventilator_use is yes AND facility.accepts_ventilator is false')).toEqual({
      op: 'and', left: { op: 'fact_is', key: 'ventilator_use', value: 'yes' }, right: { op: 'profile_is', key: 'accepts_ventilator', value: false },
    });
    expect(parseExpression('a is yes OR b is no AND NOT c is yes')).toEqual({
      op: 'or', left: { op: 'fact_is', key: 'a', value: 'yes' },
      right: { op: 'and', left: { op: 'fact_is', key: 'b', value: 'no' }, right: { op: 'not', expr: { op: 'fact_is', key: 'c', value: 'yes' } } },
    });
    expect(parseExpression('(a is yes OR b is no) AND c is unknown')).toEqual({
      op: 'and', left: { op: 'or', left: { op: 'fact_is', key: 'a', value: 'yes' }, right: { op: 'fact_is', key: 'b', value: 'no' } }, right: { op: 'fact_is', key: 'c', value: 'unknown' },
    });
    expect(parseExpression('NOT a is yes AND b is no')).toEqual({
      op: 'and', left: { op: 'not', expr: { op: 'fact_is', key: 'a', value: 'yes' } }, right: { op: 'fact_is', key: 'b', value: 'no' },
    });
    expect(parseExpression('dialysis_schedule is mwf')).toEqual({ op: 'fact_is_code', key: 'dialysis_schedule', code: 'mwf' });
    expect(parseExpression('iv_antibiotic_days_remaining >= 7')).toEqual({ op: 'fact_cmp', key: 'iv_antibiotic_days_remaining', cmp: '>=', number: 7 });
    expect(parseExpression('recent_aggression within 30 days')).toEqual({ op: 'fact_within', key: 'recent_aggression', days: 30 });
    expect(parseExpression('facility.ventilator_beds > 0')).toEqual({ op: 'profile_cmp', key: 'ventilator_beds', cmp: '>', number: 0 });
  });

  it('rejects what the grammar does not admit', () => {
    for (const bad of ['', 'a is', 'a == 1', 'is is yes', 'yes is yes', 'days within 3 days', `${'('.repeat(65)}a is yes${')'.repeat(65)}`, 'facility.x is yes', 'facility.x', 'a within days', 'a within 3 day', 'a AND', '(a is yes', 'a is yes )', 'A is yes', 'a is yes and b is no', 'eval(1)', 'a is yes; drop', 'a is 3']) {
      expect(() => parseExpression(bad), bad).toThrow(DslError);
    }
  });

  it('lists referenced keys and detects is unknown', () => {
    expect(referencedKeys(parseExpression('a is yes AND (facility.k is true OR a is no)'))).toEqual(['a', 'facility.k']);
    expect(usesIsUnknown(parseExpression('a is yes AND b is unknown'))).toBe(true);
    expect(usesIsUnknown(parseExpression('a is yes'))).toBe(false);
  });
});

describe('lintRule (rule CI static checks)', () => {
  const base = { id: 'r', kind: 'review' as const, inputs: ['a'], expression: 'a is yes', tests: [{ expected: 'true' }, { expected: 'false' }, { expected: 'unknown' }] };
  it('passes a clean rule and names each problem', () => {
    expect(lintRule(base)).toEqual([]);
    expect(lintRule({ ...base, expression: 'b is yes' })).toEqual(["r: reads 'b' which is not declared in inputs", "r: declares input 'a' which the expression never reads"]);
    expect(lintRule({ ...base, expression: 'a is' })[0]).toMatch(/^r: /);
    for (const kind of ['hard_stop', 'favorable', 'payer'] as const) {
      expect(lintRule({ ...base, kind, expression: 'a is unknown' })).toEqual([`r: 'is unknown' is permitted only in review rules (a ${kind} rule firing on silence would decide on Unknown)`]);
    }
    expect(lintRule({ ...base, kind: 'review', expression: 'a is unknown' })).toEqual([]);
    expect(lintRule({ ...base, kind: 'hard_stop', protected_input: true })).toEqual(['r: a hard_stop rule over a protected input needs a legal_reviewer record']);
    expect(lintRule({ ...base, kind: 'favorable', protected_input: true, legal_reviewer: { name: 'x' } })).toEqual(['r: a favorable rule over a protected input needs a legal_reviewer record']);
    expect(lintRule({ ...base, kind: 'favorable', protected_input: true, legal_reviewer: [] })).toHaveLength(1);
    expect(lintRule({ ...base, kind: 'favorable', protected_input: true, legal_reviewer: { name: 'ZZTEST', firm: 'ZZTEST LLP', date: '2001-01-01', memo_ref: 'M-1' } })).toEqual([]);
    expect(lintRule({ ...base, kind: 'favorable', protected_input: true, legal_reviewer: { name: 'ZZTEST', firm: 'ZZTEST LLP', date: 'yesterday', memo_ref: 'M-1' } })).toHaveLength(1);
  });
  it('requires a true, a false and an unknown case per rule (CONSTRAINTS §4.2)', () => {
    const cases = (...e: string[]) => e.map((expected) => ({ expected }));
    expect(lintRule({ ...base, tests: cases('true', 'false', 'unknown') })).toEqual([]);
    expect(lintRule({ ...base, tests: cases('true', 'true') })).toEqual(["r: no test case with expected 'false'", "r: no test case with expected 'unknown'"]);
  });
});

// buildRuleSet is pure: the form's keys, the critical set and the R7 checklist come only from enabled rules.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Rule } from '@codex-health/rules-engine';
import { buildRuleSet, RuleSetRefused } from '../src/ruleset.ts';

const EXAMPLES = fileURLToPath(new URL('../../../packages/schemas/examples/', import.meta.url));
const SEED: Rule[] = readdirSync(`${EXAMPLES}rules`).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(`${EXAMPLES}rules/${f}`, 'utf8')));
const base = { ruleSetVersion: 1, criteriaRef: 'zz', capabilities: {}, profileVersion: 1 };
const rule = (id: string, expression: string, inputs: string[]): Rule => ({ id, name: 'ZZTEST', kind: 'review', enabled: true, inputs, expression, sub_reason: 'clinical', tests: [{ name: 't', facts: {}, profile: {}, expected: 'true' }, { name: 'f', facts: {}, profile: {}, expected: 'false' }, { name: 'u', facts: {}, profile: {}, expected: 'unknown' }] } as unknown as Rule);

describe('buildRuleSet', () => {
  it('refuses a rule set that reads one fact two ways', () => {
    expect(() => buildRuleSet({ ...base, rules: [rule('zz.a', 'x is yes', ['x']), rule('zz.b', 'x >= 3', ['x'])], disabledRules: [] })).toThrow(/read as both tri_state and count/);
  });
  it('refuses, as RuleSetRefused, what the engine would refuse at evaluation time', () => {
    const bad = [
      [rule('zz.a', 'x is is yes', ['x'])],
      [rule('zz.a', 'x is yes', ['x']), rule('zz.a', 'x is no', ['x'])],
      [{ ...rule('zz.a', 'x is unknown', ['x']), kind: 'hard_stop' } as Rule],
      'not a list' as unknown as Rule[],
    ];
    for (const rules of bad) expect(() => buildRuleSet({ ...base, rules, disabledRules: [] }), JSON.stringify(rules)).toThrow(RuleSetRefused);
  });
  it('a switched-off rule leaves the form, the critical set and the completeness checklist', () => {
    const all = buildRuleSet({ ...base, rules: SEED, disabledRules: [] });
    expect(all.completeness).toEqual({ required_keys: ['accepts_ventilator'], missing_keys: ['accepts_ventilator'] });
    expect(all.factKeys.map((k) => k.key)).toContain('ventilator_use');
    const off = buildRuleSet({ ...base, rules: SEED, disabledRules: ['seed.hard_stop.ventilator'] });
    expect(off.completeness).toEqual({ required_keys: [], missing_keys: [] });
    expect(off.factKeys.map((k) => k.key)).not.toContain('ventilator_use');
    expect(off.critical.has('ventilator_use')).toBe(false);
    expect(off.rules.find((r) => r.id === 'seed.hard_stop.ventilator')?.enabled).toBe(false);
    expect(off.baseDisabled.size).toBe(SEED.filter((r) => !r.enabled).length);
  });
});

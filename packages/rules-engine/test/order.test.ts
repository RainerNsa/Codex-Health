import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { OUTCOME_RESOLUTION_ORDER, presence, type Fact, type FactValue, type TriState } from '../src/index.ts';

describe('OUTCOME_RESOLUTION_ORDER', () => {
  it('has the six steps in the specified order', () => {
    expect([...OUTCOME_RESOLUTION_ORDER]).toEqual([
      'processing_incomplete',
      'hard_stop_true',
      'hard_stop_or_critical_unknown',
      'review_rule_true',
      'favorable_rule_true',
      'default_needs_review',
    ]);
  });
});

describe('cli', () => {
  it('prints usage and exits 2', () => {
    const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
    const r = spawnSync(process.execPath, [cli], { encoding: 'utf8', timeout: 30_000 });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('evaluate <facts.json> <profile.json> <rules.json>');
  });
});

describe('presence(): the tri-state a hard-stop rule reads from a typed value', () => {
  const verified: Fact['evidence'] = { document_id: 'doc_zztest', page: 1, quote: 'SYNTHETIC', verified: true, span: null, coordinates: null };
  const ai = (value: FactValue, evidence: Fact['evidence'] = verified, confidence_band: Fact['confidence_band'] = 'high') =>
    presence({ value, source: 'ai', evidence, confidence_band });
  const user = (value: FactValue) => presence({ value, source: 'user', evidence: null, confidence_band: null });
  const med = { name: 'SYNTHETIC-DRUG-A', route: 'iv', frequency: 'q8h', duration_days: 10 };

  it('passes a tri-state through unchanged', () => {
    for (const v of ['yes', 'no', 'unknown'] as const) expect(ai({ type: 'tri_state', value: v })).toBe(v);
  });

  it('maps null to unknown for every typed value', () => {
    expect(ai({ type: 'count', value: null })).toBe('unknown');
    expect(ai({ type: 'medication_list', value: null })).toBe('unknown');
    expect(ai({ type: 'date', value: null })).toBe('unknown');
    expect(ai({ type: 'enum', value: null })).toBe('unknown');
    expect(ai({ type: 'text', value: null })).toBe('unknown');
  });

  it('maps zero and empty to no, other known counts and lists to yes', () => {
    expect(ai({ type: 'count', value: 0 })).toBe('no');
    expect(ai({ type: 'count', value: 3 })).toBe('yes');
    expect(ai({ type: 'medication_list', value: [] })).toBe('no');
    expect(ai({ type: 'medication_list', value: [med] })).toBe('yes');
  });

  it('has no presence for enum, date and text until the DSL compares values (shortcut)', () => {
    expect(ai({ type: 'enum', value: 'none' })).toBe('unknown');
    expect(ai({ type: 'date', value: '2001-01-01' })).toBe('unknown');
    expect(ai({ type: 'text', value: 'x' })).toBe('unknown');
    expect(user({ type: 'enum', value: 'mwf' })).toBe('unknown');
  });

  it('treats an ai fact with missing, unverified or low-confidence evidence as unknown (I2, §3), but not a user fact', () => {
    expect(ai({ type: 'tri_state', value: 'yes' }, null)).toBe('unknown');
    expect(ai({ type: 'tri_state', value: 'no' }, { ...verified, verified: false })).toBe('unknown');
    expect(ai({ type: 'tri_state', value: 'yes' }, verified, 'low')).toBe('unknown');
    expect(ai({ type: 'tri_state', value: 'yes' }, verified, 'medium')).toBe('yes');
    expect(user({ type: 'tri_state', value: 'no' })).toBe('no');
    expect(user({ type: 'count', value: 2 })).toBe('yes');
  });

  it('holds any source that is not literally user to the ai rules, and any unknown type to unknown', () => {
    expect(presence({ value: { type: 'tri_state', value: 'yes' }, source: 'AI' as Fact['source'], evidence: null, confidence_band: null })).toBe('unknown');
    expect(presence({ value: { type: 'bogus' } as unknown as FactValue, source: 'user', evidence: null, confidence_band: null })).toBe('unknown');
  });

  it('property: never promotes unknown, never degrades a known tri-state/count/list from a user or verified ai source', () => {
    const value: fc.Arbitrary<FactValue> = fc.oneof(
      fc.record({ type: fc.constant('tri_state' as const), value: fc.constantFrom<TriState>('yes', 'no', 'unknown') }),
      fc.record({ type: fc.constant('count' as const), value: fc.option(fc.nat(), { nil: null }) }),
      fc.record({ type: fc.constant('date' as const), value: fc.option(fc.constant('2001-01-01'), { nil: null }) }),
      fc.record({ type: fc.constant('enum' as const), value: fc.option(fc.constantFrom('mwf', 'none'), { nil: null }) }),
      fc.record({ type: fc.constant('text' as const), value: fc.option(fc.string({ minLength: 1 }), { nil: null }) }),
      fc.record({ type: fc.constant('medication_list' as const), value: fc.option(fc.array(fc.constant(med), { maxLength: 3 }), { nil: null }) }),
    );
    const band = fc.constantFrom<Fact['confidence_band']>('high', 'medium', 'low', null);
    fc.assert(fc.property(value, fc.constantFrom<Fact['source']>('ai', 'user'), fc.boolean(), band, (v, source, isVerified, b) => {
      const evidence = source === 'ai' ? { ...verified, verified: isVerified } : null;
      const out = presence({ value: v, source, evidence, confidence_band: source === 'ai' ? b : null });
      const isUnknown = v.type === 'tri_state' ? v.value === 'unknown' : v.value === null;
      const noPresence = v.type === 'enum' || v.type === 'date' || v.type === 'text';
      const trusted = source === 'user' || (isVerified && b !== 'low');
      if (isUnknown || noPresence || !trusted) expect(out).toBe('unknown');
      else if (v.type === 'tri_state') expect(out).toBe(v.value);
      else if (v.type === 'count') expect(out).toBe(v.value === 0 ? 'no' : 'yes');
      else expect(out).toBe(v.value!.length === 0 ? 'no' : 'yes');
    }));
  });
});

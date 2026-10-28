import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { OUTCOME_RESOLUTION_ORDER, type TriState } from '../src/index.ts';

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

describe('property runner (fast-check smoke)', () => {
  it('a TriState is always one of three values', () => {
    const triState = fc.constantFrom<TriState>('yes', 'no', 'unknown');
    fc.assert(fc.property(triState, (v) => ['yes', 'no', 'unknown'].includes(v)));
  });
});

describe('cli', () => {
  it('prints usage and exits 2', () => {
    const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
    const r = spawnSync(process.execPath, [cli], { encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('evaluate <facts.json> <profile.json> <rules.json>');
  });
});

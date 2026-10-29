import { describe, expect, it } from 'vitest';
import { and, or, not } from '../src/index.ts';

// The full three-valued tables (SPEC §3, §10.2). unknown never collapses.
describe('Kleene connectives', () => {
  it('AND', () => {
    expect([
      and('yes', 'yes'), and('yes', 'no'), and('yes', 'unknown'),
      and('no', 'yes'), and('no', 'no'), and('no', 'unknown'),
      and('unknown', 'yes'), and('unknown', 'no'), and('unknown', 'unknown'),
    ]).toEqual(['yes', 'no', 'unknown', 'no', 'no', 'no', 'unknown', 'no', 'unknown']);
  });
  it('OR', () => {
    expect([
      or('yes', 'yes'), or('yes', 'no'), or('yes', 'unknown'),
      or('no', 'yes'), or('no', 'no'), or('no', 'unknown'),
      or('unknown', 'yes'), or('unknown', 'no'), or('unknown', 'unknown'),
    ]).toEqual(['yes', 'yes', 'yes', 'yes', 'no', 'unknown', 'yes', 'unknown', 'unknown']);
  });
  it('NOT', () => {
    expect([not('yes'), not('no'), not('unknown')]).toEqual(['no', 'yes', 'unknown']);
  });
});

import { expect, it } from 'vitest';
import { actorLabel, chainText } from './AuditPanel.tsx';

it('actorLabel names staff, and says what a system identity is', () => {
  const e = { seq: 1, at: '', action: 'referral.created', entity_type: 'referral', entity_id: null };
  expect(actorLabel({ ...e, actor: 'user:zz', actor_name: 'ZZTEST Admin' })).toBe('ZZTEST Admin');
  expect(actorLabel({ ...e, actor: 'user:zz', actor_name: null })).toBe('unknown user');
  expect(actorLabel({ ...e, actor: 'worker:job-1', actor_name: null })).toBe('document reader');
  expect(actorLabel({ ...e, actor: 'platform:seed', actor_name: null })).toBe('system (platform)');
});

it('chainText reports what the check shows and no more, which entries broke, and flags a capped list', () => {
  expect(chainText({ checked: 0, broken: [] })).toBe('Nothing has been recorded at this facility yet.');
  expect(chainText({ checked: 3, broken: [] })).toBe('No inconsistencies found in 3 entries: each matches its recorded hash and follows the one before.');
  expect(chainText({ checked: 9, broken: [4] })).toContain('1 of 9 entries no longer match what was written (entries 4)');
  expect(chainText({ checked: 99, broken: Array.from({ length: 50 }, (_, i) => i + 1) })).toContain('at least 50 of 99');
});

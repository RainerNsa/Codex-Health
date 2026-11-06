import { expect, it } from 'vitest';
import { age, reasonCounts } from './QueuePanel.tsx';
import type { QueueRow } from './api.ts';

it('age reads at the grain a queue needs, and never goes negative', () => {
  const now = Date.parse('2026-10-30T12:00:00Z');
  const ago = (ms: number) => new Date(now - ms).toISOString();
  expect([age(ago(10_000), now), age(ago(-60_000), now), age(ago(59 * 60_000), now), age(ago(60 * 60_000), now), age(ago(47 * 3600_000), now), age(ago(49 * 3600_000), now)])
    .toEqual(['under a minute', 'under a minute', '59 min', '1 h', '47 h', '2 days']);
});

it('reasonCounts groups Needs Review referrals by reason, most common first, and ignores other outcomes', () => {
  const row = (outcome: QueueRow['outcome'], sub_reasons: string[] | null) => ({ id: 'x', status: 'ready_for_review', referral_type: 'standard', created_at: '', updated_at: '', outcome, raw: false, sub_reasons, documents: 0, failed_documents: 0, cosign_waiting: false });
  expect(reasonCounts([row('needs_review', ['missing_info', 'clinical']), row('needs_review', ['missing_info']), row('do_not_admit', ['clinical']), row('needs_review', null), row(null, null)]))
    .toEqual([['missing_info', 2], ['clinical', 1]]);
});

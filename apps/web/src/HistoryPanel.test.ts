import { expect, it } from 'vitest';
import type { CriteriaVersion, HistoryRow } from './api.ts';
import { changeSummary } from './CriteriaPanel.tsx';
import { decisionFlags } from './HistoryPanel.tsx';
import { groupCounts } from './DashboardPanel.tsx';
import { duration } from './QueuePanel.tsx';

it('decisionFlags names an amendment, a hard-stop override before a plain one, and the co-signer', () => {
  const d: HistoryRow = { id: 'd', referral_id: 'r', decided_at: '', decision: 'admit', recommended_outcome: 'do_not_admit', override: true, hard_stop_override: true, amendment: true, cosigned: true, decided_by_name: 'ZZTEST Reviewer', cosigned_by_name: 'ZZTEST Admin', rule_set_version: 1 };
  expect(decisionFlags(d)).toEqual(['Amendment', 'Hard stop overridden', 'Co-signed by ZZTEST Admin']);
  expect(decisionFlags({ ...d, hard_stop_override: false, amendment: false, cosigned: false })).toEqual(['Differs from recommendation']);
  expect(decisionFlags({ ...d, override: false, hard_stop_override: false, amendment: false, cosigned: false })).toEqual([]);
});

it('changeSummary reads a version against the one before, by rule name', () => {
  const v: CriteriaVersion = { version: 2, criteria_document_ref: 'zz', created_at: '', created_by_name: null, rules: [{ id: 'a', name: 'Rule A', kind: 'review', enabled: true }, { id: 'b', name: 'Rule B', kind: 'hard_stop', enabled: true }], added: ['b'], removed: ['c'], changed: ['a'], decisions: 0 };
  expect(changeSummary(v, false)).toBe('Added: Rule B. Changed: Rule A. Removed: c.');
  expect(changeSummary(v, true)).toBe('First version: 2 rules.');
  expect(changeSummary({ ...v, added: [], removed: [], changed: [] }, false)).toBe('No rule changed; the criteria document reference or order may have.');
});

it('groupCounts totals each queue group and lists only the statuses that have referrals', () => {
  expect(groupCounts({ draft: 2, on_hold: 1, processing: 0, finalized: 3, amended: 1 })).toEqual([
    { group: 'open', total: 3, statuses: [['draft', 2], ['on_hold', 1]] },
    { group: 'processing', total: 0, statuses: [] },
    { group: 'closed', total: 4, statuses: [['finalized', 3], ['amended', 1]] },
  ]);
  expect([duration(0), duration(59), duration(60 * 30), duration(60 * 72)]).toEqual(['under a minute', '59 min', '30 h', '3 days']);
});

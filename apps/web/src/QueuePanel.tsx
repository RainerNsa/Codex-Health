// The referral queue (M3 slice 6): a facility's referrals by status, longest waiting first. Codes and counts only;
// opening a referral is a separate, audited read. Text only, no HTML.
import { useState } from 'react';
import { ApiError, listReferrals, type QueueFilter, type QueueRow } from './api.ts';

const FILTER_LABEL: Record<QueueFilter, string> = { open: 'Needs staff', processing: 'Processing', closed: 'Decided' };
const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft', processing: 'Processing', partial_failure: 'Document failed', ready_for_review: 'Ready for review', on_hold: 'On hold',
  info_requested: 'Information requested', escalated: 'Escalated', finalized: 'Finalized', amended: 'Amended',
};
const OUTCOME_LABEL: Record<string, string> = { admit: 'Admit', needs_review: 'Needs Review', do_not_admit: 'Do Not Admit' };

export function QueuePanel({ facility, user, onOpen }: { facility: string; user: string; onOpen: (id: string) => void }) {
  const [filter, setFilter] = useState<QueueFilter>('open');
  const [rows, setRows] = useState<QueueRow[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = async (f: QueueFilter, after?: string) => {
    setMsg(null);
    try {
      const page = await listReferrals(facility, user, f, after);
      setFilter(f);
      setRows(after ? [...(rows ?? []), ...page.referrals] : page.referrals);
      setNext(page.next);
    } catch (err) {
      setMsg(err instanceof ApiError && err.code === 'forbidden' ? 'The queue is for Reviewers and Admins.' : err instanceof ApiError && err.code === 'not_found' ? 'Not a facility this user belongs to.' : 'Could not load the queue.');
    }
  };
  return (
    <section aria-labelledby="queue" className="mb-6 rounded border border-gray-300 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="queue" className="mr-2 font-semibold">Referrals</h2>
        {(Object.keys(FILTER_LABEL) as QueueFilter[]).map((f) => (
          <button key={f} type="button" aria-pressed={rows !== null && filter === f} onClick={() => void load(f)}
            className={`rounded px-3 py-1 text-sm ${rows !== null && filter === f ? 'bg-gray-900 text-white' : 'border border-gray-900'}`}>{FILTER_LABEL[f]}</button>
        ))}
      </div>
      {msg && <p role="status" className="mt-2 text-sm">{msg}</p>}
      {rows && rows.length === 0 && <p className="mt-2 text-sm text-gray-600">None.</p>}
      {rows && rows.length > 0 && (
        <table className="mt-2 w-full text-left text-sm">
          <thead><tr><th scope="col">Status</th><th scope="col">Recommendation</th><th scope="col">Documents</th><th scope="col">Last change</th><th scope="col"><span className="sr-only">Open</span></th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t">
                <td className="py-1">{STATUS_LABEL[r.status] ?? r.status}{r.cosign_waiting ? ' · waiting for co-sign' : ''}</td>
                <td>{r.outcome ? OUTCOME_LABEL[r.outcome] : 'No facts yet'}</td>
                <td>{r.documents}{r.failed_documents ? ` (${r.failed_documents} failed)` : ''}</td>
                <td>{new Date(r.updated_at).toLocaleString()}</td>
                <td><button type="button" className="rounded border border-gray-900 px-2 py-0.5 text-xs" onClick={() => onOpen(r.id)}>Open</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {next && <button type="button" className="mt-2 rounded border border-gray-900 px-3 py-1 text-sm" onClick={() => void load(filter, next)}>Load more</button>}
    </section>
  );
}

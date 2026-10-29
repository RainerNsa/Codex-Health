// The review screen's decision half (M3 slice 2; SPEC §5.1 T8–T12, T14; 2.7): what the decision rests on, the
// actions this user may take now, and the record of what happened. The API returns the allowed actions and
// checks each again; the database checks the transition and the decision a third time. Text only, no HTML.
import { useState } from 'react';
import type { Action, ReferralView } from './api.ts';

const keyLabel = (k: string) => k.replaceAll('_', ' ');
const ACTION_LABEL: Record<Action, string> = {
  submit: 'Submit for review', hold: 'Hold', request_info: 'Request information', escalate: 'Escalate', resume: 'Resume review', finalize: 'Record decision',
  reevaluate: 'Re-evaluate with current settings',
};
const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft', ready_for_review: 'Ready for review', on_hold: 'On hold', info_requested: 'Information requested', escalated: 'Escalated', finalized: 'Finalized', amended: 'Amended',
};
const OUTCOME_TEXT: Record<string, string> = { admit: 'Admit', do_not_admit: 'Do Not Admit', needs_review: 'Needs Review' };

// Each handler resolves true when the API accepted the request; a refused request keeps what was typed.
export interface ReviewHandlers {
  move: (body: { action: Exclude<Action, 'finalize' | 'reevaluate'>; note?: string; department?: string; items?: string[] }) => Promise<boolean>;
  finalize: (body: { evaluation_id: string; decision: 'admit' | 'do_not_admit'; override_reason?: string }) => Promise<boolean>;
  reevaluate: () => Promise<boolean>;
}

export function ReviewPanel({ view, busy, on }: { view: ReferralView; busy: boolean; on: ReviewHandlers }) {
  const [open, setOpen] = useState<Action | null>(null);
  const [note, setNote] = useState('');
  const [department, setDepartment] = useState('');
  const [items, setItems] = useState<string[]>([]);
  const [decision, setDecision] = useState<'admit' | 'do_not_admit' | ''>('');
  const ev = view.evaluation;
  const unconfirmed = view.confirmation.filter((c) => !c.confirmed);
  const override = ev !== null && decision !== '' && decision !== ev.outcome;
  const reset = () => { setOpen(null); setNote(''); setDepartment(''); setItems([]); setDecision(''); };
  const requestable = [...new Set([...(ev?.trace.blocking ?? []), ...(ev?.trace.missing ?? []), ...view.form.fact_keys.map((k) => k.key)])];

  return (
    <section aria-labelledby="review" className="mt-6 rounded border border-gray-300 p-4">
      <h2 id="review" className="font-semibold">Review and decision</h2>
      <p className="text-sm">Status: <span className="font-medium">{STATUS_LABEL[view.referral.status] ?? view.referral.status}</span></p>

      {view.confirmation.length > 0 && (
        <div className="mt-3">
          <h3 className="text-sm font-medium">Facts this decision rests on</h3>
          <ul className="text-sm">
            {view.confirmation.map((c) => (
              <li key={c.key}>{c.confirmed ? '✓' : '✗'} {keyLabel(c.key)} {c.confirmed ? '' : '(not yet stated: enter it on the left)'}</li>
            ))}
          </ul>
        </div>
      )}

      {view.decision && (
        <div className="mt-3 rounded border-l-4 border-gray-700 bg-gray-50 p-2 text-sm">
          Decision: <span className="font-medium">{OUTCOME_TEXT[view.decision.decision]}</span> (recommended {OUTCOME_TEXT[view.decision.recommended_outcome]}).
          {view.decision.override_reason && <> Override reason: {view.decision.override_reason}</>}
        </div>
      )}

      {view.evaluation_outdated && <p role="status" className="mt-2 text-sm text-amber-900">The facility's settings changed after this recommendation. Re-evaluate before deciding.</p>}
      {view.cosign.any && <p role="status" className="mt-2 text-sm text-amber-900">A hard-stop fact was changed from one known value to another, so any decision needs a second Admin to co-sign. Co-signing arrives in the next build.</p>}

      {view.actions.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {view.actions.map((a) => (
            <button key={a} type="button" disabled={busy} aria-pressed={open === a}
              className={`rounded px-3 py-1 text-sm disabled:opacity-50 ${a === 'finalize' ? 'bg-gray-900 text-white' : 'border border-gray-900'}`}
              onClick={() => (a === 'submit' ? void on.move({ action: 'submit' }) : a === 'reevaluate' ? void on.reevaluate() : setOpen(open === a ? null : a))}>{ACTION_LABEL[a]}</button>
          ))}
        </div>
      )}

      {open && open !== 'finalize' && open !== 'reevaluate' && (
        <form className="mt-3 rounded border border-gray-300 p-3 text-sm" onSubmit={(e) => { e.preventDefault(); void on.move({ action: open as Exclude<Action, 'finalize' | 'submit' | 'reevaluate'>, ...(note.trim() ? { note } : {}), ...(open === 'escalate' ? { department } : {}), ...(open === 'request_info' ? { items } : {}) }).then((ok) => ok && reset()); }}>
          {open === 'request_info' && (
            <fieldset>
              <legend className="font-medium">What is needed (pick at least one)</legend>
              {requestable.map((k) => (
                <label key={k} className="mr-3 inline-block"><input type="checkbox" checked={items.includes(k)} onChange={(e) => setItems(e.target.checked ? [...items, k] : items.filter((x) => x !== k))} /> {keyLabel(k)}</label>
              ))}
            </fieldset>
          )}
          {open === 'escalate' && (
            <label className="block">Department
              <select required className="ml-2 rounded border p-1" value={department} onChange={(e) => setDepartment(e.target.value)}>
                <option value="">choose</option>
                {view.form.departments.map((d) => <option key={d} value={d}>{keyLabel(d)}</option>)}
              </select>
            </label>
          )}
          <label className="mt-2 block">Note{open === 'request_info' ? ' (optional)' : ''}
            <textarea required={open !== 'request_info'} maxLength={view.form.note_max} rows={2} className="mt-1 block w-full rounded border p-1" value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          <button type="submit" disabled={busy || (open === 'request_info' ? items.length === 0 : !note.trim()) || (open === 'escalate' && !department)}
            className="mt-2 rounded bg-gray-900 px-3 py-1 text-white disabled:opacity-50">{ACTION_LABEL[open]}</button>
        </form>
      )}

      {open === 'finalize' && ev && (
        <form className="mt-3 rounded border border-gray-300 p-3 text-sm" onSubmit={(e) => { e.preventDefault(); if (decision) void on.finalize({ evaluation_id: ev.id, decision, ...(override ? { override_reason: note } : {}) }).then((ok) => ok && reset()); }}>
          <p>Recommendation: <span className="font-medium">{OUTCOME_TEXT[ev.outcome]}</span>. Staff make the decision.</p>
          {unconfirmed.length > 0 && <p role="alert" className="mt-1 text-red-800">State every fact above before deciding: {unconfirmed.map((c) => keyLabel(c.key)).join(', ')}.</p>}
          <fieldset className="mt-2">
            <legend className="font-medium">Decision</legend>
            {(['admit', 'do_not_admit'] as const).map((d) => (
              <label key={d} className="mr-4"><input type="radio" name="decision" value={d} checked={decision === d} disabled={d === 'admit' && (view.cosign.admit || view.admit_requires.length > 0)} onChange={() => setDecision(d)} /> {OUTCOME_TEXT[d]}</label>
            ))}
          </fieldset>
          {view.cosign.admit && <p className="mt-1 text-xs">Admit over a hard stop needs a second Admin to co-sign; that arrives in the next build.</p>}
          {!view.cosign.admit && view.admit_requires.length > 0 && <p className="mt-1 text-xs">Admit needs a known value (not unknown) for: {view.admit_requires.map(keyLabel).join(', ')}.</p>}
          {override && (
            <label className="mt-2 block">Override reason (required: the decision differs from the recommendation)
              <textarea required maxLength={view.form.note_max} rows={2} className="mt-1 block w-full rounded border p-1" value={note} onChange={(e) => setNote(e.target.value)} />
            </label>
          )}
          <button type="submit" disabled={busy || !decision || unconfirmed.length > 0 || (override && !note.trim())} className="mt-2 rounded bg-gray-900 px-3 py-1 text-white disabled:opacity-50">Record decision</button>
        </form>
      )}

      {view.transitions.length > 0 && (
        <div className="mt-4">
          <h3 className="text-sm font-medium">History</h3>
          <ol className="text-xs">
            {view.transitions.map((t) => (
              <li key={`${t.created_at}-${t.transition}`}>
                {new Date(t.created_at).toLocaleString()}: {STATUS_LABEL[t.from_status]} → {STATUS_LABEL[t.to_status]}
                {t.department ? ` (${keyLabel(t.department)})` : ''}{t.requested_items.length ? ` — requested: ${t.requested_items.map(keyLabel).join(', ')}` : ''}{t.note ? ` — ${t.note}` : ''}
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}

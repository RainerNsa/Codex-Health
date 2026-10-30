// Manual fact entry (SPEC §5 T7, dev-alignment 2.1): the first reviewer-facing screen. Every value the API
// returns is rendered as text (no HTML injection anywhere, CONSTRAINTS Floor). Defaults are the synthetic seed
// (scripts/dev/seed-synthetic.mjs): ZZTEST Alpha Facility 1 and its Reviewer.
import { useState, type FormEvent } from 'react';
import { amendReferral, ApiError, resolveFailures, uploadDocument, cosignRequest, createReferral, enterFact, finalizeReferral, getReferral, moveReferral, reevaluateReferral, requestCosign, type ReferralView, type Tri } from './api.ts';
import { ReviewPanel } from './ReviewPanel.tsx';
import { DocumentsPanel } from './DocumentsPanel.tsx';
import { SettingsPanel } from './SettingsPanel.tsx';

const SEED_FACILITY = '00000000-0000-4000-8000-00000000f0a1';
const SEED_USERS = [
  { id: '00000000-0000-4000-8000-0000000000e2', label: 'ZZTEST Reviewer' },
  { id: '00000000-0000-4000-8000-0000000000e1', label: 'ZZTEST Admin' },
  { id: '00000000-0000-4000-8000-0000000000e3', label: 'ZZTEST Viewer (read only)' },
];
const OUTCOME_LABEL = { admit: 'Admit', needs_review: 'Needs Review', do_not_admit: 'Do Not Admit' } as const;
const OUTCOME_STYLE = { admit: 'bg-green-100 border-green-700', needs_review: 'bg-amber-100 border-amber-700', do_not_admit: 'bg-red-100 border-red-700' } as const;
const REASON_LABEL: Record<string, string> = {
  missing_info: 'Missing information', clinical: 'Clinical review', financial: 'Financial review', leadership: 'Leadership review', processing_incomplete: 'Processing incomplete',
};
const ERROR_TEXT: Record<string, string> = {
  unauthenticated: 'Choose a user first.', not_found: 'Not found, or not visible to this user at this facility.', forbidden: 'This user may read but not change this referral.',
  invalid_fact: 'Check the entry: a value and a note are required, and the date must be real and not in the future.',
  facility_not_configured: 'This facility has no rule set or profile yet. An Admin sets them under Facility settings.',
  rule_set_refused: 'The organisation\'s rule set is invalid, so referrals cannot be evaluated until it is replaced.', referral_not_open: 'This referral is finalized; its facts are frozen and only the decision can be amended, by an Admin.',
  rejected: 'The database refused this change.',
  invalid_transition: 'Check the entry: a note is required, and a department or at least one requested item where asked.',
  transition_not_allowed: 'That step is not available from the referral\'s current status. Reload it.',
  invalid_decision: 'Check the decision: choose Admit or Do Not Admit; a reason only when it differs from the recommendation.',
  override_reason_required: 'The decision differs from the recommendation, so a reason is required.',
  evaluation_stale: 'The recommendation or the facility settings changed since this screen loaded. Reload, re-evaluate if asked, and decide again.',
  confirmation_incomplete: 'State every fact the decision rests on before deciding; Admit also needs known values, not unknown.',
  evaluation_current: 'The recommendation is already up to date.',
  cosign_required: 'This decision needs a second Admin to co-sign: file it for co-sign instead.',
  cosign_not_needed: 'This decision needs no co-sign: record it directly.',
  cosign_admin_only: 'Only an Admin can co-sign.',
  amend_admin_only: 'Only an Admin can amend a decision.',
  storage_unavailable: 'Document storage is not configured on this server.',
  document_duplicate: 'That file is already on this referral.',
  document_limit: 'A referral holds at most 20 documents.',
  document_rejected: 'That file was refused: only PDF, PNG, JPEG or TIFF files up to 25 MB, uploaded unchanged.',
  upload_missing: 'The upload did not arrive. Try again.',
  upload_failed: 'The upload to storage failed. Try again.',
  invalid_document: 'Check the document: a type from the list, and a reason for each document marked not applicable.',
  replace_required: 'A failed document must be replaced or marked not applicable first.',
  replace_not_failed: 'Only a failed document can be replaced.',
  resolve_all_failed: 'Give a reason for every failed document.',
  amendment_reason_required: 'Say why the decision is being amended.',
  cosign_own_request: 'You filed this decision, so a different Admin must co-sign it.',
  request_not_current: 'A newer decision was filed since this one. Reload.',
};
const keyLabel = (k: string) => k.replaceAll('_', ' ');

export function App() {
  const [user, setUser] = useState(SEED_USERS[0]!.id);
  const [facility, setFacility] = useState(SEED_FACILITY);
  const [referralId, setReferralId] = useState('');
  const [view, setView] = useState<ReferralView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<ReferralView>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const v = await fn();
      setView(v);
      setReferralId(v.referral.id);
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? (ERROR_TEXT[err.code] ?? `Request failed (${err.status}).`) : 'The API is not reachable.');
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto max-w-5xl p-6 font-sans text-gray-900">
      <header className="mb-6">
        <h1 className="text-xl font-semibold">Codex Health — referral review</h1>
        <p className="text-sm text-gray-600">Internal build. Synthetic data only. Local sign-in stub: no real accounts.</p>
      </header>

      <section aria-labelledby="ctx" className="mb-6 grid gap-3 rounded border border-gray-300 p-4 sm:grid-cols-3">
        <h2 id="ctx" className="sr-only">Who and where</h2>
        <label className="text-sm">User
          <select className="mt-1 block w-full rounded border p-1" value={user} onChange={(e) => setUser(e.target.value)}>
            {SEED_USERS.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
          </select>
        </label>
        <label className="text-sm">Facility id
          <input className="mt-1 block w-full rounded border p-1 font-mono text-xs" value={facility} onChange={(e) => setFacility(e.target.value.trim())} />
        </label>
        <label className="text-sm">Referral id
          <input className="mt-1 block w-full rounded border p-1 font-mono text-xs" value={referralId} onChange={(e) => setReferralId(e.target.value.trim())} />
        </label>
        <div className="flex gap-2 sm:col-span-3">
          <button type="button" disabled={busy} className="rounded bg-gray-900 px-3 py-1 text-white disabled:opacity-50" onClick={() => run(() => createReferral(facility, user))}>New referral</button>
          <button type="button" disabled={busy || !referralId} className="rounded border border-gray-900 px-3 py-1 disabled:opacity-50" onClick={() => run(() => getReferral(facility, referralId, user))}>Open referral</button>
        </div>
      </section>

      <SettingsPanel facility={facility} user={user} />

      {error && <p role="alert" className="mb-4 rounded border border-red-700 bg-red-50 p-3 text-sm">{error}</p>}

      {view && (
        <DocumentsPanel view={view} busy={busy} on={{
          upload: async (files, type, replaces) => {
            let ok = true;
            for (const f of files) ok = (await run(() => uploadDocument(facility, view.referral.id, user, f, type, replaces))) && ok;
            return ok;
          },
          process: () => run(() => moveReferral(facility, view.referral.id, user, { action: 'process' })),
          resolve: (documents) => run(() => resolveFailures(facility, view.referral.id, user, documents)),
        }} />
      )}

      {view && (
        <div className="grid gap-6 lg:grid-cols-2">
          <section aria-labelledby="enter">
            <h2 id="enter" className="mb-2 font-semibold">Enter or correct a fact</h2>
            <p className="mb-3 text-sm text-gray-600">Status: {view.referral.status}. Each entry needs a note saying where the information came from. A correction keeps the earlier value on record.</p>
            {view.form.fact_keys.map((k) => (
              <FactForm key={k.key} fact={k.key} critical={k.critical} noteMax={view.form.note_max} disabled={busy}
                current={view.facts.find((f) => f.key === k.key)}
                onSubmit={(value, note, asOf) => run(() => enterFact(facility, view.referral.id, user, { key: k.key, value: { type: 'tri_state', value }, note, as_of_date: asOf }))} />
            ))}
          </section>
          <div>
            <Recommendation view={view} />
            <ReviewPanel view={view} busy={busy} on={{
              move: (body) => run(() => moveReferral(facility, view.referral.id, user, body)),
              finalize: (body) => run(() => finalizeReferral(facility, view.referral.id, user, body)),
              reevaluate: () => run(() => reevaluateReferral(facility, view.referral.id, user)),
              requestCosign: (body) => run(() => requestCosign(facility, view.referral.id, user, body)),
              amend: (body) => run(() => amendReferral(facility, view.referral.id, user, body)),
              cosign: (request) => run(() => cosignRequest(facility, view.referral.id, request, user)),
            }} />
          </div>
        </div>
      )}
    </main>
  );
}

function FactForm(props: { fact: string; critical: boolean; noteMax: number; disabled: boolean; current: ReferralView['facts'][number] | undefined; onSubmit: (v: Tri, note: string, asOf: string | null) => void }) {
  const [value, setValue] = useState<Tri>('unknown');
  const [note, setNote] = useState('');
  const [asOf, setAsOf] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    props.onSubmit(value, note, asOf || null);
    setNote('');
  };
  const id = `fact-${props.fact}`;
  return (
    <form onSubmit={submit} className="mb-3 rounded border border-gray-300 p-3" aria-labelledby={`${id}-legend`}>
      <fieldset>
        <legend id={`${id}-legend`} className="font-medium">
          {keyLabel(props.fact)} {props.critical && <span className="ml-1 rounded bg-gray-200 px-1 text-xs">critical</span>}
        </legend>
        <p className="text-xs text-gray-600">Current: {props.current ? `${String(props.current.value.value)} (${props.current.source}${props.current.as_of_date ? `, as of ${props.current.as_of_date}` : ''})` : 'not entered'}</p>
        <div className="mt-2 flex gap-4 text-sm">
          {(['yes', 'no', 'unknown'] as const).map((v) => (
            <label key={v}><input type="radio" name={`${id}-value`} value={v} checked={value === v} onChange={() => setValue(v)} /> {v}</label>
          ))}
        </div>
        <label className="mt-2 block text-sm">Note (source of this information)
          <textarea required maxLength={props.noteMax} className="mt-1 block w-full rounded border p-1" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        <label className="mt-2 block text-sm">As of (optional)
          <input type="date" className="mt-1 block rounded border p-1" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
        </label>
        <button type="submit" disabled={props.disabled || !note.trim()} className="mt-2 rounded bg-gray-900 px-3 py-1 text-sm text-white disabled:opacity-50">Save</button>
      </fieldset>
    </form>
  );
}

function Recommendation({ view }: { view: ReferralView }) {
  const ev = view.evaluation;
  return (
    <section aria-labelledby="rec" aria-live="polite">
      <h2 id="rec" className="mb-2 font-semibold">Recommendation</h2>
      {!ev && <p className="text-sm text-gray-600">No facts entered yet.</p>}
      {ev && (
        <>
          <div className={`mb-3 rounded border-l-4 p-3 ${OUTCOME_STYLE[ev.outcome]}`}>
            <p className="text-lg font-semibold">{OUTCOME_LABEL[ev.outcome]}</p>
            {ev.sub_reasons.length > 0 && <p className="text-sm">{ev.sub_reasons.map((r) => REASON_LABEL[r] ?? r).join(' · ')}</p>}
            <p className="text-xs text-gray-700">Clinical: {ev.clinical_outcome.replaceAll('_', ' ')} · Financial: {ev.financial_status}. Staff make the final decision.</p>
          </div>
          {ev.trace.missing.length > 0 && <p className="mb-2 text-sm"><span className="font-medium">Missing critical information:</span> {ev.trace.missing.map(keyLabel).join(', ')}</p>}
          {ev.trace.blocking.length > 0 && <p className="mb-2 text-sm"><span className="font-medium">Confirm first:</span> {ev.trace.blocking.map(keyLabel).join(', ')}</p>}
          {ev.trace.conflicts.length > 0 && <p className="mb-2 text-sm"><span className="font-medium">Conflicting:</span> {ev.trace.conflicts.map(keyLabel).join(', ')}</p>}
          {(ev.trace.confirmation_set ?? []).length > 0 && <p className="mb-2 text-sm"><span className="font-medium">To confirm before a decision:</span> {(ev.trace.confirmation_set ?? []).map(keyLabel).join(', ')}</p>}
          <table className="mt-3 w-full text-left text-sm">
            <caption className="text-left font-medium">Why: every rule and what it read</caption>
            <thead><tr><th scope="col">Rule</th><th scope="col">Kind</th><th scope="col">Result</th><th scope="col">Inputs</th></tr></thead>
            <tbody>
              {ev.trace.trace.map((t) => (
                <tr key={t.rule_id} className="border-t align-top">
                  <td className="py-1 font-mono text-xs">{t.rule_id}{view.rule_explanations[t.rule_id] && <span className="block font-sans text-gray-700">{view.rule_explanations[t.rule_id]}</span>}</td>
                  <td>{t.kind.replaceAll('_', ' ')}</td>
                  <td>{t.result === 'yes' ? 'fired' : t.result === 'no' ? 'did not fire' : 'unknown'}</td>
                  <td className="text-xs">{t.inputs.map((i) => `${keyLabel(i.key)}: ${i.value ?? i.presence}`).join('; ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

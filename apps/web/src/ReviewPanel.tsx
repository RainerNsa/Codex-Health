// The review screen's decision half (M3 slice 2; SPEC §5.1 T8–T12, T14; 2.7): what the decision rests on, the
// actions this user may take now, and the record of what happened. The API returns the allowed actions and
// checks each again; the database checks the transition and the decision a third time. Text only, no HTML.
import { useState } from 'react';
import { Box, Button, Flex, Grid, Heading, HStack, Text, Textarea, chakra } from '@chakra-ui/react';
import { CheckIcon, XIcon } from '@phosphor-icons/react';
import type { Action, DecisionBody, ReferralView } from './api.ts';
import { Callout, Field, Panel, Select } from './ui.tsx';

const keyLabel = (k: string) => k.replaceAll('_', ' ');
const ACTION_LABEL: Record<Action, string> = {
  submit: 'Submit for review', hold: 'Hold', request_info: 'Request information', escalate: 'Escalate', resume: 'Resume review', finalize: 'Record decision',
  reevaluate: 'Re-evaluate with current settings', cosign: 'Co-sign the filed decision', amend: 'Amend the decision',
  process: 'Submit for processing', upload: 'Add documents', resolve_failures: 'Resolve failed documents',
};
const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft', ready_for_review: 'Ready for review', on_hold: 'On hold', info_requested: 'Information requested', escalated: 'Escalated', finalized: 'Finalized', amended: 'Amended',
};
const OUTCOME_TEXT: Record<string, string> = { admit: 'Admit', do_not_admit: 'Do Not Admit', needs_review: 'Needs Review' };

// Each handler resolves true when the API accepted the request; a refused request keeps what was typed.
export interface ReviewHandlers {
  move: (body: { action: 'submit' | 'hold' | 'request_info' | 'escalate' | 'resume'; note?: string; department?: string; items?: string[] }) => Promise<boolean>;
  finalize: (body: DecisionBody) => Promise<boolean>;
  amend: (body: DecisionBody) => Promise<boolean>;
  requestCosign: (body: DecisionBody) => Promise<boolean>;
  cosign: (request: string) => Promise<boolean>;
  reevaluate: () => Promise<boolean>;
}

export function ReviewPanel({ view, busy, on }: { view: ReferralView; busy: boolean; on: ReviewHandlers }) {
  const [open, setOpen] = useState<Action | null>(null);
  const [note, setNote] = useState('');
  const [department, setDepartment] = useState('');
  const [items, setItems] = useState<string[]>([]);
  const [decision, setDecision] = useState<'admit' | 'do_not_admit' | ''>('');
  const [amendmentReason, setAmendmentReason] = useState('');
  const ev = view.evaluation;
  const unconfirmed = view.confirmation.filter((c) => !c.confirmed);
  const override = ev !== null && decision !== '' && decision !== ev.outcome;
  // a hard stop overridden to Admit, or any decision after a flipped hard-stop input, is filed for an Admin to co-sign
  const needsCosign = decision !== '' && (view.cosign.any || (decision === 'admit' && view.cosign.admit));
  const reset = () => { setOpen(null); setNote(''); setDepartment(''); setItems([]); setDecision(''); setAmendmentReason(''); };
  const amending = open === 'amend';
  const requestable = [...new Set([...(ev?.trace.blocking ?? []), ...(ev?.trace.missing ?? []), ...view.form.fact_keys.map((k) => k.key)])];

  const noteField = (title: string, value: string, set: (v: string) => void, required = true) => (
    <Field label={title}><Textarea size="sm" required={required} maxLength={view.form.note_max} rows={2} value={value} onChange={(e) => set(e.target.value)} /></Field>
  );
  const box = { mt: '3', borderWidth: '1px', borderColor: 'line', borderRadius: 'l2', p: '3', fontSize: 'sm' } as const;

  return (
    <Panel id="review" title="Review and decision">
      <Text fontSize="sm">Status: <chakra.span fontWeight="600">{STATUS_LABEL[view.referral.status] ?? view.referral.status}</chakra.span></Text>

      {view.confirmation.length > 0 && (
        <Box mt="3">
          <Heading as="h3" size="xs">Facts this decision rests on</Heading>
          <chakra.ul fontSize="sm" mt="1">
            {view.confirmation.map((c) => (
              <Flex as="li" key={c.key} align="center" gap="1.5">
                {c.confirmed ? <CheckIcon aria-hidden="true" weight="bold" color="var(--chakra-colors-admit)" /> : <XIcon aria-hidden="true" weight="bold" color="var(--chakra-colors-stop)" />}
                <span>{keyLabel(c.key)} {c.confirmed ? '(stated)' : '(not yet stated: enter it on the left)'}</span>
              </Flex>
            ))}
          </chakra.ul>
        </Box>
      )}

      {view.decisions.length > 0 && (
        <Box mt="3" bg="infoSoft" borderLeftWidth="4px" borderColor="info" borderRadius="l2" p="2" fontSize="sm">
          <Heading as="h3" size="xs">Decisions (newest first; none is ever changed)</Heading>
          <ol>
            {view.decisions.map((d, i) => (
              <Box as="li" key={d.id} fontWeight={i === 0 ? '600' : '400'} color={i === 0 ? 'ink' : 'muted'}>
                {new Date(d.decided_at).toLocaleString()}: {d.amends_decision_id ? 'Amended to' : 'Decided'} {OUTCOME_TEXT[d.decision]} (recommended {OUTCOME_TEXT[d.recommended_outcome]})
                {d.cosigned_by ? ', co-signed' : ''}{d.override_reason ? `. Override reason: ${d.override_reason}` : ''}{d.amendment_reason ? `. Amendment reason: ${d.amendment_reason}` : ''}
              </Box>
            ))}
          </ol>
        </Box>
      )}

      <Grid gap="2" mt="2">
        {view.evaluation_outdated && <Callout tone="review" role="status">The facility's settings changed after this recommendation. Re-evaluate before deciding.</Callout>}
        {view.cosign.any && <Callout tone="review" role="status">A hard-stop fact was changed from one known value to another, so any decision is filed for a second Admin to co-sign.</Callout>}
        {!view.cosign.any && view.cosign.admit && view.evaluation?.outcome !== 'do_not_admit' && <Callout tone="review" role="status">A hard stop decided this referral earlier, so an Admit is filed for a second Admin to co-sign.</Callout>}
        {view.pending_request && (
          <Callout tone="review">
            {view.pending_request.amends_decision_id ? 'Amendment filed' : 'Filed'} for co-sign by {view.pending_request.requested_by_name}: <chakra.span fontWeight="600">{OUTCOME_TEXT[view.pending_request.decision]}</chakra.span>
            {view.pending_request.amendment_reason && <> (amendment reason: {view.pending_request.amendment_reason})</>}
            {view.pending_request.override_reason && <> (reason: {view.pending_request.override_reason})</>}.
            {' '}{view.pending_request.can_cosign ? 'You can co-sign it.' : 'Waiting for an Admin who did not file it.'}
            {open === 'cosign' && view.pending_request.can_cosign && (
              <Box mt="2">
                <Text>Co-signing records this decision for {view.pending_request.requested_by_name}, with you as the second Admin, and finalizes the referral.</Text>
                <HStack mt="1" gap="2">
                  <Button size="sm" disabled={busy} onClick={() => view.pending_request && void on.cosign(view.pending_request.id).then((ok) => ok && reset())}>Co-sign and finalize</Button>
                  <Button size="sm" variant="outline" onClick={reset}>Cancel</Button>
                </HStack>
              </Box>
            )}
          </Callout>
        )}
      </Grid>

      {view.actions.length > 0 && (
        <Flex mt="3" wrap="wrap" gap="2">
          {view.actions.filter((a) => a !== 'upload' && a !== 'resolve_failures' && a !== 'process').map((a) => (
            <Button key={a} size="sm" disabled={busy} aria-pressed={open === a} variant={a === 'finalize' ? 'solid' : 'outline'}
              onClick={() => (a === 'submit' ? void on.move({ action: 'submit' }) : a === 'reevaluate' ? void on.reevaluate()
                : setOpen(open === a ? null : a))}>{ACTION_LABEL[a]}</Button>
          ))}
        </Flex>
      )}

      {open && (open === 'hold' || open === 'request_info' || open === 'escalate' || open === 'resume') && (
        <chakra.form {...box} onSubmit={(e) => { e.preventDefault(); void on.move({ action: open as 'hold' | 'request_info' | 'escalate' | 'resume', ...(note.trim() ? { note } : {}), ...(open === 'escalate' ? { department } : {}), ...(open === 'request_info' ? { items } : {}) }).then((ok) => ok && reset()); }}>
          {open === 'request_info' && (
            <fieldset>
              <chakra.legend fontWeight="600">What is needed (pick at least one)</chakra.legend>
              <Flex wrap="wrap" gap="3">
                {requestable.map((k) => (
                  <label key={k}><input type="checkbox" checked={items.includes(k)} onChange={(e) => setItems(e.target.checked ? [...items, k] : items.filter((x) => x !== k))} /> {keyLabel(k)}</label>
                ))}
              </Flex>
            </fieldset>
          )}
          {open === 'escalate' && (
            <Field label="Department">
              <Select required value={department} onChange={setDepartment}>
                <option value="">choose</option>
                {view.form.departments.map((d) => <option key={d} value={d}>{keyLabel(d)}</option>)}
              </Select>
            </Field>
          )}
          <Box mt="2">{noteField(`Note${open === 'request_info' ? ' (optional)' : ''}`, note, setNote, open !== 'request_info')}</Box>
          <Button type="submit" mt="2" size="sm" disabled={busy || (open === 'request_info' ? items.length === 0 : !note.trim()) || (open === 'escalate' && !department)}>{ACTION_LABEL[open]}</Button>
        </chakra.form>
      )}

      {(open === 'finalize' || amending) && ev && (
        <chakra.form {...box} onSubmit={(e) => {
          e.preventDefault();
          if (!decision) return;
          const body: DecisionBody = { evaluation_id: ev.id, decision, ...(override ? { override_reason: note } : {}), ...(amending ? { amendment_reason: amendmentReason } : {}) };
          void (needsCosign ? on.requestCosign(body) : amending ? on.amend(body) : on.finalize(body)).then((ok) => ok && reset());
        }}>
          {amending && <Box mb="2">{noteField('Why the decision is being amended (required; the earlier decision stays on record)', amendmentReason, setAmendmentReason)}</Box>}
          <Text>Recommendation: <chakra.span fontWeight="600">{OUTCOME_TEXT[ev.outcome]}</chakra.span>. Staff make the decision.</Text>
          {unconfirmed.length > 0 && <Text role="alert" mt="1" color="stop">State every fact above before deciding: {unconfirmed.map((c) => keyLabel(c.key)).join(', ')}.</Text>}
          <chakra.fieldset mt="2">
            <chakra.legend fontWeight="600">Decision</chakra.legend>
            <HStack gap="4">
              {(['admit', 'do_not_admit'] as const).map((d) => (
                <label key={d}><input type="radio" name="decision" value={d} checked={decision === d} disabled={d === 'admit' && view.admit_requires.length > 0} onChange={() => setDecision(d)} /> {OUTCOME_TEXT[d]}</label>
              ))}
            </HStack>
          </chakra.fieldset>
          {view.admit_requires.length > 0 && <Text mt="1" fontSize="xs">Admit needs a known value (not unknown) for: {view.admit_requires.map(keyLabel).join(', ')}.</Text>}
          {needsCosign && <Text mt="1" fontSize="xs">This decision is filed for a second Admin to co-sign; it is final only once they do.</Text>}
          {override && <Box mt="2">{noteField('Override reason (required: the decision differs from the recommendation)', note, setNote)}</Box>}
          <Button type="submit" mt="2" size="sm" disabled={busy || !decision || unconfirmed.length > 0 || (override && !note.trim()) || (amending && !amendmentReason.trim())}>{needsCosign ? 'File for co-sign' : amending ? 'Record amendment' : 'Record decision'}</Button>
        </chakra.form>
      )}

      {view.transitions.length > 0 && (
        <Box mt="4">
          <Heading as="h3" size="xs">History</Heading>
          <chakra.ol fontSize="xs" mt="1">
            {view.transitions.map((t) => (
              <li key={`${t.created_at}-${t.transition}`}>
                {new Date(t.created_at).toLocaleString()}: {STATUS_LABEL[t.from_status]} → {STATUS_LABEL[t.to_status]}
                {t.department ? ` (${keyLabel(t.department)})` : ''}{t.requested_items.length ? ` — requested: ${t.requested_items.map(keyLabel).join(', ')}` : ''}{t.note ? ` — ${t.note}` : ''}
              </li>
            ))}
          </chakra.ol>
        </Box>
      )}
    </Panel>
  );
}

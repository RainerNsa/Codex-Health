// Manual fact entry (SPEC §5 T7, dev-alignment 2.1): the first reviewer-facing screen. Every value the API
// returns is rendered as text (no HTML injection anywhere, CONSTRAINTS Floor). Defaults are the synthetic seed
// (scripts/dev/seed-synthetic.mjs): ZZTEST Alpha Facility 1 and its Reviewer.
import { useEffect, useState, type FormEvent } from 'react';
import { Box, Button, Flex, Grid, Heading, HStack, Input, Progress as ChakraProgress, Table, Text, Textarea, chakra } from '@chakra-ui/react';
import { ArrowLeftIcon, CheckCircleIcon, PlusIcon, ProhibitIcon, WarningCircleIcon, type Icon } from '@phosphor-icons/react';
import { amendReferral, ApiError, resolveFailures, uploadDocument, cosignRequest, createReferral, enterFact, finalizeReferral, getReferral, moveReferral, reevaluateReferral, requestCosign, type ReferralView, type Tri } from './api.ts';
import { ReviewPanel } from './ReviewPanel.tsx';
import { DocumentsPanel } from './DocumentsPanel.tsx';
import { EvidencePanel } from './EvidencePanel.tsx';
import { QueuePanel, StatusPill } from './QueuePanel.tsx';
import { useReviewTimer } from './reviewTimer.ts';
import { Logo } from './Logo.tsx';
import { Nav, Placeholder, SCREENS, type Screen } from './Placeholders.tsx';
import { SettingsPanel } from './SettingsPanel.tsx';
import { Callout, Field, Panel, Select, Sub, type Tone } from './ui.tsx';

// shortcut: the seeded facilities; a user's own list comes with real sign-in (M6), since listing them needs a new read policy
const SEED_FACILITIES = [
  { id: '00000000-0000-4000-8000-00000000f0a1', label: 'ZZTEST Alpha Facility 1' },
  { id: '00000000-0000-4000-8000-00000000f0a2', label: 'ZZTEST Alpha Facility 2' },
  { id: '00000000-0000-4000-8000-00000000f0b1', label: 'ZZTEST Beta Facility 1' },
  { id: '00000000-0000-4000-8000-00000000f0b2', label: 'ZZTEST Beta Facility 2' },
];
const SEED_USERS = [
  { id: '00000000-0000-4000-8000-0000000000e2', label: 'ZZTEST Reviewer' },
  { id: '00000000-0000-4000-8000-0000000000e1', label: 'ZZTEST Admin' },
  { id: '00000000-0000-4000-8000-0000000000e3', label: 'ZZTEST Viewer (read only)' },
];
const POLL_MS = 10_000;
const OUTCOME_LABEL = { admit: 'Admit', needs_review: 'Needs Review', do_not_admit: 'Do Not Admit' } as const;
const OUTCOME_LOOK: Record<string, { tone: Tone; icon: Icon }> = { admit: { tone: 'admit', icon: CheckCircleIcon }, needs_review: { tone: 'review', icon: WarningCircleIcon }, do_not_admit: { tone: 'stop', icon: ProhibitIcon } };
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
  fact_changed: 'This reading changed since the screen loaded. Reload the referral and check it again.',
  evidence_not_viewed: 'Open the page before confirming this reading.',
  cosign_required: 'This decision needs a second Admin to co-sign: file it for co-sign instead.',
  cosign_not_needed: 'This decision needs no co-sign: record it directly.',
  cosign_admin_only: 'Only an Admin can co-sign.',
  amend_admin_only: 'Only an Admin can amend a decision.',
  storage_unavailable: 'Document storage is not configured on this server.',
  queue_unavailable: 'The referral is saved, but its documents could not be queued for reading. Tell your administrator.',
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
  const [facility, setFacility] = useState(SEED_FACILITIES[0]!.id);
  const [view, setView] = useState<ReferralView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [screen, setScreen] = useState<Screen>('referrals');
  // review time counts only while the referral is on screen: another screen ends (and reports) the session
  useReviewTimer(facility, user, screen === 'referrals' ? view?.referral.id ?? null : null);
  // a different user or facility never keeps another's referral open (or its review time)
  useEffect(() => { setView(null); }, [user, facility]);
  // while the pipeline has the referral, follow it: nothing else tells this screen it finished
  const openId = view?.referral.id;
  const processing = view?.referral.status === 'processing';
  useEffect(() => {
    if (!openId || !processing) return;
    let current = true;
    const poll = setInterval(() => { void getReferral(facility, openId, user).then((v) => { if (current) setView(v); }).catch(() => {}); }, POLL_MS);
    return () => { current = false; clearInterval(poll); };
  }, [openId, processing, facility, user]);

  const run = async (fn: () => Promise<ReferralView>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const v = await fn();
      setView(v);
      setScreen('referrals');
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? (ERROR_TEXT[err.code] ?? `Request failed (${err.status}).`) : 'The API is not reachable.');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const inReferral = screen === 'referrals' && view !== null;
  return (
    <Grid colorPalette="brand" minH="100dvh" templateColumns={{ base: 'minmax(0, 1fr)', lg: '15rem minmax(0, 1fr)' }}>
      {/* the rail is navy in both themes, so its focus ring uses the signal colour */}
      <Box as="header" bg="rail" color="railInk" css={{ '--chakra-colors-brand-solid': 'var(--chakra-colors-signal)' }}>
      <Flex direction="column" gap="6" p="4" position={{ lg: 'sticky' }} top="0" h={{ lg: '100dvh' }}>
        <Logo />
        <Nav screen={screen} onSelect={setScreen} />
        <Grid mt={{ lg: 'auto' }} gap="3">
          <Field label="Facility">
            <Select value={facility} onChange={setFacility}>{SEED_FACILITIES.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}</Select>
          </Field>
          <Field label="Signed in as">
            <Select value={user} onChange={setUser}>{SEED_USERS.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}</Select>
          </Field>
        </Grid>
      </Flex>
      </Box>

      <Grid as="main" templateColumns="minmax(0, 1fr)" gap="4" p={{ base: '4', lg: '6' }} alignContent="start" minW="0">
        <Flex wrap="wrap" align="start" justify="space-between" gap="3">
          <Box>
            <Flex wrap="wrap" align="center" gap="2.5">
              <Heading as="h1" size="lg" fontWeight="700">{inReferral ? <>Referral <chakra.span fontFamily="mono" fontWeight="400">{view.referral.id.slice(0, 8)}</chakra.span></> : SCREENS.find((s) => s.id === screen)?.label}</Heading>
              {inReferral && <StatusPill status={view.referral.status} />}
            </Flex>
            <Sub>Internal build. Synthetic data only. Local sign-in stub: no real accounts.</Sub>
          </Box>
          {inReferral
            ? <Button size="sm" variant="outline" onClick={() => setView(null)}><ArrowLeftIcon aria-hidden="true" /> Back to referrals</Button>
            : screen === 'referrals' && <Button size="sm" disabled={busy} onClick={() => run(() => createReferral(facility, user))}><PlusIcon aria-hidden="true" /> New referral</Button>}
        </Flex>

        {error && <Callout tone="stop" role="alert">{error}</Callout>}

        {screen === 'settings' && <SettingsPanel facility={facility} user={user} />}
        <Placeholder screen={screen} />

        {/* a new facility or user starts an empty list: one person's queue never shows under another's name */}
        {screen === 'referrals' && !view && <QueuePanel key={`${facility}:${user}`} facility={facility} user={user} onOpen={(id) => void run(() => getReferral(facility, id, user))} />}

        {inReferral && view.referral.status === 'processing' && <Progress documents={view.documents} />}
        {inReferral && <Recommendation view={view} />}

        {inReferral && (
          <Grid gap="4" templateColumns={{ base: 'minmax(0, 1fr)', xl: 'minmax(0, 3fr) minmax(0, 2fr)' }} alignItems="start">
            <Grid gap="4" minW="0">
              {/* one per referral: a link to one patient's document never survives into another's screen */}
              <EvidencePanel key={view.referral.id} view={view} facility={facility} user={user} busy={busy}
                onConfirm={(f) => void run(() => enterFact(facility, view.referral.id, user, { key: f.key, value: f.value as { type: 'tri_state'; value: Tri }, note: `Reading confirmed after opening page ${f.evidence?.page ?? '?'}`, as_of_date: null, confirms: f.id }))}
                form={(k) => <FactForm key={k.key} fact={k.key} noteMax={view.form.note_max} disabled={busy}
                  onSubmit={(value, note, asOf) => run(() => enterFact(facility, view.referral.id, user, { key: k.key, value: { type: 'tri_state', value }, note, as_of_date: asOf }))} />} />
              <DocumentsPanel view={view} busy={busy} on={{
                upload: async (files, type, replaces) => {
                  let ok = true;
                  for (const f of files) ok = (await run(() => uploadDocument(facility, view.referral.id, user, f, type, replaces))) && ok;
                  return ok;
                },
                process: () => run(() => moveReferral(facility, view.referral.id, user, { action: 'process' })),
                resolve: (documents) => run(() => resolveFailures(facility, view.referral.id, user, documents)),
              }} />
            </Grid>
            <Grid gap="4" minW="0">
              <ReviewPanel view={view} busy={busy} on={{
                move: (body) => run(() => moveReferral(facility, view.referral.id, user, body)),
                finalize: (body) => run(() => finalizeReferral(facility, view.referral.id, user, body)),
                reevaluate: () => run(() => reevaluateReferral(facility, view.referral.id, user)),
                requestCosign: (body) => run(() => requestCosign(facility, view.referral.id, user, body)),
                amend: (body) => run(() => amendReferral(facility, view.referral.id, user, body)),
                cosign: (request) => run(() => cosignRequest(facility, view.referral.id, request, user)),
              }} />
              <Why view={view} />
            </Grid>
          </Grid>
        )}
      </Grid>
    </Grid>
  );
}

function Progress({ documents }: { documents: ReferralView['documents'] }) {
  const counted = documents.filter((d) => d.status !== 'not_applicable');
  const done = counted.filter((d) => d.status !== 'uploaded').length;
  return (
    <Panel id="progress">
      <Text role="status" fontSize="sm" fontWeight="500">Reading documents: {done} of {counted.length} done. The referral returns for review when they finish.</Text>
      <ChakraProgress.Root mt="2" size="xs" max={Math.max(counted.length, 1)} value={done} aria-label="Documents read">
        <ChakraProgress.Track><ChakraProgress.Range /></ChakraProgress.Track>
      </ChakraProgress.Root>
    </Panel>
  );
}

function FactForm(props: { fact: string; noteMax: number; disabled: boolean; onSubmit: (v: Tri, note: string, asOf: string | null) => void }) {
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
    <chakra.form onSubmit={submit} mt="2" bg="canvas" borderRadius="l2" p="3" aria-labelledby={`${id}-legend`}>
      <fieldset>
        <chakra.legend id={`${id}-legend`} fontWeight="600" fontSize="sm">Enter or correct {keyLabel(props.fact)}</chakra.legend>
        <HStack mt="2" gap="4" fontSize="sm">
          {(['yes', 'no', 'unknown'] as const).map((v) => (
            <label key={v}><input type="radio" name={`${id}-value`} value={v} checked={value === v} onChange={() => setValue(v)} /> {v}</label>
          ))}
        </HStack>
        <Grid mt="2" gap="2">
          <Field label="Note (source of this information)"><Textarea size="sm" required maxLength={props.noteMax} rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          <Field label="As of (optional)"><Input size="sm" w="auto" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></Field>
        </Grid>
        <Button type="submit" mt="2" size="xs" disabled={props.disabled || !note.trim()}>Save</Button>
      </fieldset>
    </chakra.form>
  );
}

function Recommendation({ view }: { view: ReferralView }) {
  const ev = view.evaluation;
  const look = ev ? OUTCOME_LOOK[ev.outcome]! : null;
  const list = (title: string, keys: string[]) => keys.length > 0 && <Text mt="1" fontSize="sm"><chakra.span fontWeight="600">{title}:</chakra.span> {keys.map(keyLabel).join(', ')}</Text>;
  if (!ev || !look) return <Panel id="rec" title="Recommendation"><Sub>No facts entered yet.</Sub></Panel>;
  return (
    <Box as="section" aria-labelledby="rec" aria-live="polite" bg={`${look.tone}Soft`} borderLeftWidth="4px" borderColor={look.tone} borderRadius="l2" p="4">
      <Flex wrap="wrap" align="center" gap="2.5">
        <Heading id="rec" as="h2" size="xs" color="muted" fontWeight="600" w="full">Recommendation</Heading>
        <Box color={look.tone}><look.icon size={28} weight="bold" aria-hidden="true" /></Box>
        <Text fontSize="2xl" fontWeight="700" color={look.tone} lineHeight="1">{OUTCOME_LABEL[ev.outcome]}</Text>
        {ev.sub_reasons.length > 0 && <Text fontSize="sm" fontWeight="500">{ev.sub_reasons.map((r) => REASON_LABEL[r] ?? r).join(' · ')}</Text>}
      </Flex>
      {ev.raw && <Text mt="2" fontSize="sm" fontWeight="600">Preliminary: read by the AI from the documents. No person has confirmed these facts.</Text>}
      {list('Documents disagree, state again', ev.trace.disagreements ?? [])}
      {list('Missing critical information', ev.trace.missing)}
      {list('Confirm first', ev.trace.blocking)}
      {list('Conflicting', ev.trace.conflicts)}
      {list('To confirm before a decision', ev.trace.confirmation_set ?? [])}
      <Text mt="1" fontSize="xs" color="muted">Clinical: {ev.clinical_outcome.replaceAll('_', ' ')} · Financial: {ev.financial_status}. Staff make the final decision.</Text>
    </Box>
  );
}

function Why({ view }: { view: ReferralView }) {
  const ev = view.evaluation;
  if (!ev) return null;
  return (
    <Panel id="why">
      <details>
        <chakra.summary cursor="pointer" fontWeight="700" fontSize="sm">Why: every rule and what it read</chakra.summary>
        <Table.ScrollArea mt="2" tabIndex={0} position="relative">
          <Table.Root size="sm">
            <Table.Header><Table.Row bg="transparent"><Table.ColumnHeader>Rule</Table.ColumnHeader><Table.ColumnHeader>Result</Table.ColumnHeader><Table.ColumnHeader>Inputs</Table.ColumnHeader></Table.Row></Table.Header>
            <Table.Body>
              {ev.trace.trace.map((t) => (
                <Table.Row key={t.rule_id} bg="transparent" verticalAlign="top">
                  <Table.Cell whiteSpace="normal" minW="12rem">
                    <Text fontSize="xs" color="muted">{t.kind.replaceAll('_', ' ')}</Text>
                    {view.rule_explanations[t.rule_id] ?? <chakra.span fontFamily="mono" fontSize="xs" wordBreak="break-word">{t.rule_id}</chakra.span>}
                  </Table.Cell>
                  <Table.Cell>{t.result === 'yes' ? 'fired' : t.result === 'no' ? 'did not fire' : 'unknown'}</Table.Cell>
                  <Table.Cell fontSize="xs" whiteSpace="normal" minW="8rem">{t.inputs.map((i) => `${keyLabel(i.key)}: ${i.value ?? i.presence}`).join('; ')}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
        </Table.ScrollArea>
      </details>
    </Panel>
  );
}

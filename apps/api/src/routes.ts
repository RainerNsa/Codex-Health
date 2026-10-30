// Manual fact entry (SPEC §5 T7, dev-alignment 2.1): the first reviewer-facing slice. A Reviewer or Admin creates
// a referral, enters or corrects facts by hand with a note, and sees the recommendation the engine derives.
// Every write runs in one transaction as codex_app under RLS, writes its audit row and product events, and
// re-evaluates. Responses carry ids, codes and the reviewer's own entries; errors never echo request content.
import type { FastifyInstance, FastifyReply } from 'fastify';
import { evaluate, ENGINE_VERSION, isRealDate, parseFactValue, type Fact, type FactValue } from '@codex-health/rules-engine';
import { bindFacility, bindOrganization, type Query, type Tx } from './db.ts';
import { userFromHeaders } from './auth.ts';
import { loadSettings as loadStored, NOT_SWITCHABLE, PROFILE_KEYS, RuleSetRefused, type RuleSet } from './ruleset.ts';
import type { Enqueue } from './queue.ts';
import { MAX_DOCUMENT_BYTES, sniff, UPLOAD_TTL_SECONDS, type Storage } from './storage.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WRITE_ROLES = new Set(['facility_admin', 'admissions_reviewer']);
// Patient-level reads: Reviewers and Admins only. A Viewer sees no referral (SPEC §6: engineering default "none"
// for patient-level Viewer reads, pending founder item 8; aggregates arrive with the rollup table).
const READ_ROLES = WRITE_ROLES;
// T7 states, plus draft: a manual-entry referral has no documents and never passes through processing (SPEC §5.1
// amended with this slice). processing and partial_failure stay closed while the pipeline owns the referral.
const OPEN_STATES = new Set(['draft', 'ready_for_review', 'on_hold', 'info_requested', 'escalated']);
const NOTE_MAX = 500;
const DEPARTMENTS = ['administrator', 'director_of_nursing', 'medical_director', 'business_office', 'therapy', 'social_services'] as const;
// SPEC §5.1 human transitions this slice serves (T13 amend and the co-sign arrive with the next slice).
const TRANSITIONS = {
  hold: { t: 'T8', from: ['ready_for_review'], to: 'on_hold', event: 'referral.held' },
  request_info: { t: 'T9', from: ['ready_for_review'], to: 'info_requested', event: 'referral.info_requested' },
  escalate: { t: 'T10', from: ['ready_for_review'], to: 'escalated', event: 'referral.escalated' },
  resume: { t: 'T11', from: ['on_hold', 'info_requested', 'escalated'], to: 'ready_for_review', event: 'review.started' },
  submit: { t: 'T14', from: ['draft'], to: 'ready_for_review', event: 'review.started' },
  // T1: hand a referral with documents to the pipeline (the per-document referral.uploaded events fire on upload)
  process: { t: 'T1', from: ['draft'], to: 'processing', event: null },
} as const;
// Where staff may still add a document (T1 from draft, T6 from the review states, T4 replacing a failed one)
const UPLOAD_STATES = new Set(['draft', 'ready_for_review', 'on_hold', 'info_requested', 'escalated', 'partial_failure']);
// Classification codes staff pick at upload; the pipeline's classify stage refines them at M4
const DOCUMENT_TYPES = ['unclassified', 'face_sheet', 'discharge_summary', 'history_and_physical', 'medication_list', 'physician_orders', 'nursing_notes', 'therapy_notes', 'lab_results', 'insurance'] as const;
const SHA256 = /^[0-9a-f]{64}$/;
type Action = keyof typeof TRANSITIONS;

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) { super(code); this.status = status; this.code = code; }
}

interface Caller { userId: string; role: string; organizationId: string }

/** Bind the facility, find its organisation, bind it, and read the caller's role there. 404 when any is invisible. */
async function enter(q: Query, facilityId: string, userId: string): Promise<Caller> {
  await bindFacility(q, facilityId);
  const fac = await q<{ organization_id: string }>('SELECT organization_id FROM facilities WHERE facility_id = $1', [facilityId]);
  const organizationId = fac.rows[0]?.organization_id;
  if (!organizationId) throw new HttpError(404, 'not_found');
  await bindOrganization(q, organizationId);
  const member = await q<{ role: string }>(
    `SELECT r.role FROM user_facility_roles r JOIN users u ON u.id = r.user_id
     WHERE r.user_id = $1 AND r.facility_id = $2 ORDER BY (r.role = 'facility_admin') DESC, (r.role = 'admissions_reviewer') DESC LIMIT 1`,
    [userId, facilityId]);
  const role = member.rows[0]?.role;
  if (!role) throw new HttpError(404, 'not_found'); // a foreign facility is invisible, not forbidden (SPEC §12 XF-11)
  // the acting user, for the database's actor checks (0010): every actor column the app writes must equal it
  await q("SELECT set_config('app.user_id', $1, true)", [userId]);
  return { userId, role, organizationId };
}

const audit = (q: Query, facilityId: string, userId: string, action: string, entityType: string, entityId: string) =>
  q('INSERT INTO audit_log (facility_id, actor, action, entity_type, entity_id) VALUES ($1, $2, $3, $4, $5)', [facilityId, `user:${userId}`, action, entityType, entityId]);
const emit = (q: Query, facilityId: string, referralId: string, userId: string, event: string, attrs: Record<string, unknown>) =>
  q('INSERT INTO product_events (facility_id, referral_id, actor, event, attrs) VALUES ($1, $2, $3, $4, $5)', [facilityId, referralId, `user:${userId}`, event, attrs]);

/** Current assertions: every fact row no later row supersedes. */
async function currentFacts(q: Query, facilityId: string, referralId: string): Promise<(Fact & { id: string; created_by: string })[]> {
  const { rows } = await q<Record<string, unknown>>(
    `SELECT f.id, f.key, f.value, f.source, f.evidence, f.note, to_char(f.as_of_date, 'YYYY-MM-DD') AS as_of_date, f.is_critical,
            f.specially_protected, f.single_source, f.confidence_band, f.created_by
     FROM facts f
     WHERE f.facility_id = $1 AND f.referral_id = $2
       AND NOT EXISTS (SELECT 1 FROM facts n WHERE n.facility_id = f.facility_id AND n.supersedes = f.id)
     ORDER BY f.key`, [facilityId, referralId]);
  return rows as unknown as (Fact & { id: string; created_by: string })[];
}

/** The facility's settings; a stored rule set the engine refuses is 409 rule_set_refused, never a 500. */
async function loadSettings(q: Query, facilityId: string, organizationId: string, at?: { ruleSetVersion: number; profileVersion: number }): Promise<RuleSet | null> {
  try {
    return await loadStored(q, facilityId, organizationId, at);
  } catch (err) {
    if (err instanceof RuleSetRefused) throw new HttpError(409, 'rule_set_refused');
    throw err;
  }
}

/** The facility's settings, or 409 when it has none: a facility without a rule set and profile cannot evaluate. */
async function settingsOrRefuse(q: Query, facilityId: string, organizationId: string): Promise<RuleSet> {
  const rs = await loadSettings(q, facilityId, organizationId);
  if (!rs) throw new HttpError(409, 'facility_not_configured');
  return rs;
}

interface EvaluationRow { id: string; outcome: string; clinical_outcome: string; rule_set_version: number; facility_profile_version: number; trace: { confirmation_set?: string[]; disagreements?: string[] } }

const latestEvaluation = async (q: Query, facilityId: string, referralId: string) => (await q<EvaluationRow & Record<string, unknown>>(
  `SELECT id, raw, outcome, clinical_outcome, financial_status, sub_reasons, trace, engine_version, rule_set_version, facility_profile_version
   FROM evaluations WHERE facility_id = $1 AND referral_id = $2 ORDER BY evaluated_at DESC LIMIT 1`, [facilityId, referralId])).rows[0];

const isKnown = (v: FactValue) => v.value !== null && v.value !== 'unknown';

/** 2.7: each fact the decision rests on, whether a person has stated it (manual entry: a current user fact), and
 *  whether what they stated is a known value. */
const confirmation = (keys: string[], facts: { key: string; source: string; value: FactValue }[]) => keys.map((key) => {
  const f = facts.find((x) => x.key === key && x.source === 'user');
  return { key, confirmed: f !== undefined, known: f !== undefined && isKnown(f.value) };
});

/** Admit is reachable only by positive confirmation (§4): an Admit decision needs a stated, known value for every
 *  fact an enabled hard-stop or review rule reads, as well as the evaluation's own confirmation set. */
const admitKeys = (ruleSet: RuleSet, ev: EvaluationRow) => [...new Set([
  ...(ev.trace.confirmation_set ?? []),
  ...ruleSet.rules.filter((r) => r.enabled && (r.kind === 'hard_stop' || r.kind === 'review')).flatMap((r) => r.inputs).filter((k) => !k.startsWith('facility.')),
])].sort();

/** A hard-stop input with two known values in its history, where a person stated one of them (§5.1 T12, open question
 *  24): a person's correction, of a person or of the AI. Unknown to known is a fact arriving, not a flip, and AI readings
 *  that differ with no person involved are a disagreement, not a correction. */
async function hardStopFlipped(q: Query, facilityId: string, referralId: string, ruleSet: RuleSet): Promise<boolean> {
  const keys = [...new Set(ruleSet.rules.filter((r) => r.enabled && r.kind === 'hard_stop').flatMap((r) => r.inputs))];
  const { rows } = await q<{ n: string }>(
    `SELECT count(*) AS n FROM (
       SELECT key FROM facts
       WHERE facility_id = $1 AND referral_id = $2 AND key = ANY($3) AND value->'value' <> 'null'::jsonb AND value->>'value' <> 'unknown'
       GROUP BY key HAVING count(DISTINCT value->'value') > 1 AND bool_or(source = 'user')) flipped`, [facilityId, referralId, keys]);
  if (Number(rows[0]!.n) > 0) return true;
  // a dispute over a hard-stop input that a person settled counts too (founder ruling 2026-10-30): the worker keeps only the
  // Unknown, so the two values never appear in the fact history. Settled: disputed once, no longer on the latest evaluation.
  const settled = await q<{ n: string }>(
    `SELECT count(*) AS n FROM facts f WHERE f.facility_id = $1 AND f.referral_id = $2 AND f.source = 'user' AND f.key = ANY($3)
       AND EXISTS (SELECT 1 FROM evaluations e WHERE e.facility_id = f.facility_id AND e.referral_id = f.referral_id AND e.trace->'disagreements' ? f.key)
       AND NOT coalesce((SELECT e.trace->'disagreements' ? f.key FROM evaluations e WHERE e.facility_id = f.facility_id AND e.referral_id = f.referral_id ORDER BY e.evaluated_at DESC LIMIT 1), false)`, [facilityId, referralId, keys]);
  return Number(settled.rows[0]!.n) > 0;
}

/** Evaluate the current facts under the current settings and store the immutable snapshot (§14.2, I6). */
async function reevaluate(q: Query, fid: string, rid: string, ruleSet: RuleSet, user: string, changedFactCount: number, stated?: string): Promise<void> {
  const referralDate = todayIso();
  const facts = await currentFacts(q, fid, rid);
  const docs = await q<{ open: string }>(
    "SELECT count(*) AS open FROM documents WHERE facility_id = $1 AND referral_id = $2 AND status NOT IN ('processed', 'not_applicable')", [fid, rid]);
  const processingComplete = Number(docs.rows[0]!.open) === 0;
  const result = evaluate({ facts, profile: ruleSet.profile, rules: ruleSet.rules, referral_date: referralDate, processing_complete: processingComplete });
  const prev = await q<{ id: string; disagreements: string[] | null }>("SELECT id, trace->'disagreements' AS disagreements FROM evaluations WHERE facility_id = $1 AND referral_id = $2 ORDER BY evaluated_at DESC, id LIMIT 1", [fid, rid]);
  const { trace, missing, conflicts, blocking, empty_profile_keys, resolution_step, confirmation_set } = result;
  // keys the pipeline left Unknown because documents disagree, and keys where a document contradicts a person, carried
  // on every evaluation until a person states that key again
  const disagreements = [...new Set([...facts.filter((f) => f.source === 'ai' && (f.value.value === null || f.value.value === 'unknown')).map((f) => f.key), ...(prev.rows[0]?.disagreements ?? [])])].filter((k) => k !== stated).sort();
  const ev = await q<{ id: string }>(
    `INSERT INTO evaluations (facility_id, referral_id, previous_evaluation_id, raw, outcome, clinical_outcome, financial_status, sub_reasons, trace,
       criteria_document_ref, rule_set_version, facility_profile_version, model_id, prompt_version, extractor_version, ocr_engine_version, engine_version)
     VALUES ($1, $2, $3, false, $4, $5, $6, $7, $8, $9, $10, $11, 'none', 'none', 'manual-entry', 'none', $12) RETURNING id`,
    [fid, rid, prev.rows[0]?.id ?? null, result.outcome, result.clinical_outcome, result.financial_status, result.sub_reasons,
      // every input of evaluate() beyond the facts is pinned, so the snapshot replays (I6)
      { resolution_step, trace, missing, conflicts, disagreements, blocking, empty_profile_keys, confirmation_set, inputs: { referral_date: referralDate, processing_complete: processingComplete, fact_ids: facts.map((f) => f.id) } }, ruleSet.criteriaRef, ruleSet.ruleSetVersion, ruleSet.profileVersion, ENGINE_VERSION]);
  await audit(q, fid, user, 'evaluation.created', 'evaluation', ev.rows[0]!.id);
  await emit(q, fid, rid, user, 'evaluation.created', {
    evaluation_id: ev.rows[0]!.id, ...(prev.rows[0] ? { previous_evaluation_id: prev.rows[0].id } : {}), raw: false, outcome: result.outcome, changed_fact_count: changedFactCount,
  });
}

/** A hard stop decided this referral at some point (only hard stops produce Do Not Admit, §4). An Admit after that
 *  needs the co-sign however the hard stop cleared: a corrected fact, or a facility setting changed and
 *  re-evaluated (security review of PR #25; engineering default, founder to confirm). */
const hardStopEverFired = async (q: Query, facilityId: string, referralId: string) => (await q<{ n: string }>(
  "SELECT count(*) AS n FROM evaluations WHERE facility_id = $1 AND referral_id = $2 AND 'do_not_admit' IN (outcome, clinical_outcome)",
  [facilityId, referralId])).rows[0]!.n !== '0';

/** This user's review of this referral that has started and not ended: the latest start, if no end came after it. */
async function openReviewStart(q: Query, facilityId: string, referralId: string, userId: string): Promise<string | null> {
  const { rows } = await q<{ event: string; at: string }>(
    `SELECT event, at FROM product_events WHERE facility_id = $1 AND referral_id = $2 AND actor = $3 AND event IN ('review.started', 'review.ended')
     ORDER BY at DESC LIMIT 1`, [facilityId, referralId, `user:${userId}`]);
  return rows[0]?.event === 'review.started' ? new Date(rows[0].at).toISOString() : null;
}

async function referralView(q: Query, facilityId: string, referralId: string, ruleSet: RuleSet | null, who: Caller | null = null) {
  const role = who?.role ?? '';
  const ref = await q<{ id: string; status: string }>('SELECT id, status FROM referrals WHERE facility_id = $1 AND id = $2', [facilityId, referralId]);
  if (!ref.rows[0]) throw new HttpError(404, 'not_found');
  const status = ref.rows[0].status;
  const facts = await currentFacts(q, facilityId, referralId);
  const ev = await latestEvaluation(q, facilityId, referralId);
  const history = await q<Record<string, unknown>>(
    `SELECT transition, from_status, to_status, note, department, requested_items, created_by, created_at
     FROM referral_transitions WHERE facility_id = $1 AND referral_id = $2 ORDER BY created_at`, [facilityId, referralId]);
  // every decision, newest first: the original and each amendment (T13), none ever changed
  const decisions = await q<{ id: string } & Record<string, unknown>>(
    `SELECT id, evaluation_id, recommended_outcome, decision, override_reason, decided_by, cosigned_by, amends_decision_id, amendment_reason, decided_at
     FROM decisions WHERE facility_id = $1 AND referral_id = $2 ORDER BY decided_at DESC`, [facilityId, referralId]);
  const closed = status === 'finalized' || status === 'amended';
  const canWrite = WRITE_ROLES.has(role);
  // documents: what staff need to see, never the storage key
  const docs = (await q<{ id: string; type: string; status: string; pages: number | null; not_applicable_reason: string | null; created_at: string }>(
    `SELECT id, type, status, pages, not_applicable_reason, created_at FROM documents
     WHERE facility_id = $1 AND referral_id = $2 ORDER BY created_at`, [facilityId, referralId])).rows;
  const waiting = docs.some((d) => d.status === 'uploaded');
  const failed = docs.some((d) => d.status === 'failed' || d.status === 'unreadable');
  // the evaluation was made under settings that have since changed: decide only after re-evaluating
  const outdated = !!ev && !!ruleSet && (ev.rule_set_version !== ruleSet.ruleSetVersion || ev.facility_profile_version !== ruleSet.profileVersion);
  const flipped = ruleSet ? await hardStopFlipped(q, facilityId, referralId, ruleSet) : false;
  // the latest co-sign request, while it can still be carried out: no decision yet, on the latest evaluation,
  // made under the current settings
  // shown with the requester's name (staff, not patient data), and only while the requester can still decide here
  const pending = (await q<{ id: string; evaluation_id: string; decision: string; override_reason: string | null; requested_by: string; requested_by_name: string; created_at: string; active: boolean; amends_decision_id: string | null; amendment_reason: string | null }>(
    `SELECT d.id, d.evaluation_id, d.decision, d.override_reason, d.requested_by, u.display_name AS requested_by_name, d.created_at,
            d.amends_decision_id, d.amendment_reason,
            EXISTS (SELECT 1 FROM user_facility_roles r WHERE r.user_id = d.requested_by AND r.facility_id = d.facility_id
                    AND r.role IN ('facility_admin', 'admissions_reviewer')
                    AND (d.amends_decision_id IS NULL OR r.role = 'facility_admin')) AS active
     FROM decision_requests d JOIN users u ON u.id = d.requested_by
     WHERE d.facility_id = $1 AND d.referral_id = $2 ORDER BY d.created_at DESC LIMIT 1`, [facilityId, referralId])).rows[0];
  // an original request stands while the referral is in review under current settings; an amendment request while
  // it still amends the latest decision (the facts are frozen after finalize)
  const pendingRequest = pending && pending.active && ev?.id === pending.evaluation_id
    && (pending.amends_decision_id === null ? status === 'ready_for_review' && !outdated : closed && pending.amends_decision_id === decisions.rows[0]?.id)
    ? { id: pending.id, evaluation_id: pending.evaluation_id, decision: pending.decision, override_reason: pending.override_reason,
        requested_by: pending.requested_by, requested_by_name: pending.requested_by_name, created_at: pending.created_at,
        amends_decision_id: pending.amends_decision_id, amendment_reason: pending.amendment_reason,
        can_cosign: role === 'facility_admin' && who?.userId !== pending.requested_by } : null;
  const explanations = Object.fromEntries((ruleSet?.rules ?? []).map((r) => [r.id, (r as { explanation?: string }).explanation ?? null]));
  return {
    referral: ref.rows[0],
    facts: facts.map((f) => ({ id: f.id, key: f.key, value: f.value, source: f.source, note: f.source === 'user' ? f.note : null, as_of_date: f.as_of_date })),
    form: { fact_keys: ruleSet?.factKeys ?? [], note_max: NOTE_MAX, configured: ruleSet !== null, departments: DEPARTMENTS },
    evaluation: ev ?? null,
    rule_explanations: explanations,
    confirmation: confirmation(ev?.trace.confirmation_set ?? [], facts),
    // keys an Admit decision would also need stated as known values (shown when the recommendation is not Admit)
    admit_requires: ev && ruleSet ? [...new Set([...confirmation(admitKeys(ruleSet, ev), facts).filter((c) => !c.known).map((c) => c.key), ...(ev.trace.disagreements ?? [])])] : [],
    evaluation_outdated: outdated,
    // decisions that need an Admin co-sign: a hard stop overridden to Admit; any decision after a flipped hard-stop input
    cosign: { admit: await hardStopEverFired(q, facilityId, referralId), any: flipped },
    pending_request: pendingRequest,
    transitions: history.rows,
    documents: docs,
    document_types: DOCUMENT_TYPES,
    decision: decisions.rows[0] ?? null,
    decisions: decisions.rows,
    // what this caller may do now; the API and the database check each again on the write
    actions: canWrite ? [
      ...(Object.keys(TRANSITIONS) as Action[]).filter((a) => (TRANSITIONS[a].from as readonly string[]).includes(status)
        // manual entry (T14) has no documents; processing (T1) needs one waiting
        && (a !== 'submit' || docs.length === 0) && (a !== 'process' || waiting)),
      ...(UPLOAD_STATES.has(status) ? ['upload'] : []),
      ...(status === 'partial_failure' && failed ? ['resolve_failures'] : []),
      ...(outdated && OPEN_STATES.has(status) ? ['reevaluate'] : []),
      // finalize covers both paths: a decision that needs a co-sign is filed as a request instead
      ...(status === 'ready_for_review' && ev && !outdated ? ['finalize'] : []),
      ...(pendingRequest?.can_cosign ? ['cosign'] : []),
      ...(closed && ev && role === 'facility_admin' ? ['amend'] : []),
    ] : [],
  };
}

export function registerRoutes(app: FastifyInstance, deps: { tx: Tx; storage: Storage | null; enqueue?: Enqueue | null }): void {
  const { tx, storage } = deps;
  // shortcut: a referral stays in processing if this send fails after the commit; the watchdog in slice 6 (4.3) re-sends
  const enqueue = async (fid: string, rid: string) => {
    try { await deps.enqueue?.(fid, rid); } catch {
      console.error(JSON.stringify({ event: 'enqueue.failed', facility_id: fid, referral_id: rid }));
      throw new HttpError(503, 'queue_unavailable');
    }
  };
  const fail = (reply: FastifyReply, err: unknown) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.code });
    // A database refusal (RLS, CHECK, trigger) is a rejected write; its message is never echoed (it can carry ids).
    const code = (err as { code?: string }).code;
    if (code && /^(23|42501|P0001|22)/.test(code)) return reply.code(422).send({ error: 'rejected' });
    app.log.error({ code }, 'unexpected error');
    return reply.code(500).send({ error: 'internal' });
  };
  const caller = (headers: Record<string, string | string[] | undefined>) => {
    const user = userFromHeaders(headers);
    if (!user) throw new HttpError(401, 'unauthenticated');
    return user;
  };
  const ids = <P extends Record<string, string>>(params: P): P => {
    for (const v of Object.values(params)) if (!UUID.test(v)) throw new HttpError(404, 'not_found');
    return params;
  };

  app.post<{ Params: { fid: string } }>('/api/facilities/:fid/referrals', async (req, reply) => {
    try {
      const user = caller(req.headers);
      const { fid } = ids(req.params);
      const body = await tx(async (q) => {
        const who = await enter(q, fid, user);
        if (!WRITE_ROLES.has(who.role)) throw new HttpError(403, 'forbidden');
        const { rows } = await q<{ id: string }>('INSERT INTO referrals (facility_id) VALUES ($1) RETURNING id', [fid]);
        const id = rows[0]!.id;
        await audit(q, fid, user, 'referral.created', 'referral', id);
        await emit(q, fid, id, user, 'referral.received', {});
        return referralView(q, fid, id, await loadSettings(q, fid, who.organizationId), who);
      });
      return reply.code(201).send(body);
    } catch (err) { return fail(reply, err); }
  });

  // --- review time (M3 slice 7; dev-alignment 3.3): active time on a referral, reported by the browser when the
  // Reviewer leaves it. Counted only while the page is visible and the person is interacting; a measurement for
  // the pilot, not a control, so the browser's figure is taken as reported within a sane cap.
  const MAX_ACTIVE_MS = 8 * 60 * 60 * 1000;
  app.post<{ Params: { fid: string; rid: string }; Body: unknown }>('/api/facilities/:fid/referrals/:rid/review-time', async (req, reply) => {
    try {
      const user = caller(req.headers);
      const { fid, rid } = ids(req.params);
      const ms = ((req.body ?? {}) as { active_ms?: unknown }).active_ms;
      if (!Number.isInteger(ms) || (ms as number) < 1 || (ms as number) > MAX_ACTIVE_MS) throw new HttpError(400, 'invalid_review_time');
      limit(user);
      await tx(async (q) => {
        const who = await enter(q, fid, user);
        if (!READ_ROLES.has(who.role)) throw new HttpError(403, 'forbidden');
        const ref = await q('SELECT 1 FROM referrals WHERE facility_id = $1 AND id = $2', [fid, rid]);
        if (!ref.rowCount) throw new HttpError(404, 'not_found');
        // one end per start, by the same person, and never more time than has passed since that start
        const started = await openReviewStart(q, fid, rid, user);
        if (!started) throw new HttpError(409, 'no_review_open');
        const elapsed = Date.now() - Date.parse(started);
        await emit(q, fid, rid, user, 'review.ended', { screen: 'review', active_ms: Math.min(ms as number, Math.max(1, elapsed)) });
      });
      return reply.code(204).send();
    } catch (err) { return fail(reply, err); }
  });

  // --- the referral queue (M3 slice 6): the facility's referrals by status, oldest waiting first ---------------
  // Ids, statuses, codes and counts only: no fact values, notes or reasons, so a list never carries patient data.
  const QUEUE_FILTERS: Record<string, readonly string[]> = {
    // what needs a person now (the pipeline owns processing)
    open: ['draft', 'ready_for_review', 'on_hold', 'info_requested', 'escalated', 'partial_failure'],
    processing: ['processing'],
    closed: ['finalized', 'amended'],
  };
  const QUEUE_LIMIT = 100;
  /** Exactly the timestamp text the API issues as a cursor (Postgres' timestamptz output), and a real date. */
  const realTimestamp = (t: string) => {
    const m = /^(\d{4})-(\d\d)-(\d\d) \d\d:\d\d:\d\d(\.\d{1,6})?[+-]\d\d(:\d\d)?$/.exec(t);
    if (!m) return false;
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
  };
  app.get<{ Params: { fid: string }; Querystring: { filter?: string; after?: string } }>('/api/facilities/:fid/referrals', async (req, reply) => {
    try {
      const user = caller(req.headers);
      const { fid } = ids(req.params);
      const filter = req.query.filter ?? 'open';
      const states = typeof filter === 'string' && Object.hasOwn(QUEUE_FILTERS, filter) ? QUEUE_FILTERS[filter] : undefined;
      // paging: an opaque cursor the API returned, "<updated_at as Postgres prints it>|<referral id>"; rows are ordered
      // by both, so ties never skip or repeat a referral
      const after = req.query.after;
      const parts = typeof after === 'string' ? after.split('|') : [];
      const [cursorAt, cursorId] = parts;
      if (!states || (after !== undefined && (parts.length !== 2 || !cursorAt || !realTimestamp(cursorAt) || !cursorId || !UUID.test(cursorId)))) throw new HttpError(400, 'invalid_query');
      return reply.send(await tx(async (q) => {
        const who = await enter(q, fid, user);
        if (!READ_ROLES.has(who.role)) throw new HttpError(403, 'forbidden');
        // open referrals: longest waiting first; closed ones: most recent first. A referral that changes while someone
        // pages (an amendment, a status move) moves in the order: it can reappear or slip past the cursor until a reload.
        const order = filter === 'closed' ? 'DESC' : 'ASC';
        // the page is chosen first (served by the referrals_queue index), and only its rows get the lookups below
        const { rows } = await q<Record<string, unknown>>(
          `WITH page AS (
             SELECT r.* FROM referrals r
             WHERE r.facility_id = $1 AND r.status = ANY($2::referral_status[])
               AND ($3::timestamptz IS NULL OR (r.updated_at, r.id) ${order === 'ASC' ? '>' : '<'} ($3::timestamptz, $4::uuid))
             ORDER BY r.updated_at ${order}, r.id ${order}
             LIMIT ${QUEUE_LIMIT + 1})
           SELECT r.id, r.status, r.referral_type, r.created_at, r.updated_at, r.updated_at::text AS cursor_at,
                  e.outcome, e.sub_reasons,
                  (SELECT count(*)::int FROM documents d WHERE d.facility_id = r.facility_id AND d.referral_id = r.id AND d.status <> 'not_applicable') AS documents,
                  (SELECT count(*)::int FROM documents d WHERE d.facility_id = r.facility_id AND d.referral_id = r.id AND d.status IN ('failed', 'unreadable')) AS failed_documents,
                  -- a filed decision waits for a co-sign: the latest request, newer than any decision, on the latest evaluation
                  EXISTS (SELECT 1 FROM decision_requests dr
                          WHERE dr.facility_id = r.facility_id AND dr.referral_id = r.id AND dr.evaluation_id = e.id
                            AND dr.created_at > coalesce((SELECT max(dd.decided_at) FROM decisions dd WHERE dd.facility_id = r.facility_id AND dd.referral_id = r.id), '-infinity')
                            AND NOT EXISTS (SELECT 1 FROM decision_requests n WHERE n.facility_id = dr.facility_id AND n.referral_id = dr.referral_id AND n.created_at > dr.created_at)) AS cosign_waiting
           FROM page r
           LEFT JOIN LATERAL (SELECT id, outcome, sub_reasons FROM evaluations ev
                              WHERE ev.facility_id = r.facility_id AND ev.referral_id = r.id ORDER BY ev.evaluated_at DESC LIMIT 1) e ON true
           ORDER BY r.updated_at ${order}, r.id ${order}`, [fid, states, cursorAt ?? null, cursorId ?? null]);
        // I4: a list of a facility's referrals is a read of referral data, audited like opening one
        await audit(q, fid, user, 'referrals.listed', 'facility', fid);
        const page = rows.slice(0, QUEUE_LIMIT);
        const last = page.at(-1);
        return {
          filter,
          referrals: page.map((row) => Object.fromEntries(Object.entries(row).filter(([k]) => k !== 'cursor_at'))),
          next: rows.length > QUEUE_LIMIT && last ? `${last['cursor_at'] as string}|${last['id'] as string}` : null,
        };
      }));
    } catch (err) { return fail(reply, err); }
  });

  app.get<{ Params: { fid: string; rid: string } }>('/api/facilities/:fid/referrals/:rid', async (req, reply) => {
    try {
      const user = caller(req.headers);
      const { fid, rid } = ids(req.params);
      return reply.send(await tx(async (q) => {
        const who = await enter(q, fid, user);
        if (!READ_ROLES.has(who.role)) throw new HttpError(403, 'forbidden');
        const view = await referralView(q, fid, rid, await loadSettings(q, fid, who.organizationId), who);
        await audit(q, fid, user, 'referral.viewed', 'referral', rid); // I4: reads of patient data are audited (1.10)
        // 3.3: per-user review time starts here, once: reopening a referral already under review adds nothing
        if (!(await openReviewStart(q, fid, rid, user))) await emit(q, fid, rid, user, 'review.started', { screen: 'review' });
        return view;
      }));
    } catch (err) { return fail(reply, err); }
  });

  app.post<{ Params: { fid: string; rid: string }; Body: unknown }>('/api/facilities/:fid/referrals/:rid/facts', async (req, reply) => {
    try {
      const user = caller(req.headers);
      const { fid, rid } = ids(req.params);
      const b = (req.body ?? {}) as { key?: unknown; value?: unknown; note?: unknown; as_of_date?: unknown };
      const body = await tx(async (q) => {
        const who = await enter(q, fid, user);
        if (!WRITE_ROLES.has(who.role)) throw new HttpError(403, 'forbidden');
        const ruleSet = await settingsOrRefuse(q, fid, who.organizationId);
        const spec = ruleSet.factKeys.find((k) => k.key === b.key);
        const value = spec ? parseFactValue(b.value, spec.type) : null;
        const note = typeof b.note === 'string' ? b.note.trim() : '';
        const asOf = b.as_of_date === undefined || b.as_of_date === null ? null : b.as_of_date;
        const referralDate = todayIso();
        // a date after the referral date is not a fact about this referral (a future as_of would also read as silence)
        if (!spec || !value || !note || note.length > NOTE_MAX || (asOf !== null && (typeof asOf !== 'string' || !isRealDate(asOf) || asOf > referralDate))) {
          throw new HttpError(400, 'invalid_fact');
        }
        // Row lock: fact writes on one referral are serialised, so "the current assertion" and "the latest
        // evaluation" read below cannot move under us (0007 is the database backstop for the same race).
        const ref = await q<{ status: string }>('SELECT status FROM referrals WHERE facility_id = $1 AND id = $2 FOR UPDATE', [fid, rid]);
        if (!ref.rows[0]) throw new HttpError(404, 'not_found');
        if (!OPEN_STATES.has(ref.rows[0].status)) throw new HttpError(409, 'referral_not_open');

        const before = await currentFacts(q, fid, rid);
        const current = before.filter((f) => f.key === spec.key);
        if (current.length > 1) throw new HttpError(409, 'fact_lineage_forked'); // only reachable from data written before 0007
        const previous = current[0];
        // A key that was ever specially protected stays protected: the flag carries to every correction, and the
        // key never appears in an event (§14.1).
        const everProtected = await q<{ p: boolean }>('SELECT bool_or(specially_protected) AS p FROM facts WHERE facility_id = $1 AND referral_id = $2 AND key = $3', [fid, rid, spec.key]);
        const protectedKey = everProtected.rows[0]?.p === true;
        const { rows } = await q<{ id: string }>(
          `INSERT INTO facts (facility_id, referral_id, key, value, source, note, as_of_date, is_critical, specially_protected, supersedes, created_by)
           VALUES ($1, $2, $3, $4, 'user', $5, $6, $7, $8, $9, $10) RETURNING id`,
          [fid, rid, spec.key, value, note, asOf, spec.critical, protectedKey, previous?.id ?? null, `user:${user}`]);
        const factId = rows[0]!.id;
        await audit(q, fid, user, previous ? 'fact.corrected' : 'fact.entered', 'fact', factId);
        await emit(q, fid, rid, user, previous ? 'fact.corrected' : 'fact.entered', { ...(protectedKey ? {} : { fact_key: spec.key }), decisive: spec.critical });

        // Re-evaluate on the current fact set (§14.2: every fact change produces a new immutable snapshot).
        await reevaluate(q, fid, rid, ruleSet, user, 1, spec.key);
        return referralView(q, fid, rid, ruleSet, who);
      });
      return reply.code(201).send(body);
    } catch (err) { return fail(reply, err); }
  });

  // --- review transitions (M3 slice 2; SPEC §5.1 T8–T11, T14): one checked, audited row moves the status -------
  app.post<{ Params: { fid: string; rid: string }; Body: unknown }>('/api/facilities/:fid/referrals/:rid/transitions', async (req, reply) => {
    try {
      const user = caller(req.headers);
      const { fid, rid } = ids(req.params);
      const b = (req.body ?? {}) as { action?: unknown; note?: unknown; department?: unknown; items?: unknown };
      const action = typeof b.action === 'string' && Object.hasOwn(TRANSITIONS, b.action) ? b.action as Action : null;
      if (!action) throw new HttpError(400, 'invalid_transition');
      const spec = TRANSITIONS[action];
      // a note on hold, escalate, resume (required) and request_info (optional); never on submit
      const note = action !== 'submit' && action !== 'process' && typeof b.note === 'string' && b.note.trim() ? b.note.trim() : null;
      const department = action === 'escalate' && typeof b.department === 'string' && (DEPARTMENTS as readonly string[]).includes(b.department) ? b.department : null;
      const items = action === 'request_info' && Array.isArray(b.items) && b.items.every((i) => typeof i === 'string') ? [...new Set(b.items as string[])] : [];
      const needsNote = action === 'hold' || action === 'escalate' || action === 'resume';
      if ((needsNote && !note) || (note && note.length > NOTE_MAX) || (action === 'escalate' && !department) || (action === 'request_info' && (items.length < 1 || items.length > 20))) {
        throw new HttpError(400, 'invalid_transition');
      }
      const body = await tx(async (q) => {
        const who = await enter(q, fid, user);
        if (!WRITE_ROLES.has(who.role)) throw new HttpError(403, 'forbidden');
        const ruleSet = await loadSettings(q, fid, who.organizationId);
        // requested items are fact keys the rule set reads (6.1), never free text
        if (action === 'request_info' && !items.every((i) => ruleSet?.factKeys.some((k) => k.key === i))) throw new HttpError(400, 'invalid_transition');
        const ref = await q<{ status: string }>('SELECT status FROM referrals WHERE facility_id = $1 AND id = $2 FOR UPDATE', [fid, rid]);
        if (!ref.rows[0]) throw new HttpError(404, 'not_found');
        const from = ref.rows[0].status;
        if (!(spec.from as readonly string[]).includes(from)) throw new HttpError(409, 'transition_not_allowed');
        if (action === 'submit') {
          const ev = await latestEvaluation(q, fid, rid);
          const docs = await q<{ n: string }>('SELECT count(*) AS n FROM documents WHERE facility_id = $1 AND referral_id = $2', [fid, rid]);
          if (!ev || Number(docs.rows[0]!.n) > 0) throw new HttpError(409, 'transition_not_allowed');
        }
        if (action === 'process') {
          const docs = await q<{ n: string }>("SELECT count(*) AS n FROM documents WHERE facility_id = $1 AND referral_id = $2 AND status = 'uploaded'", [fid, rid]);
          if (Number(docs.rows[0]!.n) === 0) throw new HttpError(409, 'transition_not_allowed');
        }
        await q(
          `INSERT INTO referral_transitions (facility_id, referral_id, transition, from_status, to_status, note, department, requested_items, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [fid, rid, spec.t, from, spec.to, note, department, items, `user:${user}`]);
        if (spec.event) await emit(q, fid, rid, user, spec.event,
          action === 'request_info' ? { items_requested: items.length } : action === 'escalate' ? { department } : spec.event === 'review.started' ? { screen: 'review' } : {});
        return referralView(q, fid, rid, ruleSet, who);
      });
      if (action === 'process') await enqueue(fid, rid);
      return reply.code(201).send(body);
    } catch (err) { return fail(reply, err); }
  });

  // --- re-evaluate after a settings change (the facts are unchanged; the settings are not) ---------------------
  app.post<{ Params: { fid: string; rid: string } }>('/api/facilities/:fid/referrals/:rid/evaluate', async (req, reply) => {
    try {
      const user = caller(req.headers);
      const { fid, rid } = ids(req.params);
      const body = await tx(async (q) => {
        const who = await enter(q, fid, user);
        if (!WRITE_ROLES.has(who.role)) throw new HttpError(403, 'forbidden');
        const ruleSet = await settingsOrRefuse(q, fid, who.organizationId);
        const ref = await q<{ status: string }>('SELECT status FROM referrals WHERE facility_id = $1 AND id = $2 FOR UPDATE', [fid, rid]);
        if (!ref.rows[0]) throw new HttpError(404, 'not_found');
        if (!OPEN_STATES.has(ref.rows[0].status)) throw new HttpError(409, 'referral_not_open');
        const ev = await latestEvaluation(q, fid, rid);
        if (!ev || (ev.rule_set_version === ruleSet.ruleSetVersion && ev.facility_profile_version === ruleSet.profileVersion)) throw new HttpError(409, 'evaluation_current');
        await reevaluate(q, fid, rid, ruleSet, user, 0);
        return referralView(q, fid, rid, ruleSet, who);
      });
      return reply.code(201).send(body);
    } catch (err) { return fail(reply, err); }
  });

  /** Every check a decision passes before it is recorded or filed for co-sign (§5.1 T12; 2.7; I5). */
  const checkDecision = async (q: Query, fid: string, org: string, rid: string, ruleSet: RuleSet, evaluationId: string, decision: 'admit' | 'do_not_admit', reason: string | null, amend = false) => {
    const ref = await q<{ status: string }>('SELECT status FROM referrals WHERE facility_id = $1 AND id = $2 FOR UPDATE', [fid, rid]);
    if (!ref.rows[0]) throw new HttpError(404, 'not_found');
    const status = ref.rows[0].status;
    if (amend ? status !== 'finalized' && status !== 'amended' : status !== 'ready_for_review') throw new HttpError(409, 'transition_not_allowed');
    const ev = await latestEvaluation(q, fid, rid);
    // the decision an amendment corrects: the referral's latest
    const latestDecision = amend ? (await q<{ id: string }>('SELECT id FROM decisions WHERE facility_id = $1 AND referral_id = $2 ORDER BY decided_at DESC LIMIT 1', [fid, rid])).rows[0]?.id ?? null : null;
    // after finalize the facts are frozen and the referral cannot be re-evaluated, so an amendment decides on the
    // recorded evaluation even if the settings changed since
    // ...but the Admit and flip gates then hold under both the settings the evaluation was made under and the
    // current ones: switching a rule off and back cannot let an Admit through (security review of PR #26)
    if (amend && ev && ev.id === evaluationId) {
      const pinned = await loadSettings(q, fid, org, { ruleSetVersion: ev.rule_set_version, profileVersion: ev.facility_profile_version });
      if (!pinned) throw new HttpError(409, 'rule_set_refused');
      return finishCheck(q, fid, rid, [ruleSet, pinned], ev, decision, reason, status, latestDecision);
    }
    // decided on what the Reviewer saw, under the settings in force now: anything newer is refused
    // shortcut: settings are read before the referral lock and a settings save takes no referral lock, so a save
    // committing in that gap is not seen by this decision; close it (re-read versions under a shared lock) before pilot
    if (!ev || ev.id !== evaluationId || ev.rule_set_version !== ruleSet.ruleSetVersion || ev.facility_profile_version !== ruleSet.profileVersion) {
      throw new HttpError(409, 'evaluation_stale');
    }
    return finishCheck(q, fid, rid, [ruleSet], ev, decision, reason, status, latestDecision);
  };
  const finishCheck = async (q: Query, fid: string, rid: string, ruleSets: RuleSet[], ev: EvaluationRow, decision: 'admit' | 'do_not_admit', reason: string | null, status: string, latestDecision: string | null) => {
    const facts = await currentFacts(q, fid, rid);
    if (!Array.isArray(ev.trace.confirmation_set) || confirmation(ev.trace.confirmation_set, facts).some((c) => !c.confirmed)) throw new HttpError(409, 'confirmation_incomplete');
    // a dispute between documents, or a document against a person, needs that fact stated again before an Admit (§3, I9)
    if (decision === 'admit' && ((ev.trace.disagreements ?? []).length > 0 || ruleSets.some((rs) => confirmation(admitKeys(rs, ev), facts).some((c) => !c.known)))) throw new HttpError(409, 'confirmation_incomplete');
    const override = decision !== ev.outcome;
    if (override !== (reason !== null)) throw new HttpError(400, override ? 'override_reason_required' : 'invalid_decision');
    // a hard stop overridden to Admit, or any decision after a flipped hard-stop input, needs an Admin co-sign
    let flipped = false;
    for (const rs of ruleSets) flipped ||= await hardStopFlipped(q, fid, rid, rs);
    const needsCosign = (decision === 'admit' && await hardStopEverFired(q, fid, rid)) || flipped;
    return { ev, override, needsCosign, status, latestDecision };
  };
  const decisionBody = (body: unknown) => {
    const b = (body ?? {}) as { evaluation_id?: unknown; decision?: unknown; override_reason?: unknown; amendment_reason?: unknown };
    // present but blank is a missing reason, not an original decision
    if (b.amendment_reason !== undefined && b.amendment_reason !== null && (typeof b.amendment_reason !== 'string' || !b.amendment_reason.trim())) throw new HttpError(400, 'amendment_reason_required');
    const amendmentReason = typeof b.amendment_reason === 'string' ? b.amendment_reason.trim() : null;
    if (amendmentReason && amendmentReason.length > NOTE_MAX) throw new HttpError(400, 'invalid_decision');
    const decision: 'admit' | 'do_not_admit' | null = b.decision === 'admit' || b.decision === 'do_not_admit' ? b.decision : null;
    const reason = typeof b.override_reason === 'string' && b.override_reason.trim() ? b.override_reason.trim() : null;
    if (!decision || typeof b.evaluation_id !== 'string' || !UUID.test(b.evaluation_id) || (reason && reason.length > NOTE_MAX)) throw new HttpError(400, 'invalid_decision');
    return { evaluationId: b.evaluation_id, decision, reason, amendmentReason };
  };
  /** Record the decision and finalize (T12) as the acting user: the decider, or the co-signer of a request. */
  /** Record the decision as the acting user (the decider, or the co-signer of a request) and move the referral:
   *  T12 for an original decision, T13 for an amendment of the latest one. */
  const record = async (q: Query, fid: string, rid: string, user: string, ev: EvaluationRow,
    d: { decision: string; reason: string | null; override: boolean; decidedBy: string; request: string | null; amends: string | null; amendmentReason: string | null; from: string }) => {
    const row = await q<{ id: string }>(
      `INSERT INTO decisions (facility_id, referral_id, evaluation_id, recommended_outcome, recommended_clinical_outcome, decision, override_reason, decided_by, decided_role, cosigned_by, decision_request_id, amends_decision_id, amendment_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'viewer', $9, $10, $11, $12) RETURNING id`,
      [fid, rid, ev.id, ev.outcome, ev.clinical_outcome, d.decision, d.reason, d.decidedBy, d.request ? user : null, d.request, d.amends, d.amendmentReason]);
    const decisionId = row.rows[0]!.id;
    await q(
      `INSERT INTO referral_transitions (facility_id, referral_id, transition, from_status, to_status, decision_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [fid, rid, d.amends ? 'T13' : 'T12', d.from, d.amends ? 'amended' : 'finalized', decisionId, `user:${user}`]);
    await emit(q, fid, rid, user, d.amends ? 'decision.amended' : 'decision.finalized', {
      decision_id: decisionId, evaluation_id: ev.id, outcome: d.decision, override: d.override, cosigner_present: d.request !== null,
      decisive_fact_count: (ev.trace.confirmation_set ?? []).length, decisive_viewed_count: 0, // no source documents to view in manual entry
    });
  };

  // --- finalize (T12): the decision pins the latest evaluation; the database enforces I5 again -----------------
  app.post<{ Params: { fid: string; rid: string }; Body: unknown }>('/api/facilities/:fid/referrals/:rid/decision', async (req, reply) => {
    try {
      const user = caller(req.headers);
      const { fid, rid } = ids(req.params);
      const { evaluationId, decision, reason } = decisionBody(req.body);
      const body = await tx(async (q) => {
        const who = await enter(q, fid, user);
        if (!WRITE_ROLES.has(who.role)) throw new HttpError(403, 'forbidden');
        const ruleSet = await settingsOrRefuse(q, fid, who.organizationId);
        const { ev, override, needsCosign } = await checkDecision(q, fid, who.organizationId, rid, ruleSet, evaluationId, decision, reason);
        if (needsCosign) throw new HttpError(409, 'cosign_required'); // file it with POST .../decision-requests
        await record(q, fid, rid, user, ev, { decision, reason, override, decidedBy: user, request: null, amends: null, amendmentReason: null, from: 'ready_for_review' });
        return referralView(q, fid, rid, ruleSet, who);
      });
      return reply.code(201).send(body);
    } catch (err) { return fail(reply, err); }
  });

  // --- amend (T13): an Admin records a new decision on a finalized referral; the earlier ones stay untouched -----
  app.post<{ Params: { fid: string; rid: string }; Body: unknown }>('/api/facilities/:fid/referrals/:rid/amendments', async (req, reply) => {
    try {
      const user = caller(req.headers);
      const { fid, rid } = ids(req.params);
      const { evaluationId, decision, reason, amendmentReason } = decisionBody(req.body);
      if (!amendmentReason) throw new HttpError(400, 'amendment_reason_required');
      const body = await tx(async (q) => {
        const who = await enter(q, fid, user);
        if (!WRITE_ROLES.has(who.role)) throw new HttpError(403, 'forbidden');
        if (who.role !== 'facility_admin') throw new HttpError(403, 'amend_admin_only');
        const ruleSet = await settingsOrRefuse(q, fid, who.organizationId);
        const { ev, override, needsCosign, status, latestDecision } = await checkDecision(q, fid, who.organizationId, rid, ruleSet, evaluationId, decision, reason, true);
        if (needsCosign) throw new HttpError(409, 'cosign_required'); // file it with POST .../decision-requests and an amendment_reason
        await record(q, fid, rid, user, ev, { decision, reason, override, decidedBy: user, request: null, amends: latestDecision, amendmentReason, from: status });
        return referralView(q, fid, rid, ruleSet, who);
      });
      return reply.code(201).send(body);
    } catch (err) { return fail(reply, err); }
  });

  // --- co-sign, step 1: the decider files the decision for an Admin to co-sign (0010) -------------------------
  app.post<{ Params: { fid: string; rid: string }; Body: unknown }>('/api/facilities/:fid/referrals/:rid/decision-requests', async (req, reply) => {
    try {
      const user = caller(req.headers);
      const { fid, rid } = ids(req.params);
      const { evaluationId, decision, reason, amendmentReason } = decisionBody(req.body);
      const body = await tx(async (q) => {
        const who = await enter(q, fid, user);
        if (!WRITE_ROLES.has(who.role)) throw new HttpError(403, 'forbidden');
        // an amendment_reason makes it an amendment request (T13): Admins only
        if (amendmentReason && who.role !== 'facility_admin') throw new HttpError(403, 'amend_admin_only');
        const ruleSet = await settingsOrRefuse(q, fid, who.organizationId);
        const { needsCosign, latestDecision } = await checkDecision(q, fid, who.organizationId, rid, ruleSet, evaluationId, decision, reason, amendmentReason !== null);
        if (!needsCosign) throw new HttpError(409, 'cosign_not_needed'); // record it directly
        await q(
          'INSERT INTO decision_requests (facility_id, referral_id, evaluation_id, decision, override_reason, requested_by, amends_decision_id, amendment_reason) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
          [fid, rid, evaluationId, decision, reason, user, latestDecision, amendmentReason]);
        return referralView(q, fid, rid, ruleSet, who);
      });
      return reply.code(201).send(body);
    } catch (err) { return fail(reply, err); }
  });

  // --- co-sign, step 2: a different Admin carries out the request exactly as filed, and finalizes ---------------
  app.post<{ Params: { fid: string; rid: string; qid: string } }>('/api/facilities/:fid/referrals/:rid/decision-requests/:qid/cosign', async (req, reply) => {
    try {
      const user = caller(req.headers);
      const { fid, rid, qid } = ids(req.params);
      const body = await tx(async (q) => {
        const who = await enter(q, fid, user);
        if (!WRITE_ROLES.has(who.role)) throw new HttpError(403, 'forbidden');
        if (who.role !== 'facility_admin') throw new HttpError(403, 'cosign_admin_only');
        const ruleSet = await settingsOrRefuse(q, fid, who.organizationId);
        // lock before reading the latest request, so a request filed meanwhile is seen here, not refused by the database
        await q('SELECT 1 FROM referrals WHERE facility_id = $1 AND id = $2 FOR UPDATE', [fid, rid]);
        const r = (await q<{ id: string; evaluation_id: string; decision: 'admit' | 'do_not_admit'; override_reason: string | null; requested_by: string; active: boolean; amends_decision_id: string | null; amendment_reason: string | null }>(
          `SELECT d.id, d.evaluation_id, d.decision, d.override_reason, d.requested_by, d.amends_decision_id, d.amendment_reason,
                  EXISTS (SELECT 1 FROM user_facility_roles r WHERE r.user_id = d.requested_by AND r.facility_id = d.facility_id
                          AND r.role IN ('facility_admin', 'admissions_reviewer')
                    AND (d.amends_decision_id IS NULL OR r.role = 'facility_admin')) AS active
           FROM decision_requests d WHERE d.facility_id = $1 AND d.referral_id = $2 ORDER BY d.created_at DESC LIMIT 1`, [fid, rid])).rows[0];
        // only the latest request, by someone who can still decide here; an older one was replaced
        if (!r || r.id !== qid || !r.active) throw new HttpError(409, 'request_not_current');
        if (r.requested_by === user) throw new HttpError(409, 'cosign_own_request');
        // the request is re-checked as it stands now: a new evaluation or a settings change makes it stale
        const amend = r.amends_decision_id !== null;
        const { ev, override, status, latestDecision } = await checkDecision(q, fid, who.organizationId, rid, ruleSet, r.evaluation_id, r.decision, r.override_reason, amend);
        // an amendment request still amends the latest decision (a newer amendment replaced it otherwise)
        if (amend && latestDecision !== r.amends_decision_id) throw new HttpError(409, 'request_not_current');
        await record(q, fid, rid, user, ev, {
          decision: r.decision, reason: r.override_reason, override, decidedBy: r.requested_by, request: r.id,
          amends: r.amends_decision_id, amendmentReason: r.amendment_reason, from: status,
        });
        return referralView(q, fid, rid, ruleSet, who);
      });
      return reply.code(201).send(body);
    } catch (err) { return fail(reply, err); }
  });

  // --- documents (M3 slice 5; SPEC §12.1): a signed upload into quarantine, checked bytes, then the record ------
  const quarantineKey = (fid: string, rid: string, sha: string) => `quarantine/${fid}/${rid}/${sha}`;
  const documentKey = (fid: string, rid: string, sha: string) => `documents/${fid}/${rid}/${sha}`;
  const needStorage = () => { if (!storage) throw new HttpError(503, 'storage_unavailable'); return storage; };
  // shortcut: an in-process limit (30 upload calls a minute per user); a shared limit (WAF or a store) when the API
  // runs as more than one process
  const recent = new Map<string, number[]>();
  const limit = (user: string) => {
    const now = Date.now();
    const hits = (recent.get(user) ?? []).filter((t) => now - t < 60_000);
    if (hits.length >= 30) throw new HttpError(429, 'rate_limited');
    hits.push(now);
    recent.set(user, hits);
  };
  /** Lock the referral and check staff may still add a document to it; returns its status. */
  const lockForUpload = async (q: Query, fid: string, rid: string) => {
    const ref = await q<{ status: string }>('SELECT status FROM referrals WHERE facility_id = $1 AND id = $2 FOR UPDATE', [fid, rid]);
    if (!ref.rows[0]) throw new HttpError(404, 'not_found');
    if (!UPLOAD_STATES.has(ref.rows[0].status)) throw new HttpError(409, 'referral_not_open');
    return ref.rows[0].status;
  };

  // step 1: a URL for exactly this many bytes, valid for five minutes, into quarantine
  app.post<{ Params: { fid: string; rid: string }; Body: unknown }>('/api/facilities/:fid/referrals/:rid/documents/uploads', async (req, reply) => {
    try {
      const user = caller(req.headers);
      const { fid, rid } = ids(req.params);
      const b = (req.body ?? {}) as { sha256?: unknown; bytes?: unknown };
      if (typeof b.sha256 !== 'string' || !SHA256.test(b.sha256) || !Number.isInteger(b.bytes) || (b.bytes as number) < 1 || (b.bytes as number) > MAX_DOCUMENT_BYTES) {
        throw new HttpError(400, 'invalid_document');
      }
      const s3 = needStorage();
      limit(user);
      const body = await tx(async (q) => {
        const who = await enter(q, fid, user);
        if (!WRITE_ROLES.has(who.role)) throw new HttpError(403, 'forbidden');
        await lockForUpload(q, fid, rid);
        const docs = await q<{ n: string; dup: boolean }>(
          "SELECT count(*) AS n, bool_or(sha256 = decode($3, 'hex')) AS dup FROM documents WHERE facility_id = $1 AND referral_id = $2", [fid, rid, b.sha256]);
        if (docs.rows[0]!.dup) throw new HttpError(409, 'document_duplicate');
        if (Number(docs.rows[0]!.n) >= 20) throw new HttpError(409, 'document_limit');
        const signed = await s3.presignPut(quarantineKey(fid, rid, b.sha256 as string), b.bytes as number);
        return { url: signed.url, headers: signed.headers, expires_in: UPLOAD_TTL_SECONDS };
      });
      return reply.code(201).send(body);
    } catch (err) { return fail(reply, err); }
  });

  // step 2: the uploaded bytes are read back and checked; only then is there a document, and the referral moves.
  // Storage I/O runs outside any transaction (a slow read never holds a connection or the referral lock); the
  // transaction then re-checks everything it relies on.
  app.post<{ Params: { fid: string; rid: string }; Body: unknown }>('/api/facilities/:fid/referrals/:rid/documents', async (req, reply) => {
    try {
      const user = caller(req.headers);
      const { fid, rid } = ids(req.params);
      const b = (req.body ?? {}) as { sha256?: unknown; type?: unknown; replaces?: unknown };
      const type = b.type === undefined ? 'unclassified' : b.type;
      if (typeof b.sha256 !== 'string' || !SHA256.test(b.sha256) || typeof type !== 'string' || !(DOCUMENT_TYPES as readonly string[]).includes(type)
          || (b.replaces !== undefined && (typeof b.replaces !== 'string' || !UUID.test(b.replaces)))) {
        throw new HttpError(400, 'invalid_document');
      }
      const sha = b.sha256;
      const replaces = b.replaces as string | undefined;
      const s3 = needStorage();
      limit(user);
      // 1. may this user add a document here at all (short transaction, no storage I/O)
      const precheck = async (q: Query) => {
        const who = await enter(q, fid, user);
        if (!WRITE_ROLES.has(who.role)) throw new HttpError(403, 'forbidden');
        const status = await lockForUpload(q, fid, rid);
        // T4: on a partial failure, a new document replaces one that failed (and only then)
        if ((status === 'partial_failure') !== (replaces !== undefined)) throw new HttpError(409, status === 'partial_failure' ? 'replace_required' : 'invalid_document');
        if (replaces !== undefined) {
          const old = await q<{ status: string }>('SELECT status FROM documents WHERE facility_id = $1 AND referral_id = $2 AND id = $3', [fid, rid, replaces]);
          if (!old.rows[0] || (old.rows[0].status !== 'failed' && old.rows[0].status !== 'unreadable')) throw new HttpError(409, 'replace_not_failed');
        }
        const dup = await q("SELECT 1 FROM documents WHERE facility_id = $1 AND referral_id = $2 AND sha256 = decode($3, 'hex')", [fid, rid, sha]);
        if (dup.rowCount) throw new HttpError(409, 'document_duplicate');
        return { who, status };
      };
      await tx(precheck);
      // 2. the declared hash, the size cap and the file signature, checked on the stored bytes themselves
      const found = await s3.inspect(quarantineKey(fid, rid, sha));
      if (!found) throw new HttpError(409, 'upload_missing');
      const kind = found.sha256 === sha && found.bytes >= 1 ? sniff(found.head) : null;
      if (!kind) {
        await s3.remove(quarantineKey(fid, rid, sha), found.versionId);
        throw new HttpError(422, 'document_rejected');
      }
      // 3. promote exactly the checked version (refused if it was replaced since); content-addressed, so a later
      //    refusal below leaves at most an unreferenced copy of these same checked bytes
      try {
        await s3.move(quarantineKey(fid, rid, sha), documentKey(fid, rid, sha), found, kind);
      } catch (err) {
        if ((err as { name?: string }).name === 'PreconditionFailed') throw new HttpError(409, 'upload_changed');
        throw err;
      }
      // 4. record it, re-checking state under the lock
      const body = await tx(async (q) => {
        const { who, status } = await precheck(q);
        const ruleSet = await loadSettings(q, fid, who.organizationId);
        if (replaces !== undefined) {
          await q("UPDATE documents SET status = 'not_applicable', not_applicable_reason = 'Replaced by a new upload', updated_at = now() WHERE facility_id = $1 AND id = $2", [fid, replaces]);
          await audit(q, fid, user, 'document.replaced', 'document', replaces);
        }
        const doc = await q<{ id: string }>(
          `INSERT INTO documents (facility_id, referral_id, type, sha256, storage_key) VALUES ($1, $2, $3, decode($4, 'hex'), $5) RETURNING id`,
          [fid, rid, type, sha, documentKey(fid, rid, sha)]);
        const docId = doc.rows[0]!.id;
        await audit(q, fid, user, 'document.uploaded', 'document', docId);
        await emit(q, fid, rid, user, 'referral.uploaded', { document_id: docId, bytes: found.bytes });
        // T6 from the review states, T4 from a partial failure; a draft waits for an explicit "process" (T1)
        const t = status === 'partial_failure' ? 'T4' : status === 'draft' ? null : 'T6';
        if (t) {
          await q('INSERT INTO referral_transitions (facility_id, referral_id, transition, from_status, to_status, created_by) VALUES ($1, $2, $3, $4, $5, $6)',
            [fid, rid, t, status, 'processing', `user:${user}`]);
        }
        return referralView(q, fid, rid, ruleSet, who);
      });
      if (body.referral.status === 'processing') await enqueue(fid, rid);
      return reply.code(201).send(body);
    } catch (err) { return fail(reply, err); }
  });

  // T5: every failed or unreadable document is marked not applicable with a reason; the engine re-evaluates
  app.post<{ Params: { fid: string; rid: string }; Body: unknown }>('/api/facilities/:fid/referrals/:rid/documents/resolve', async (req, reply) => {
    try {
      const user = caller(req.headers);
      const { fid, rid } = ids(req.params);
      const b = (req.body ?? {}) as { documents?: unknown };
      const list = Array.isArray(b.documents) && b.documents.length <= 20 ? b.documents as { id?: unknown; reason?: unknown }[] : null;
      if (!list || !list.every((d) => d && typeof d.id === 'string' && UUID.test(d.id) && typeof d.reason === 'string' && d.reason.trim() && d.reason.trim().length <= NOTE_MAX)) {
        throw new HttpError(400, 'invalid_document');
      }
      const body = await tx(async (q) => {
        const who = await enter(q, fid, user);
        if (!WRITE_ROLES.has(who.role)) throw new HttpError(403, 'forbidden');
        const ruleSet = await settingsOrRefuse(q, fid, who.organizationId);
        const ref = await q<{ status: string }>('SELECT status FROM referrals WHERE facility_id = $1 AND id = $2 FOR UPDATE', [fid, rid]);
        if (!ref.rows[0]) throw new HttpError(404, 'not_found');
        if (ref.rows[0].status !== 'partial_failure') throw new HttpError(409, 'transition_not_allowed');
        const bad = (await q<{ id: string }>("SELECT id FROM documents WHERE facility_id = $1 AND referral_id = $2 AND status IN ('failed', 'unreadable')", [fid, rid])).rows.map((r) => r.id);
        // exactly the failed documents, each once
        const named = new Set(list.map((d) => d.id as string));
        if (named.size !== list.length || named.size !== bad.length || !bad.every((id) => named.has(id))) throw new HttpError(409, 'resolve_all_failed');
        for (const d of list) {
          await q("UPDATE documents SET status = 'not_applicable', not_applicable_reason = $3, updated_at = now() WHERE facility_id = $1 AND id = $2", [fid, d.id, (d.reason as string).trim()]);
          await audit(q, fid, user, 'document.not_applicable', 'document', d.id as string);
        }
        await q("INSERT INTO referral_transitions (facility_id, referral_id, transition, from_status, to_status, created_by) VALUES ($1, $2, 'T5', 'partial_failure', 'ready_for_review', $3)",
          [fid, rid, `user:${user}`]);
        await reevaluate(q, fid, rid, ruleSet, user, 0); // T5: no OCR needed, the engine re-evaluates synchronously
        return referralView(q, fid, rid, ruleSet, who);
      });
      return reply.code(201).send(body);
    } catch (err) { return fail(reply, err); }
  });

  // --- facility settings (M3 slice 1): read by Reviewers and Admins, changed by Admins only -------------------
  const settingsView = (rs: RuleSet | null) => rs === null ? { configured: false } : {
    configured: true,
    rule_set: {
      version: rs.ruleSetVersion,
      criteria_document_ref: rs.criteriaRef,
      rules: rs.rules.map((r) => ({
        id: r.id, kind: r.kind, inputs: r.inputs, enabled_here: r.enabled,
        enabled_in_rule_set: !rs.baseDisabled.has(r.id),
        switchable: !rs.baseDisabled.has(r.id) && !NOT_SWITCHABLE.has(r.kind),
        explanation: (r as { explanation?: string }).explanation ?? null,
      })),
    },
    profile: { version: rs.profileVersion, capabilities: rs.profile, disabled_rules: rs.disabledRules },
    profile_keys: PROFILE_KEYS,
    completeness: rs.completeness,
  };

  app.get<{ Params: { fid: string } }>('/api/facilities/:fid/settings', async (req, reply) => {
    try {
      const user = caller(req.headers);
      const { fid } = ids(req.params);
      return reply.send(await tx(async (q) => {
        const who = await enter(q, fid, user);
        if (!READ_ROLES.has(who.role)) throw new HttpError(403, 'forbidden');
        return settingsView(await loadSettings(q, fid, who.organizationId));
      }));
    } catch (err) { return fail(reply, err); }
  });

  app.put<{ Params: { fid: string }; Body: unknown }>('/api/facilities/:fid/settings', async (req, reply) => {
    try {
      const user = caller(req.headers);
      const { fid } = ids(req.params);
      const b = (req.body ?? {}) as { capabilities?: unknown; disabled_rules?: unknown; based_on_version?: unknown };
      const caps = b.capabilities;
      const okCaps = !!caps && typeof caps === 'object' && !Array.isArray(caps) && Object.entries(caps as Record<string, unknown>).every(([k, v]) =>
        PROFILE_KEYS[k] === 'boolean' ? typeof v === 'boolean' : PROFILE_KEYS[k] === 'count' ? Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 999999 : false);
      const disabled = b.disabled_rules;
      const okDisabled = Array.isArray(disabled) && disabled.length <= 500 && disabled.every((d) => typeof d === 'string');
      if (!okCaps || !okDisabled || !Number.isInteger(b.based_on_version)) throw new HttpError(400, 'invalid_settings');
      return reply.send(await tx(async (q) => {
        const who = await enter(q, fid, user);
        if (who.role !== 'facility_admin') throw new HttpError(403, 'forbidden');
        const current = await settingsOrRefuse(q, fid, who.organizationId);
        // saved over a version someone else replaced meanwhile: refuse rather than silently undo their change
        if (b.based_on_version !== current.profileVersion) throw new HttpError(409, 'settings_changed');
        const kind = new Map(current.rules.map((r) => [r.id, r.kind]));
        if (!(disabled as string[]).every((d) => kind.has(d))) throw new HttpError(400, 'invalid_settings');
        if ((disabled as string[]).some((d) => NOT_SWITCHABLE.has(kind.get(d) as string))) throw new HttpError(400, 'rule_not_switchable');
        await q('INSERT INTO facility_profiles (facility_id, version, capabilities, disabled_rules, created_by) VALUES ($1, 0, $2, $3, $4)',
          [fid, caps, [...new Set(disabled as string[])].sort(), `user:${user}`]);
        return settingsView(await loadSettings(q, fid, who.organizationId));
      }));
    } catch (err) { return fail(reply, err); }
  });
}

/** The referral date for evaluation. shortcut: today in UTC until referrals carry a received date (§14.1 referral.received). */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

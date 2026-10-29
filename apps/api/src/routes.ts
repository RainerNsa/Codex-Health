// Manual fact entry (SPEC §5 T7, dev-alignment 2.1): the first reviewer-facing slice. A Reviewer or Admin creates
// a referral, enters or corrects facts by hand with a note, and sees the recommendation the engine derives.
// Every write runs in one transaction as codex_app under RLS, writes its audit row and product events, and
// re-evaluates. Responses carry ids, codes and the reviewer's own entries; errors never echo request content.
import type { FastifyInstance, FastifyReply } from 'fastify';
import { evaluate, ENGINE_VERSION, isRealDate, type Fact, type FactValue } from '@codex-health/rules-engine';
import { bindFacility, bindOrganization, type Query, type Tx } from './db.ts';
import { userFromHeaders } from './auth.ts';
import { loadSettings as loadStored, NOT_SWITCHABLE, PROFILE_KEYS, RuleSetRefused, type RuleSet } from './ruleset.ts';

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
} as const;
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
async function loadSettings(q: Query, facilityId: string, organizationId: string): Promise<RuleSet | null> {
  try {
    return await loadStored(q, facilityId, organizationId);
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

interface EvaluationRow { id: string; outcome: string; clinical_outcome: string; rule_set_version: number; facility_profile_version: number; trace: { confirmation_set?: string[] } }

const latestEvaluation = async (q: Query, facilityId: string, referralId: string) => (await q<EvaluationRow & Record<string, unknown>>(
  `SELECT id, outcome, clinical_outcome, financial_status, sub_reasons, trace, engine_version, rule_set_version, facility_profile_version
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

/** A hard-stop input a person changed from one known value to another, at any point in its history (§5.1 T12,
 *  open question 24). Unknown to known is a fact arriving, not a flip. */
async function hardStopFlipped(q: Query, facilityId: string, referralId: string, ruleSet: RuleSet): Promise<boolean> {
  const keys = [...new Set(ruleSet.rules.filter((r) => r.enabled && r.kind === 'hard_stop').flatMap((r) => r.inputs))];
  const { rows } = await q<{ n: string }>(
    `SELECT count(*) AS n FROM (
       SELECT key FROM facts
       WHERE facility_id = $1 AND referral_id = $2 AND key = ANY($3) AND value->'value' <> 'null'::jsonb AND value->>'value' <> 'unknown'
       GROUP BY key HAVING count(DISTINCT value->'value') > 1) flipped`, [facilityId, referralId, keys]);
  return Number(rows[0]!.n) > 0;
}

/** Evaluate the current facts under the current settings and store the immutable snapshot (§14.2, I6). */
async function reevaluate(q: Query, fid: string, rid: string, ruleSet: RuleSet, user: string, changedFactCount: number): Promise<void> {
  const referralDate = todayIso();
  const facts = await currentFacts(q, fid, rid);
  const docs = await q<{ open: string }>(
    "SELECT count(*) AS open FROM documents WHERE facility_id = $1 AND referral_id = $2 AND status NOT IN ('processed', 'not_applicable')", [fid, rid]);
  const processingComplete = Number(docs.rows[0]!.open) === 0;
  const result = evaluate({ facts, profile: ruleSet.profile, rules: ruleSet.rules, referral_date: referralDate, processing_complete: processingComplete });
  const prev = await q<{ id: string }>('SELECT id FROM evaluations WHERE facility_id = $1 AND referral_id = $2 ORDER BY evaluated_at DESC LIMIT 1', [fid, rid]);
  const { trace, missing, conflicts, blocking, empty_profile_keys, resolution_step, confirmation_set } = result;
  const ev = await q<{ id: string }>(
    `INSERT INTO evaluations (facility_id, referral_id, previous_evaluation_id, raw, outcome, clinical_outcome, financial_status, sub_reasons, trace,
       criteria_document_ref, rule_set_version, facility_profile_version, model_id, prompt_version, extractor_version, ocr_engine_version, engine_version)
     VALUES ($1, $2, $3, false, $4, $5, $6, $7, $8, $9, $10, $11, 'none', 'none', 'manual-entry', 'none', $12) RETURNING id`,
    [fid, rid, prev.rows[0]?.id ?? null, result.outcome, result.clinical_outcome, result.financial_status, result.sub_reasons,
      // every input of evaluate() beyond the facts is pinned, so the snapshot replays (I6)
      { resolution_step, trace, missing, conflicts, blocking, empty_profile_keys, confirmation_set, inputs: { referral_date: referralDate, processing_complete: processingComplete, fact_ids: facts.map((f) => f.id) } }, ruleSet.criteriaRef, ruleSet.ruleSetVersion, ruleSet.profileVersion, ENGINE_VERSION]);
  await audit(q, fid, user, 'evaluation.created', 'evaluation', ev.rows[0]!.id);
  await emit(q, fid, rid, user, 'evaluation.created', {
    evaluation_id: ev.rows[0]!.id, ...(prev.rows[0] ? { previous_evaluation_id: prev.rows[0].id } : {}), raw: false, outcome: result.outcome, changed_fact_count: changedFactCount,
  });
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
  const decision = await q<Record<string, unknown>>(
    `SELECT id, evaluation_id, recommended_outcome, decision, override_reason, decided_by, decided_at
     FROM decisions WHERE facility_id = $1 AND referral_id = $2 ORDER BY decided_at DESC LIMIT 1`, [facilityId, referralId]);
  const canWrite = WRITE_ROLES.has(role);
  // the evaluation was made under settings that have since changed: decide only after re-evaluating
  const outdated = !!ev && !!ruleSet && (ev.rule_set_version !== ruleSet.ruleSetVersion || ev.facility_profile_version !== ruleSet.profileVersion);
  const flipped = ruleSet ? await hardStopFlipped(q, facilityId, referralId, ruleSet) : false;
  // the latest co-sign request, while it can still be carried out: no decision yet, on the latest evaluation,
  // made under the current settings
  const pending = (await q<{ id: string; evaluation_id: string; decision: string; override_reason: string | null; requested_by: string; created_at: string }>(
    `SELECT id, evaluation_id, decision, override_reason, requested_by, created_at FROM decision_requests
     WHERE facility_id = $1 AND referral_id = $2 ORDER BY created_at DESC LIMIT 1`, [facilityId, referralId])).rows[0];
  const pendingRequest = pending && status === 'ready_for_review' && !outdated && ev?.id === pending.evaluation_id
    ? { ...pending, can_cosign: role === 'facility_admin' && who?.userId !== pending.requested_by } : null;
  const explanations = Object.fromEntries((ruleSet?.rules ?? []).map((r) => [r.id, (r as { explanation?: string }).explanation ?? null]));
  return {
    referral: ref.rows[0],
    facts: facts.map((f) => ({ id: f.id, key: f.key, value: f.value, source: f.source, note: f.source === 'user' ? f.note : null, as_of_date: f.as_of_date })),
    form: { fact_keys: ruleSet?.factKeys ?? [], note_max: NOTE_MAX, configured: ruleSet !== null, departments: DEPARTMENTS },
    evaluation: ev ?? null,
    rule_explanations: explanations,
    confirmation: confirmation(ev?.trace.confirmation_set ?? [], facts),
    // keys an Admit decision would also need stated as known values (shown when the recommendation is not Admit)
    admit_requires: ev && ruleSet ? confirmation(admitKeys(ruleSet, ev), facts).filter((c) => !c.known).map((c) => c.key) : [],
    evaluation_outdated: outdated,
    // decisions that need an Admin co-sign: a hard stop overridden to Admit; any decision after a flipped hard-stop input
    cosign: { admit: !!ev && (ev.outcome === 'do_not_admit' || ev.clinical_outcome === 'do_not_admit'), any: flipped },
    pending_request: pendingRequest,
    transitions: history.rows,
    decision: decision.rows[0] ?? null,
    // what this caller may do now; the API and the database check each again on the write
    actions: canWrite ? [
      ...(Object.keys(TRANSITIONS) as Action[]).filter((a) => (TRANSITIONS[a].from as readonly string[]).includes(status)),
      ...(outdated && OPEN_STATES.has(status) ? ['reevaluate'] : []),
      // finalize covers both paths: a decision that needs a co-sign is filed as a request instead
      ...(status === 'ready_for_review' && ev && !outdated ? ['finalize'] : []),
      ...(pendingRequest?.can_cosign ? ['cosign'] : []),
    ] : [],
  };
}

/** Parse a manual fact value of the type the rule set reads the key as; anything else is refused. */
function parseValue(v: unknown, type: 'tri_state' | 'count' | 'enum'): FactValue | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as { type?: unknown; value?: unknown };
  if (o.type !== type) return null;
  if (type === 'tri_state' && (o.value === 'yes' || o.value === 'no' || o.value === 'unknown')) return { type: 'tri_state', value: o.value };
  if (type === 'count' && (o.value === null || (Number.isInteger(o.value) && (o.value as number) >= 0 && (o.value as number) <= 100000))) return { type: 'count', value: o.value as number | null };
  if (type === 'enum' && (o.value === null || (typeof o.value === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(o.value)))) return { type: 'enum', value: o.value as string | null };
  return null;
}

export function registerRoutes(app: FastifyInstance, deps: { tx: Tx }): void {
  const { tx } = deps;
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

  app.get<{ Params: { fid: string; rid: string } }>('/api/facilities/:fid/referrals/:rid', async (req, reply) => {
    try {
      const user = caller(req.headers);
      const { fid, rid } = ids(req.params);
      return reply.send(await tx(async (q) => {
        const who = await enter(q, fid, user);
        if (!READ_ROLES.has(who.role)) throw new HttpError(403, 'forbidden');
        const view = await referralView(q, fid, rid, await loadSettings(q, fid, who.organizationId), who);
        await audit(q, fid, user, 'referral.viewed', 'referral', rid); // I4: reads of patient data are audited (1.10)
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
        const value = spec ? parseValue(b.value, spec.type) : null;
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
        await reevaluate(q, fid, rid, ruleSet, user, 1);
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
      const note = action !== 'submit' && typeof b.note === 'string' && b.note.trim() ? b.note.trim() : null;
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
        await q(
          `INSERT INTO referral_transitions (facility_id, referral_id, transition, from_status, to_status, note, department, requested_items, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [fid, rid, spec.t, from, spec.to, note, department, items, `user:${user}`]);
        await emit(q, fid, rid, user, spec.event,
          action === 'request_info' ? { items_requested: items.length } : action === 'escalate' ? { department } : spec.event === 'review.started' ? { screen: 'review' } : {});
        return referralView(q, fid, rid, ruleSet, who);
      });
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
  const checkDecision = async (q: Query, fid: string, rid: string, ruleSet: RuleSet, evaluationId: string, decision: 'admit' | 'do_not_admit', reason: string | null) => {
    const ref = await q<{ status: string }>('SELECT status FROM referrals WHERE facility_id = $1 AND id = $2 FOR UPDATE', [fid, rid]);
    if (!ref.rows[0]) throw new HttpError(404, 'not_found');
    if (ref.rows[0].status !== 'ready_for_review') throw new HttpError(409, 'transition_not_allowed');
    const ev = await latestEvaluation(q, fid, rid);
    // decided on what the Reviewer saw, under the settings in force now: anything newer is refused
    if (!ev || ev.id !== evaluationId || ev.rule_set_version !== ruleSet.ruleSetVersion || ev.facility_profile_version !== ruleSet.profileVersion) {
      throw new HttpError(409, 'evaluation_stale');
    }
    const facts = await currentFacts(q, fid, rid);
    if (!Array.isArray(ev.trace.confirmation_set) || confirmation(ev.trace.confirmation_set, facts).some((c) => !c.confirmed)) throw new HttpError(409, 'confirmation_incomplete');
    if (decision === 'admit' && confirmation(admitKeys(ruleSet, ev), facts).some((c) => !c.known)) throw new HttpError(409, 'confirmation_incomplete');
    const override = decision !== ev.outcome;
    if (override !== (reason !== null)) throw new HttpError(400, override ? 'override_reason_required' : 'invalid_decision');
    // a hard stop overridden to Admit, or any decision after a flipped hard-stop input, needs an Admin co-sign
    const needsCosign = (decision === 'admit' && (ev.outcome === 'do_not_admit' || ev.clinical_outcome === 'do_not_admit')) || await hardStopFlipped(q, fid, rid, ruleSet);
    return { ev, override, needsCosign };
  };
  const decisionBody = (body: unknown) => {
    const b = (body ?? {}) as { evaluation_id?: unknown; decision?: unknown; override_reason?: unknown };
    const decision: 'admit' | 'do_not_admit' | null = b.decision === 'admit' || b.decision === 'do_not_admit' ? b.decision : null;
    const reason = typeof b.override_reason === 'string' && b.override_reason.trim() ? b.override_reason.trim() : null;
    if (!decision || typeof b.evaluation_id !== 'string' || !UUID.test(b.evaluation_id) || (reason && reason.length > NOTE_MAX)) throw new HttpError(400, 'invalid_decision');
    return { evaluationId: b.evaluation_id, decision, reason };
  };
  /** Record the decision and finalize (T12) as the acting user: the decider, or the co-signer of a request. */
  const record = async (q: Query, fid: string, rid: string, user: string, ev: EvaluationRow, d: { decision: string; reason: string | null; override: boolean; decidedBy: string; request: string | null }) => {
    const row = await q<{ id: string }>(
      `INSERT INTO decisions (facility_id, referral_id, evaluation_id, recommended_outcome, recommended_clinical_outcome, decision, override_reason, decided_by, decided_role, cosigned_by, decision_request_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'viewer', $9, $10) RETURNING id`,
      [fid, rid, ev.id, ev.outcome, ev.clinical_outcome, d.decision, d.reason, d.decidedBy, d.request ? user : null, d.request]);
    const decisionId = row.rows[0]!.id;
    await q(
      `INSERT INTO referral_transitions (facility_id, referral_id, transition, from_status, to_status, decision_id, created_by)
       VALUES ($1, $2, 'T12', 'ready_for_review', 'finalized', $3, $4)`, [fid, rid, decisionId, `user:${user}`]);
    await emit(q, fid, rid, user, 'decision.finalized', {
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
        const { ev, override, needsCosign } = await checkDecision(q, fid, rid, ruleSet, evaluationId, decision, reason);
        if (needsCosign) throw new HttpError(409, 'cosign_required'); // file it with POST .../decision-requests
        await record(q, fid, rid, user, ev, { decision, reason, override, decidedBy: user, request: null });
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
      const { evaluationId, decision, reason } = decisionBody(req.body);
      const body = await tx(async (q) => {
        const who = await enter(q, fid, user);
        if (!WRITE_ROLES.has(who.role)) throw new HttpError(403, 'forbidden');
        const ruleSet = await settingsOrRefuse(q, fid, who.organizationId);
        const { needsCosign } = await checkDecision(q, fid, rid, ruleSet, evaluationId, decision, reason);
        if (!needsCosign) throw new HttpError(409, 'cosign_not_needed'); // record it directly
        await q('INSERT INTO decision_requests (facility_id, referral_id, evaluation_id, decision, override_reason, requested_by) VALUES ($1, $2, $3, $4, $5, $6)',
          [fid, rid, evaluationId, decision, reason, user]);
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
        const r = (await q<{ id: string; evaluation_id: string; decision: 'admit' | 'do_not_admit'; override_reason: string | null; requested_by: string }>(
          `SELECT id, evaluation_id, decision, override_reason, requested_by FROM decision_requests
           WHERE facility_id = $1 AND referral_id = $2 ORDER BY created_at DESC LIMIT 1`, [fid, rid])).rows[0];
        // only the latest request can be carried out; an older one was replaced by its decider
        if (!r || r.id !== qid) throw new HttpError(409, 'request_not_current');
        if (r.requested_by === user) throw new HttpError(409, 'cosign_own_request');
        // the request is re-checked as it stands now: a new evaluation or a settings change makes it stale
        const { ev, override } = await checkDecision(q, fid, rid, ruleSet, r.evaluation_id, r.decision, r.override_reason);
        await record(q, fid, rid, user, ev, { decision: r.decision, reason: r.override_reason, override, decidedBy: r.requested_by, request: r.id });
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

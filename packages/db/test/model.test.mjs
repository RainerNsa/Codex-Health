// Referral data model (migration 0003): document rules, fact shape and lineage, evaluation pinning, and the
// decision guards the database enforces (I5 co-sign, override reason, latest evaluation, one original,
// Admin-only amendment, audit coupling). Runs in one rolled-back transaction against DATABASE_URL; skips
// without it (fails where REQUIRE_DATABASE is set). Each subtest is its own savepoint.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url && process.env.REQUIRE_DATABASE) throw new Error('DATABASE_URL must be set here: the database suite may not be skipped in the db-checks job');

const ORG = '00000000-0000-4000-8000-00000000d001';
const FAC = { a: '00000000-0000-4000-8000-00000000fda1', b: '00000000-0000-4000-8000-00000000fdb1' };
const U = { reviewer: '00000000-0000-4000-8000-00000000dd01', admin: '00000000-0000-4000-8000-00000000dd02', admin2: '00000000-0000-4000-8000-00000000dd03', viewer: '00000000-0000-4000-8000-00000000dd04' };
const EV = { document_id: 'doc_zztest', page: 3, quote: 'SYNTHETIC ZZTEST CANARY-ALPHA MRN-ZZCANARY-0000001 vent dependent', verified: true, span: null, coordinates: null };

const bind = async (c, facility) => {
  await c.query("SELECT set_config('app.facility_id', $1, true)", [facility]);
  await c.query("SELECT set_config('app.organization_id', $1, true)", [ORG]);
};
// A failed statement aborts the transaction, so every expected failure runs under its own savepoint.
async function rejects(c, fn, pattern) {
  await c.query('SAVEPOINT expect_fail');
  await assert.rejects(fn(), pattern);
  await c.query('ROLLBACK TO SAVEPOINT expect_fail');
}
const expectFailure = (c, sql, pattern, params = []) => rejects(c, () => c.query(sql, params), pattern);
const n = async (c, sql, params) => Number((await c.query(sql, params)).rows[0].n);

const EVAL_SQL = `INSERT INTO evaluations (facility_id, referral_id, raw, outcome, clinical_outcome, financial_status, sub_reasons, trace,
  criteria_document_ref, rule_set_version, facility_profile_version, model_id, prompt_version, extractor_version, ocr_engine_version, engine_version)
  VALUES ($1, $2, $3, $4, $4, 'clear', $5, '{"triggered_rules":[]}', 'seed', 1, 1, 'none', 'p0', 'x0', 'o0', 'e0') RETURNING id`;
const evaluate = async (c, fac, ref, outcome, { raw = false, reasons = [] } = {}) => (await c.query(EVAL_SQL, [fac, ref, raw, outcome, reasons])).rows[0].id;
const DECIDE_SQL = 'INSERT INTO decisions (facility_id, referral_id, evaluation_id, recommended_outcome, decision, override_reason, decided_by, cosigned_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, decided_role, cosigned_role, hard_stop_override, recommended_clinical_outcome';
const AMEND_SQL = 'INSERT INTO decisions (facility_id, referral_id, evaluation_id, recommended_outcome, decision, override_reason, decided_by, amends_decision_id, amendment_reason) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id';
const docKey = (fac, ref, hexSha) => `documents/${fac}/${ref}/${hexSha}`;
const lastAudit = async (c, k = 1) => (await c.query('SELECT actor, action, entity_type, entity_id FROM audit_log ORDER BY seq DESC LIMIT $1', [k])).rows;

async function seed(c) {
  await bind(c, '');
  await c.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [ORG, 'ZZTEST Model Org']);
  for (const [k, id] of Object.entries(U)) {
    await c.query('INSERT INTO users (id, organization_id, email, display_name) VALUES ($1, $2, $3, $4)', [id, ORG, `zztest.model.${k}@example.invalid`, `ZZTEST ${k}`]);
  }
  const refs = {};
  for (const [k, id] of Object.entries(FAC)) {
    await bind(c, id);
    await c.query('INSERT INTO facilities (facility_id, organization_id, name) VALUES ($1, $2, $3)', [id, ORG, `ZZTEST Model Facility ${k}`]);
    for (const [role, uid] of [['admissions_reviewer', U.reviewer], ['facility_admin', U.admin], ['facility_admin', U.admin2], ['viewer', U.viewer]]) {
      await c.query('INSERT INTO user_facility_roles (user_id, facility_id, role) VALUES ($1, $2, $3)', [uid, id, role]);
    }
    refs[k] = (await c.query("INSERT INTO referrals (facility_id, status) VALUES ($1, 'ready_for_review') RETURNING id", [id])).rows[0].id;
  }
  return refs;
}

test('referral data model', { skip: !url && 'DATABASE_URL not set' }, async (t) => {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query('BEGIN');
  const sub = (name, fn) => t.test(name, async () => {
    await c.query('SAVEPOINT sub');
    try { await fn(); } finally { await c.query('ROLLBACK TO SAVEPOINT sub'); }
  });
  try {
    const refs = await seed(c);
    // sha256 of a short label, as hex, so storage keys can be derived in the test as the CHECK derives them
    const shaHex = async (label) => (await c.query("SELECT encode(sha256(convert_to($1, 'UTF8')), 'hex') AS h", [label])).rows[0].h;
    const insertDoc = async (fac, ref, label, extra = {}) => {
      const h = await shaHex(label);
      const { status = 'uploaded', reason = null, type = 'face_sheet', key = docKey(fac, ref, h) } = extra;
      return (await c.query("INSERT INTO documents (facility_id, referral_id, type, status, not_applicable_reason, sha256, storage_key) VALUES ($1, $2, $3, $4, $5, decode($6, 'hex'), $7) RETURNING id",
        [fac, ref, type, status, reason, h, key])).rows[0].id;
    };

    await sub('documents: not_applicable needs a reason and nothing else may carry one; duplicates are per referral; the storage key is derived', async () => {
      await bind(c, FAC.a);
      await insertDoc(FAC.a, refs.a, 'one');
      await rejects(c, () => insertDoc(FAC.a, refs.a, 'two', { status: 'not_applicable', reason: '  ' }), /"documents_check1"/);
      await rejects(c, () => insertDoc(FAC.a, refs.a, 'three', { status: 'uploaded', reason: 'SYNTHETIC reason' }), /"documents_check1"/);
      await insertDoc(FAC.a, refs.a, 'four', { status: 'not_applicable', reason: 'SYNTHETIC: fax cover sheet' });
      await rejects(c, () => insertDoc(FAC.a, refs.a, 'one'), /"documents_referral_id_sha256_key"/);
      await bind(c, FAC.b);
      await insertDoc(FAC.b, refs.b, 'one'); // same hash on another referral is a different document
      await bind(c, FAC.a);
      await rejects(c, () => insertDoc(FAC.a, refs.a, 'five', { type: 'Face Sheet' }), /"documents_type_check"/);
      const six = await shaHex('six');
      await rejects(c, () => insertDoc(FAC.a, refs.a, 'six', { key: docKey(FAC.b, refs.b, six) }), /"documents_check"/);
      await rejects(c, () => insertDoc(FAC.a, refs.a, 'seven', { key: docKey(FAC.a, refs.a, '0'.repeat(64)) }), /"documents_check"/);
      await expectFailure(c, "INSERT INTO documents (facility_id, referral_id, type, sha256, storage_key) VALUES ($1, $2, 'mar', '\\x00', $3)", /"documents_sha256_check"/, [FAC.a, refs.a, docKey(FAC.a, refs.a, '00')]);
      const h = await shaHex('eight');
      await expectFailure(c, "INSERT INTO documents (facility_id, referral_id, type, sha256, storage_key, pages) VALUES ($1, $2, 'mar', decode($3, 'hex'), $4, -1)", /"documents_pages_check"/, [FAC.a, refs.a, h, docKey(FAC.a, refs.a, h)]);
    });

    await sub('documents: the worker reports results on an in-flight referral from uploaded only; the app may only mark not_applicable', async () => {
      await bind(c, FAC.a);
      const doc = await insertDoc(FAC.a, refs.a, 'w1');
      await c.query('SET LOCAL ROLE codex_worker');
      await expectFailure(c, "UPDATE documents SET status = 'processed' WHERE id = $1", /codex_worker may not move document/, [doc]); // referral is ready_for_review
      await c.query('RESET ROLE');
      await c.query("UPDATE referrals SET status = 'processing' WHERE id = $1", [refs.a]);
      await c.query('SET LOCAL ROLE codex_worker');
      await expectFailure(c, "UPDATE documents SET status = 'not_applicable' WHERE id = $1", /codex_worker may not move document|"documents_check1"/, [doc]);
      await c.query("UPDATE documents SET status = 'failed' WHERE id = $1", [doc]);
      await expectFailure(c, "UPDATE documents SET status = 'processed' WHERE id = $1", /codex_worker may not move document/, [doc]); // not from failed
      await expectFailure(c, "UPDATE documents SET type = 'mar' WHERE id = $1", /permission denied/, [doc]);
      await expectFailure(c, "INSERT INTO documents (facility_id, referral_id, type, sha256, storage_key) VALUES ($1, $2, 'mar', '\\x00', 'x')", /permission denied/, [FAC.a, refs.a]);
      await c.query('RESET ROLE');
      await c.query('SET LOCAL ROLE codex_app');
      await expectFailure(c, "UPDATE documents SET status = 'processed' WHERE id = $1", /codex_app may not move document/, [doc]);
      await expectFailure(c, 'UPDATE documents SET pages = 3 WHERE id = $1', /permission denied/, [doc]);
      await c.query('RESET ROLE');
      await c.query("UPDATE documents SET status = 'failed' WHERE id = $1", [doc]);
      await c.query('SET LOCAL ROLE codex_app');
      await expectFailure(c, "UPDATE documents SET status = 'uploaded' WHERE id = $1", /codex_app may not move document/, [doc]); // retry: only from a partial failure
      await c.query("UPDATE documents SET status = 'not_applicable', not_applicable_reason = 'SYNTHETIC: duplicate of the H&P' WHERE id = $1", [doc]);
      await expectFailure(c, "UPDATE documents SET status = 'uploaded', not_applicable_reason = NULL WHERE id = $1", /codex_app may not move document/, [doc]);
    });

    await sub('composite keys: no row can reference another facility or another referral', async () => {
      await bind(c, FAC.a);
      await rejects(c, () => insertDoc(FAC.b, refs.b, 'x'), /row-level security/);
      await rejects(c, () => insertDoc(FAC.a, refs.b, 'x'), /"documents_facility_id_referral_id_fkey"/);
      await rejects(c, () => evaluate(c, FAC.a, refs.b, 'admit'), /"evaluations_facility_id_referral_id_fkey"/);
      const evA = await evaluate(c, FAC.a, refs.a, 'admit');
      await bind(c, FAC.b);
      await expectFailure(c, EVAL_SQL.replace('(facility_id, referral_id, raw', '(facility_id, referral_id, previous_evaluation_id, raw').replace('VALUES ($1, $2, $3', 'VALUES ($1, $2, $6, $3'), /"evaluations_facility_id_referral_id_previous_evaluation_id_fkey"/, [FAC.b, refs.b, false, 'admit', [], evA]);
      await expectFailure(c, DECIDE_SQL, /not visible/, [FAC.b, refs.b, evA, 'admit', 'admit', null, U.reviewer, null]);
    });

    await sub('facts: shape — user facts need a note and no evidence; known ai facts need well-formed evidence; unknown ai facts carry none', async () => {
      await bind(c, FAC.a);
      let i = 0;
      const ins = (value, source, evidence, note, band = null, key = `fact_${(i += 1)}`) => c.query(
        'INSERT INTO facts (facility_id, referral_id, key, value, source, evidence, note, confidence_band, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id',
        [FAC.a, refs.a, key, value, source, evidence, note, band, source === 'user' ? `user:${U.reviewer}` : 'worker:j1']);
      await ins({ type: 'tri_state', value: 'yes' }, 'ai', EV, null, 'high');
      await ins({ type: 'tri_state', value: 'unknown' }, 'ai', null, null, 'low');
      await ins({ type: 'count', value: null }, 'ai', null, null, 'low');
      await ins({ type: 'count', value: 0 }, 'ai', EV, null, 'high');
      await ins({ type: 'tri_state', value: 'no' }, 'user', null, 'SYNTHETIC: verbal update from liaison');
      await rejects(c, () => ins({ type: 'tri_state', value: 'yes' }, 'ai', null, null, 'high'), /"facts_ai_evidence_iff_known"/);
      await rejects(c, () => ins({ type: 'tri_state', value: 'unknown' }, 'ai', EV, null, 'low'), /"facts_ai_evidence_iff_known"/);
      await rejects(c, () => ins({ type: 'count', value: 0 }, 'ai', null, null, 'high'), /"facts_ai_evidence_iff_known"/);
      await rejects(c, () => ins({ type: 'tri_state', value: 'no' }, 'user', null, '   '), /"facts_user_shape"/);
      await rejects(c, () => ins({ type: 'tri_state', value: 'no' }, 'user', EV, 'SYNTHETIC note'), /"facts_user_shape"/);
      await rejects(c, () => ins({ type: 'tri_state', value: 'no' }, 'user', null, 'SYNTHETIC note', 'high'), /"facts_user_shape"/);
      await rejects(c, () => ins({ type: 'tri_state', value: 'yes' }, 'ai', EV, 'SYNTHETIC note', 'high'), /"facts_ai_no_note"/);
      await rejects(c, () => ins({ type: 'tri_state', value: 'yes' }, 'ai', { quote: 'x' }, null, 'high'), /"facts_evidence_shape"/);
      await rejects(c, () => ins({ type: 'tri_state', value: 'yes' }, 'ai', { ...EV, verified: null }, null, 'high'), /"facts_evidence_shape"/);
      await rejects(c, () => ins({ type: 'tri_state', value: 'yes' }, 'ai', { ...EV, page: 0 }, null, 'high'), /"facts_evidence_shape"/);
      await rejects(c, () => ins({ type: 'tri_state', value: 'yes' }, 'ai', { ...EV, quote: '  ' }, null, 'high'), /"facts_evidence_shape"/);
      await rejects(c, () => ins(JSON.stringify('yes'), 'ai', EV, null, 'high'), /"facts_value_shape"/);
      await rejects(c, () => ins({ type: 'tri_state', value: null }, 'ai', null, null, 'low'), /"facts_value_shape"/);
      await rejects(c, () => ins({ type: 'tri_state', value: 'maybe' }, 'ai', EV, null, 'high'), /"facts_value_shape"/);
      await rejects(c, () => ins({ type: 'bogus', value: 1 }, 'ai', EV, null, 'high'), /"facts_value_shape"/);
      await rejects(c, () => ins({ type: 'count', value: -1 }, 'ai', EV, null, 'high'), /"facts_value_shape"/);
      await rejects(c, () => ins({ type: 'tri_state', value: 'yes' }, 'ai', EV, null, 'high', 'Bad Key'), /"facts_key_check"/);
      await expectFailure(c, `INSERT INTO facts (facility_id, referral_id, key, value, source, note, created_by) VALUES ($1, $2, 'k', '{"type":"tri_state","value":"no"}', 'user', 'SYNTHETIC', 'ZZTEST Nurse')`, /"facts_created_by_check"/, [FAC.a, refs.a]);
    });

    await sub('facts: lineage — a new assertion supersedes the latest for its key, same key only; rows are never rewritten', async () => {
      await bind(c, FAC.a);
      const ai = `INSERT INTO facts (facility_id, referral_id, key, value, source, evidence, confidence_band, created_by, supersedes) VALUES ($1, $2, $3, '{"type":"tri_state","value":"yes"}', 'ai', $4, 'high', 'worker:j1', $5) RETURNING id`;
      const user = `INSERT INTO facts (facility_id, referral_id, key, value, source, note, supersedes, created_by) VALUES ($1, $2, $3, '{"type":"tri_state","value":"no"}', 'user', 'SYNTHETIC: weaned per liaison', $4, $5) RETURNING id`;
      const { rows: [{ id: f1 }] } = await c.query(ai, [FAC.a, refs.a, 'ventilator_use', EV, null]);
      const { rows: [{ id: other }] } = await c.query(ai, [FAC.a, refs.a, 'dialysis', EV, null]);
      await expectFailure(c, user, /must supersede the latest assertion/, [FAC.a, refs.a, 'ventilator_use', null, `user:${U.reviewer}`]);
      await expectFailure(c, user, /may not supersede a fact of another key|must supersede the latest/, [FAC.a, refs.a, 'ventilator_use', other, `user:${U.reviewer}`]);
      const { rows: [{ id: f2 }] } = await c.query(user, [FAC.a, refs.a, 'ventilator_use', f1, `user:${U.reviewer}`]);
      await expectFailure(c, user, /must supersede the latest assertion/, [FAC.a, refs.a, 'ventilator_use', f1, `user:${U.reviewer}`]); // f1 is no longer the latest
      await c.query(ai, [FAC.a, refs.a, 'ventilator_use', EV, f2]); // re-extraction after new documents supersedes the user fact
      assert.equal(await n(c, 'SELECT count(*) AS n FROM facts WHERE referral_id = $1 AND key = $2', [refs.a, 'ventilator_use']), 3, 'every assertion retained');
      await expectFailure(c, "UPDATE facts SET value = '{\"type\":\"tri_state\",\"value\":\"no\"}' WHERE id = $1", /immutable/, [f1]);
      await c.query('SET LOCAL ROLE codex_app');
      await expectFailure(c, "UPDATE facts SET note = 'x' WHERE id = $1", /permission denied/, [f1]);
      await expectFailure(c, 'DELETE FROM facts WHERE id = $1', /permission denied/, [f1]);
      await c.query('RESET ROLE');
      assert.equal((await c.query('DELETE FROM facts WHERE referral_id = $1 AND key = $2', [refs.a, 'dialysis'])).rowCount, 1, 'the owner may delete (purge)');
      await bind(c, FAC.b);
      // bound to B, A's fact is invisible to the key check and unreachable by the composite FK: refused either way
      await expectFailure(c, user, /"facts_facility_id_referral_id_supersedes_fkey"|row-level security|may not supersede/, [FAC.b, refs.b, 'ventilator_use', f1, `user:${U.reviewer}`]);
    });

    await sub('facts: the worker writes only ai facts as itself; the app writes only user facts as a user', async () => {
      await bind(c, FAC.a);
      const sql = 'INSERT INTO facts (facility_id, referral_id, key, value, source, evidence, note, confidence_band, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)';
      await c.query('SET LOCAL ROLE codex_worker');
      await c.query(sql, [FAC.a, refs.a, 'w_ok', { type: 'tri_state', value: 'yes' }, 'ai', EV, null, 'high', 'worker:j1']);
      await expectFailure(c, sql, /codex_worker may only insert ai facts/, [FAC.a, refs.a, 'w_user', { type: 'tri_state', value: 'no' }, 'user', null, 'SYNTHETIC', null, `user:${U.reviewer}`]);
      await expectFailure(c, sql, /codex_worker may only insert ai facts/, [FAC.a, refs.a, 'w_actor', { type: 'tri_state', value: 'yes' }, 'ai', EV, null, 'high', `user:${U.reviewer}`]);
      await c.query('RESET ROLE');
      await c.query('SET LOCAL ROLE codex_app');
      await c.query(sql, [FAC.a, refs.a, 'a_ok', { type: 'tri_state', value: 'no' }, 'user', null, 'SYNTHETIC', null, `user:${U.reviewer}`]);
      await expectFailure(c, sql, /codex_app may only insert user facts/, [FAC.a, refs.a, 'a_ai', { type: 'tri_state', value: 'yes' }, 'ai', EV, null, 'high', 'worker:j1']);
      await expectFailure(c, sql, /codex_app may only insert user facts/, [FAC.a, refs.a, 'a_actor', { type: 'tri_state', value: 'no' }, 'user', null, 'SYNTHETIC', null, 'worker:j1']);
      await c.query('RESET ROLE');
    });

    await sub('evaluations: every version pinned, aliases refused, needs_review iff sub-reasons, a clinical hard stop is the outcome, no quote in the trace, immutable for everyone', async () => {
      await bind(c, FAC.a);
      const id = await evaluate(c, FAC.a, refs.a, 'needs_review', { raw: true, reasons: ['missing_info'] });
      await c.query(`INSERT INTO evaluations (facility_id, referral_id, previous_evaluation_id, raw, outcome, clinical_outcome, financial_status, trace,
        criteria_document_ref, rule_set_version, facility_profile_version, model_id, prompt_version, extractor_version, ocr_engine_version, engine_version)
        VALUES ($1, $2, $3, false, 'admit', 'admit', 'clear', '{}', 'seed', 1, 1, 'anthropic.claude-3-5-sonnet-20241022-v2:0', 'p1', 'x1', 'o1', 'e1')`, [FAC.a, refs.a, id]);
      await rejects(c, () => evaluate(c, FAC.a, refs.a, 'needs_review'), /"evaluations_needs_review_iff_reasons"/);
      await rejects(c, () => evaluate(c, FAC.a, refs.a, 'admit', { reasons: ['clinical'] }), /"evaluations_needs_review_iff_reasons"/);
      await rejects(c, () => evaluate(c, FAC.a, refs.a, 'needs_review', { reasons: ['because'] }), /"evaluations_sub_reasons_codes"/);
      for (const [from, to, name] of [
        ["'none'", "'anthropic.claude-3-5-sonnet-latest'", 'model_id'],
        ["'p0'", "' '", 'prompt_version'], ["'x0'", "''", 'extractor_version'], ["'o0'", "' '", 'ocr_engine_version'], ["'e0'", "''", 'engine_version'],
        ["'seed', 1, 1,", "' ', 1, 1,", 'criteria_document_ref'], ["'seed', 1, 1,", "'seed', 0, 1,", 'rule_set_version'], ["'seed', 1, 1,", "'seed', 1, 0,", 'facility_profile_version'],
      ]) {
        await expectFailure(c, EVAL_SQL.replace(from, to), new RegExp(`"evaluations_${name}_check"`), [FAC.a, refs.a, false, 'admit', []]);
      }
      await expectFailure(c, EVAL_SQL.replace("'{\"triggered_rules\":[]}'", "'{\"triggered\":[{\"rule\":\"r1\",\"quote\":\"ZZTEST CANARY-ALPHA\"}]}'"), /"evaluations_trace_shape"/, [FAC.a, refs.a, false, 'admit', []]);
      await expectFailure(c, EVAL_SQL.replace("'{\"triggered_rules\":[]}'", "'[]'"), /"evaluations_trace_shape"/, [FAC.a, refs.a, false, 'admit', []]);
      await expectFailure(c, `INSERT INTO evaluations (facility_id, referral_id, raw, outcome, clinical_outcome, financial_status, sub_reasons, trace,
        criteria_document_ref, rule_set_version, facility_profile_version, model_id, prompt_version, extractor_version, ocr_engine_version, engine_version)
        VALUES ($1, $2, false, 'needs_review', 'do_not_admit', 'clear', '{clinical}', '{}', 'seed', 1, 1, 'none', 'p0', 'x0', 'o0', 'e0')`, /"evaluations_hard_stop_is_outcome"/, [FAC.a, refs.a]);
      await expectFailure(c, "UPDATE evaluations SET outcome = 'admit' WHERE id = $1", /immutable/, [id]);
      await expectFailure(c, 'DELETE FROM evaluations WHERE id = $1', /immutable/, [id]);
      for (const role of ['codex_app', 'codex_worker']) {
        await c.query(`SET LOCAL ROLE ${role}`);
        await expectFailure(c, "UPDATE evaluations SET outcome = 'admit' WHERE id = $1", /permission denied/, [id]);
        await expectFailure(c, 'DELETE FROM evaluations WHERE id = $1', /permission denied/, [id]);
        await c.query('RESET ROLE');
      }
      await c.query('SET LOCAL ROLE codex_app');
      await rejects(c, () => evaluate(c, FAC.a, refs.a, 'admit', { raw: true }), /codex_app may not write a raw evaluation/);
      await evaluate(c, FAC.a, refs.a, 'admit');
      await c.query('RESET ROLE');
    });

    await sub('decisions: a plain decision snapshots the decider role (writer values overwritten) and writes an audit row with ids only', async () => {
      await bind(c, FAC.a);
      const ev = await evaluate(c, FAC.a, refs.a, 'admit');
      const before = await n(c, 'SELECT count(*) AS n FROM audit_log');
      const { rows: [d] } = await c.query(
        'INSERT INTO decisions (facility_id, referral_id, evaluation_id, recommended_outcome, decision, decided_by, decided_role) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, decided_role, cosigned_role, hard_stop_override, recommended_clinical_outcome',
        [FAC.a, refs.a, ev, 'admit', 'admit', U.reviewer, 'viewer']);
      assert.equal(d.decided_role, 'admissions_reviewer', 'writer-supplied decided_role is overwritten from the membership table');
      assert.equal(d.cosigned_role, null);
      assert.equal(d.hard_stop_override, false);
      assert.equal(d.recommended_clinical_outcome, 'admit');
      assert.deepEqual(await lastAudit(c), [{ actor: `user:${U.reviewer}`, action: 'decision.finalized', entity_type: 'decision', entity_id: d.id }]);
      assert.equal(await n(c, 'SELECT count(*) AS n FROM audit_log'), before + 1);
      await bind(c, FAC.b);
      const evB = await evaluate(c, FAC.b, refs.b, 'admit');
      await expectFailure(c, DECIDE_SQL, /holds no Reviewer or Admin role/, [FAC.b, refs.b, evB, 'admit', 'admit', null, U.viewer, null]);
      await expectFailure(c, DECIDE_SQL, /"decisions_decision_check"/, [FAC.b, refs.b, evB, 'admit', 'needs_review', 'SYNTHETIC reason', U.reviewer, null]);
    });

    await sub('decisions: the pinned evaluation must be the referral latest, and its outcome and referral must match', async () => {
      await bind(c, FAC.a);
      const stale = await evaluate(c, FAC.a, refs.a, 'admit', { raw: true });
      const latest = await evaluate(c, FAC.a, refs.a, 'do_not_admit');
      await expectFailure(c, DECIDE_SQL, /is not the latest for referral/, [FAC.a, refs.a, stale, 'admit', 'admit', null, U.reviewer, null]);
      await expectFailure(c, DECIDE_SQL, /does not match evaluation/, [FAC.a, refs.a, latest, 'admit', 'admit', null, U.reviewer, null]);
      await c.query(DECIDE_SQL, [FAC.a, refs.a, latest, 'do_not_admit', 'do_not_admit', null, U.reviewer, null]);
    });

    await sub('decisions: one original per referral; every later one is an amendment', async () => {
      await bind(c, FAC.a);
      const ev = await evaluate(c, FAC.a, refs.a, 'admit');
      const { rows: [first] } = await c.query(DECIDE_SQL, [FAC.a, refs.a, ev, 'admit', 'admit', null, U.reviewer, null]);
      await expectFailure(c, DECIDE_SQL, /already has decision|"decisions_one_original"/, [FAC.a, refs.a, ev, 'admit', 'admit', null, U.reviewer, null]);
      await expectFailure(c, DECIDE_SQL, /already has decision|"decisions_one_original"/, [FAC.a, refs.a, ev, 'admit', 'admit', null, U.admin, null]);
      await c.query(AMEND_SQL, [FAC.a, refs.a, ev, 'admit', 'do_not_admit', 'SYNTHETIC: new information', U.admin, first.id, 'SYNTHETIC: amended on new information']);
    });

    await sub('I5: an override needs a non-blank reason, and no reason when there is no override', async () => {
      await bind(c, FAC.a);
      const ev = await evaluate(c, FAC.a, refs.a, 'admit');
      await expectFailure(c, DECIDE_SQL, /"decisions_override_reason_iff_override"/, [FAC.a, refs.a, ev, 'admit', 'do_not_admit', null, U.reviewer, null]);
      await expectFailure(c, DECIDE_SQL, /"decisions_override_reason_iff_override"/, [FAC.a, refs.a, ev, 'admit', 'do_not_admit', '   ', U.reviewer, null]);
      await expectFailure(c, DECIDE_SQL, /"decisions_override_reason_iff_override"/, [FAC.a, refs.a, ev, 'admit', 'admit', 'SYNTHETIC reason on a non-override', U.reviewer, null]);
      const { rows: [d] } = await c.query(DECIDE_SQL, [FAC.a, refs.a, ev, 'admit', 'do_not_admit', 'SYNTHETIC: bed type not available', U.reviewer, null]);
      assert.equal(d.hard_stop_override, false, 'Admit → Do Not Admit is an override but not a hard-stop override');
    });

    await sub('I5: hard stop → Admit needs a co-signing Admin who is a different user; nobody co-signs their own decision', async () => {
      await bind(c, FAC.a);
      const ev = await evaluate(c, FAC.a, refs.a, 'do_not_admit');
      const args = (by, cosign) => [FAC.a, refs.a, ev, 'do_not_admit', 'admit', 'SYNTHETIC: facility can take the patient after all', by, cosign];
      await expectFailure(c, DECIDE_SQL, /"decisions_hard_stop_cosign"/, args(U.reviewer, null));
      await expectFailure(c, DECIDE_SQL, /"decisions_cosigner_is_other_user"/, args(U.admin, U.admin));
      await expectFailure(c, DECIDE_SQL, /not an Admin/, args(U.admin, U.reviewer));
      await expectFailure(c, DECIDE_SQL, /not an Admin/, args(U.admin, U.viewer));
      await expectFailure(c, 'INSERT INTO decisions (facility_id, referral_id, evaluation_id, recommended_outcome, decision, override_reason, decided_by, cosigned_by, cosigned_role) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)', /not an Admin/, [...args(U.admin, U.reviewer), 'facility_admin']);
      // a non-hard-stop decision still may not be co-signed by its own decider
      await expectFailure(c, DECIDE_SQL, /"decisions_cosigner_is_other_user"/, [FAC.a, refs.a, ev, 'do_not_admit', 'do_not_admit', null, U.admin, U.admin]);
      const before = await n(c, 'SELECT count(*) AS n FROM audit_log');
      const { rows: [d] } = await c.query(
        'INSERT INTO decisions (facility_id, referral_id, evaluation_id, recommended_outcome, decision, override_reason, decided_by, cosigned_by, cosigned_role) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, hard_stop_override, cosigned_role',
        [...args(U.reviewer, U.admin), 'viewer']);
      assert.equal(d.hard_stop_override, true);
      assert.equal(d.cosigned_role, 'facility_admin', 'writer-supplied cosigned_role is overwritten');
      const audit = await lastAudit(c, 2);
      assert.deepEqual(audit.map((r) => [r.action, r.actor]).sort(), [['decision.cosigned', `user:${U.admin}`], ['decision.finalized', `user:${U.reviewer}`]]);
      assert.ok(audit.every((r) => r.entity_id === d.id));
      assert.equal(await n(c, 'SELECT count(*) AS n FROM audit_log'), before + 2);
      await bind(c, FAC.b);
      const evB = await evaluate(c, FAC.b, refs.b, 'do_not_admit');
      const { rows: [d2] } = await c.query(DECIDE_SQL, [FAC.b, refs.b, evB, 'do_not_admit', 'admit', 'SYNTHETIC', U.admin, U.admin2]);
      assert.equal(d2.hard_stop_override, true, 'two different Admins is also valid');
    });

    await sub('I5: a clinical hard stop under a merged needs_review is still a hard stop for the co-sign', async () => {
      await bind(c, FAC.a);
      // outcome needs_review (e.g. §4 step 1) with clinical_outcome do_not_admit is refused on the evaluation itself; the
      // co-sign therefore keys on both columns and the snapshot is taken from the evaluation, not the writer
      const ev = await evaluate(c, FAC.a, refs.a, 'do_not_admit');
      const { rows: [d] } = await c.query(
        'INSERT INTO decisions (facility_id, referral_id, evaluation_id, recommended_outcome, recommended_clinical_outcome, decision, override_reason, decided_by, cosigned_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING hard_stop_override, recommended_clinical_outcome',
        [FAC.a, refs.a, ev, 'do_not_admit', 'admit', 'admit', 'SYNTHETIC', U.reviewer, U.admin]);
      assert.equal(d.recommended_clinical_outcome, 'do_not_admit', 'writer-supplied clinical snapshot is overwritten');
      assert.equal(d.hard_stop_override, true);
    });

    await sub('T13: an amendment is Admin-only, names the latest decision, carries a reason; the original is never updated or deleted', async () => {
      await bind(c, FAC.a);
      const ev = await evaluate(c, FAC.a, refs.a, 'admit');
      const { rows: [orig] } = await c.query(DECIDE_SQL, [FAC.a, refs.a, ev, 'admit', 'admit', null, U.reviewer, null]);
      const a = (by, amends, reason) => [FAC.a, refs.a, ev, 'admit', 'do_not_admit', 'SYNTHETIC override', by, amends, reason];
      await expectFailure(c, AMEND_SQL, /only an Admin may amend/, a(U.reviewer, orig.id, 'SYNTHETIC: new information'));
      await expectFailure(c, AMEND_SQL, /"decisions_amendment_pair"/, a(U.admin, orig.id, null));
      await expectFailure(c, AMEND_SQL, /"decisions_amendment_reason_nonblank"/, a(U.admin, orig.id, '  '));
      await expectFailure(c, AMEND_SQL, /already has decision/, a(U.admin, null, null));
      const { rows: [{ id: am1 }] } = await c.query(AMEND_SQL, a(U.admin, orig.id, 'SYNTHETIC: new information'));
      assert.equal((await lastAudit(c))[0].action, 'decision.amended');
      await expectFailure(c, AMEND_SQL, /must name the latest decision/, a(U.admin, orig.id, 'SYNTHETIC: stale amendment'));
      await c.query(AMEND_SQL, a(U.admin2, am1, 'SYNTHETIC: amended again'));
      await expectFailure(c, "UPDATE decisions SET decision = 'do_not_admit' WHERE id = $1", /immutable/, [orig.id]);
      await expectFailure(c, 'DELETE FROM decisions WHERE id = $1', /immutable/, [orig.id]);
      for (const role of ['codex_app', 'codex_worker']) {
        await c.query(`SET LOCAL ROLE ${role}`);
        await expectFailure(c, "UPDATE decisions SET override_reason = 'x' WHERE id = $1", /permission denied/, [orig.id]);
        await expectFailure(c, 'DELETE FROM decisions WHERE id = $1', /permission denied/, [orig.id]);
        await c.query('RESET ROLE');
      }
      assert.equal(await n(c, 'SELECT count(*) AS n FROM decisions WHERE referral_id = $1', [refs.a]), 3);
    });

    await sub('0005: evaluated_at and decided_at are pinned, so a writer cannot choose which evaluation is latest or fork an amendment chain', async () => {
      await bind(c, FAC.a);
      const { rows: [{ evaluated_at }] } = await c.query(EVAL_SQL.replace('VALUES ($1, $2, $3, $4, $4', "VALUES ($1, $2, $3, $4, $4").replace(") RETURNING id", ", '2999-01-01') RETURNING id, evaluated_at").replace("engine_version)", "engine_version, evaluated_at)"), [FAC.a, refs.a, false, 'admit', []]);
      assert.ok(evaluated_at.getFullYear() < 2999, 'writer-supplied evaluated_at is overwritten');
      const stale = await evaluate(c, FAC.a, refs.a, 'admit');
      const latest = await evaluate(c, FAC.a, refs.a, 'do_not_admit');
      await expectFailure(c, DECIDE_SQL, /is not the latest/, [FAC.a, refs.a, stale, 'admit', 'admit', null, U.reviewer, null]);
      const { rows: [orig] } = await c.query(DECIDE_SQL.replace('RETURNING id', 'RETURNING id, decided_at'), [FAC.a, refs.a, latest, 'do_not_admit', 'do_not_admit', null, U.reviewer, null]);
      const { rows: [{ decided_at }] } = await c.query('INSERT INTO decisions (facility_id, referral_id, evaluation_id, recommended_outcome, decision, override_reason, decided_by, amends_decision_id, amendment_reason, decided_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING decided_at',
        [FAC.a, refs.a, latest, 'do_not_admit', 'do_not_admit', null, U.admin, orig.id, 'SYNTHETIC: amended', '2000-01-01']);
      assert.ok(decided_at.getFullYear() > 2000, 'writer-supplied decided_at is overwritten');
      await expectFailure(c, AMEND_SQL, /must name the latest decision|"decisions_one_amendment_per_decision"/, [FAC.a, refs.a, latest, 'do_not_admit', 'do_not_admit', null, U.admin2, orig.id, 'SYNTHETIC: second amendment of the original']);
    });

    await sub('0005: one successor per fact, created_by takes the actor shapes, a document reason only changes with its status', async () => {
      await bind(c, FAC.a);
      const ai = `INSERT INTO facts (facility_id, referral_id, key, value, source, evidence, confidence_band, created_by, supersedes) VALUES ($1, $2, 'k', '{"type":"tri_state","value":"yes"}', 'ai', $3, 'high', $4, $5) RETURNING id`;
      const { rows: [{ id: f1 }] } = await c.query(ai, [FAC.a, refs.a, EV, 'worker:job-1', null]);
      await c.query(ai, [FAC.a, refs.a, EV, 'worker:job-2', f1]);
      await expectFailure(c, ai, /"facts_one_successor_per_fact"|must supersede the latest/, [FAC.a, refs.a, EV, 'worker:job-3', f1]);
      await expectFailure(c, ai.replace("'k'", "'k_name'"), /"facts_created_by_check"/, [FAC.a, refs.a, EV, 'user:ZZTEST.Nurse.Jane', null]);
      await expectFailure(c, ai.replace("'k'", "'k_upper'"), /"facts_created_by_check"/, [FAC.a, refs.a, EV, 'worker:ZZTEST', null]);
      const doc = await insertDoc(FAC.a, refs.a, 'r1');
      await c.query('SET LOCAL ROLE codex_app');
      await expectFailure(c, "UPDATE documents SET not_applicable_reason = 'SYNTHETIC rewrite' WHERE id = $1", /reason may only change together with its status/, [doc]);
      await c.query("UPDATE documents SET status = 'not_applicable', not_applicable_reason = 'SYNTHETIC: duplicate' WHERE id = $1", [doc]);
      await expectFailure(c, "UPDATE documents SET not_applicable_reason = 'SYNTHETIC rewrite' WHERE id = $1", /reason may only change together with its status/, [doc]);
      await c.query('RESET ROLE');
    });

    await sub('grants: the worker reads documents, facts and evaluations and never decisions; it cannot insert documents or decisions', async () => {
      await bind(c, FAC.a);
      const ev = await evaluate(c, FAC.a, refs.a, 'admit');
      await c.query('SET LOCAL ROLE codex_worker');
      for (const tbl of ['documents', 'facts', 'evaluations']) await c.query(`SELECT count(*) FROM ${tbl}`);
      await expectFailure(c, 'SELECT count(*) FROM decisions', /permission denied/);
      await expectFailure(c, DECIDE_SQL, /permission denied/, [FAC.a, refs.a, ev, 'admit', 'admit', null, U.reviewer, null]);
      await c.query('RESET ROLE');
    });
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
});

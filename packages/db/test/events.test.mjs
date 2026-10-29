// product_events (migration 0004, SPEC §14.1): the per-event attrs allowlist, append-only, tenant-scoped.
// One rolled-back transaction; skips without DATABASE_URL (fails where REQUIRE_DATABASE is set).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url && process.env.REQUIRE_DATABASE) throw new Error('DATABASE_URL must be set here: the database suite may not be skipped in the db-checks job');

const ORG = '00000000-0000-4000-8000-00000000c001';
const FAC = { a: '00000000-0000-4000-8000-00000000fca1', b: '00000000-0000-4000-8000-00000000fcb1' };
const UUID = '00000000-0000-4000-8000-00000000cc01';
const bind = async (c, facility) => {
  await c.query("SELECT set_config('app.facility_id', $1, true)", [facility]);
  await c.query("SELECT set_config('app.organization_id', $1, true)", [ORG]);
};
async function rejects(c, fn, pattern) {
  await c.query('SAVEPOINT expect_fail');
  await assert.rejects(fn(), pattern);
  await c.query('ROLLBACK TO SAVEPOINT expect_fail');
}

test('product_events', { skip: !url && 'DATABASE_URL not set' }, async (t) => {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query('BEGIN');
  const sub = (name, fn) => t.test(name, async () => {
    await c.query('SAVEPOINT sub');
    try { await fn(); } finally { await c.query('ROLLBACK TO SAVEPOINT sub'); }
  });
  try {
    await bind(c, '');
    await c.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [ORG, 'ZZTEST Events Org']);
    const refs = {};
    for (const [k, id] of Object.entries(FAC)) {
      await bind(c, id);
      await c.query('INSERT INTO facilities (facility_id, organization_id, name) VALUES ($1, $2, $3)', [id, ORG, `ZZTEST Events Facility ${k}`]);
      refs[k] = (await c.query('INSERT INTO referrals (facility_id) VALUES ($1) RETURNING id', [id])).rows[0].id;
    }
    // No RETURNING: the worker has INSERT only, and RETURNING would need SELECT.
    const emit = (fac, ref, event, attrs, actor = `user:${UUID}`) =>
      c.query('INSERT INTO product_events (facility_id, referral_id, actor, event, attrs) VALUES ($1, $2, $3, $4, $5)', [fac, ref, actor, event, attrs]);

    await sub('every §14.1 event is accepted with its allowed attrs, and ids/numbers/codes only', async () => {
      await bind(c, FAC.a);
      const ok = [
        ['referral.received', { received_at: '2001-01-01T10:00:00Z' }],
        ['referral.uploaded', { document_id: UUID, pages: 12, bytes: 1048576 }],
        ['document.processed', { document_id: UUID, pages_ocr: 12, duration_ms: 4200 }],
        ['document.failed', { document_id: UUID, pages_ocr: 0, stage: 'ocr', duration_ms: 10 }],
        ['referral.ready', { evaluation_id: UUID, outcome: 'needs_review', sub_reasons: ['missing_info', 'clinical'], blocking_count: 3 }],
        ['review.started', { screen: 'recommendation' }],
        ['review.ended', { screen: 'recommendation', active_ms: 90000 }],
        ['evidence.viewed', { fact_key: 'ventilator_use', document_id: UUID, page: 3, decisive: true }],
        ['fact.confirmed', { fact_key: 'ventilator_use', decisive: true }],
        ['fact.corrected', { decisive: true }],                 // fact_key omitted (specially protected keys must omit it)
        ['evidence.viewed', { fact_key: 'k'.repeat(40), document_id: UUID, page: 1, decisive: false }],   // boundary: 40 chars
        ['fact.entered', { fact_key: 'dialysis_schedule', decisive: false }],
        ['evaluation.created', { evaluation_id: UUID, previous_evaluation_id: UUID, raw: false, outcome: 'admit', changed_fact_count: 1 }],
        ['decision.finalized', { decision_id: UUID, evaluation_id: UUID, outcome: 'admit', override: false, cosigner_present: false, decisive_fact_count: 4, decisive_viewed_count: 4 }],
        ['decision.amended', { decision_id: UUID, evaluation_id: UUID, outcome: 'do_not_admit', override: true, cosigner_present: true, decisive_fact_count: 4, decisive_viewed_count: 3 }],
        ['referral.held', {}],
        ['referral.info_requested', { items_requested: 2 }],
        ['referral.escalated', { department: 'director_of_nursing' }],
        ['pilot.outcome_recorded', { decision_id: UUID, cause: 'human_judgment' }],
        ['pilot.adjudicated', { decision_id: UUID, cause: 'incorrect_extraction', verdict: 'tool_correct' }],
      ];
      for (const [event, attrs] of ok) await emit(FAC.a, refs.a, event, attrs);
      await emit(FAC.a, refs.a, 'document.processed', { document_id: UUID }, 'worker:job-0001'); // partial attrs are fine
      assert.equal((await c.query('SELECT count(*) AS n FROM product_events')).rows[0].n, String(ok.length + 1));
      const { rows: [{ at }] } = await c.query("INSERT INTO product_events (facility_id, referral_id, actor, event, attrs, at) VALUES ($1, $2, $3, 'referral.held', '{}', '1899-01-01') RETURNING at", [FAC.a, refs.a, `user:${UUID}`]);
      assert.ok(at.getFullYear() > 2001, 'writer-supplied at is overwritten');
    });

    await sub('a value, a quote or a name cannot get in: unknown events, unknown keys and wrong shapes are refused', async () => {
      await bind(c, FAC.a);
      const bad = [
        ['packet.read', {}],
        ['referral.held', { note: 'SYNTHETIC patient note' }],
        ['fact.corrected', { fact_key: 'ventilator_use', from: 'yes', to: 'no' }],
        ['evidence.viewed', { fact_key: 'ventilator_use', document_id: 'doc_zztest_0001', page: 3, decisive: true }],
        ['evidence.viewed', { fact_key: 'ZZTEST Patient', document_id: UUID, page: 3, decisive: true }],
        ['evidence.viewed', { fact_key: 'ventilator_use', document_id: UUID, page: -1, decisive: true }],
        ['evidence.viewed', { fact_key: 'ventilator_use', document_id: UUID, page: 3, decisive: 'yes' }],
        ['review.ended', { screen: 'recommendation', active_ms: 1.5 }],
        ['referral.ready', { evaluation_id: UUID, outcome: 'needs_review', sub_reasons: ['Missing Info'], blocking_count: 1 }],
        ['referral.ready', { evaluation_id: UUID, outcome: 'needs_review', sub_reasons: 'missing_info', blocking_count: 1 }],
        ['referral.received', { received_at: 'yesterday' }],
        ['referral.received', { received_at: '2001-01-01 10:00' }],
        // closed vocabularies: a lowercase snake_case sentence or name is still refused
        ['referral.escalated', { department: 'dr_zztest_smith_said_no_bed_for_this_mrn' }],
        ['referral.escalated', { department: 'x'.repeat(65) }],
        ['referral.ready', { evaluation_id: UUID, outcome: 'patient_remains_ventilator_dependent', sub_reasons: [], blocking_count: 0 }],
        ['referral.ready', { evaluation_id: UUID, outcome: 'admit', sub_reasons: ['missing_info', 'missing_info', 'missing_info', 'missing_info', 'missing_info', 'missing_info'], blocking_count: 0 }],
        ['review.started', { screen: 'patient_zztest_canary_alpha' }],
        ['document.failed', { document_id: UUID, pages_ocr: 0, stage: 'patient_refused', duration_ms: 1 }],
        ['pilot.adjudicated', { decision_id: UUID, cause: 'nurse_said_so', verdict: 'tool_correct' }],
        ['pilot.adjudicated', { decision_id: UUID, cause: 'human_judgment', verdict: 'maybe' }],
        ['evidence.viewed', { fact_key: 'patient_remains_ventilator_dependent_via_tracheostomy', document_id: UUID, page: 1, decisive: true }],
        ['evidence.viewed', { fact_key: 'ventilator_use', document_id: UUID.toUpperCase(), page: 1, decisive: true }],
        ['referral.uploaded', { document_id: UUID, pages: 1234567890123456789, bytes: 1 }],
      ];
      for (const [event, attrs] of bad) await rejects(c, () => emit(FAC.a, refs.a, event, attrs), /"product_events_attrs_allowlisted"/);
      await rejects(c, () => c.query("INSERT INTO product_events (facility_id, referral_id, actor, event, attrs) VALUES ($1, $2, $3, 'referral.held', '[]')", [FAC.a, refs.a, `user:${UUID}`]), /"product_events_attrs_allowlisted"/);
      for (const actor of ['ZZTEST Nurse', 'user:zztest.canary-alpha', `system:${UUID}`, 'worker:ZZTEST', `worker:${'j'.repeat(65)}`, `user:${UUID.toUpperCase()}`]) {
        await rejects(c, () => emit(FAC.a, refs.a, 'referral.held', {}, actor), /"product_events_actor_check"/);
      }
      await rejects(c, () => emit(FAC.a, refs.a, 'referral.received', { received_at: '1899-02-30T00:00:00Z' }), /date\/time field value out of range|outside the plausible range/);
      await rejects(c, () => emit(FAC.a, refs.a, 'referral.received', { received_at: '2099-01-01T00:00:00Z' }), /outside the plausible range/);
    });

    await sub('a specially protected fact key never appears in an event', async () => {
      await bind(c, FAC.a);
      await c.query(`INSERT INTO facts (facility_id, referral_id, key, value, source, note, specially_protected, created_by)
        VALUES ($1, $2, 'substance_use_history', '{"type":"tri_state","value":"yes"}', 'user', 'SYNTHETIC', true, $3)`, [FAC.a, refs.a, `user:${UUID}`]);
      for (const event of ['fact.confirmed', 'fact.corrected', 'fact.entered']) {
        await rejects(c, () => emit(FAC.a, refs.a, event, { fact_key: 'substance_use_history', decisive: false }), /must be omitted for a specially protected fact/);
        await emit(FAC.a, refs.a, event, { decisive: false });
      }
      await rejects(c, () => emit(FAC.a, refs.a, 'evidence.viewed', { fact_key: 'substance_use_history', document_id: UUID, page: 1, decisive: false }), /must be omitted for a specially protected fact/);
      await emit(FAC.a, refs.a, 'fact.confirmed', { fact_key: 'ventilator_use', decisive: true }); // an ordinary key is fine
    });

    await sub('append-only and tenant-scoped: no UPDATE for anyone, DELETE only by the owner, no cross-facility rows', async () => {
      await bind(c, FAC.a);
      const { rows: [{ id }] } = await c.query("INSERT INTO product_events (facility_id, referral_id, actor, event, attrs) VALUES ($1, $2, $3, 'referral.held', '{}') RETURNING id", [FAC.a, refs.a, `user:${UUID}`]);
      await rejects(c, () => c.query("UPDATE product_events SET event = 'referral.escalated' WHERE id = $1", [id]), /immutable/);
      for (const role of ['codex_app', 'codex_worker']) {
        await c.query(`SET LOCAL ROLE ${role}`);
        await rejects(c, () => c.query("UPDATE product_events SET event = 'referral.escalated' WHERE id = $1", [id]), /permission denied/);
        await rejects(c, () => c.query('DELETE FROM product_events WHERE id = $1', [id]), /permission denied/);
        await emit(FAC.a, refs.a, 'review.started', { screen: 'queue' }, role === 'codex_app' ? `user:${UUID}` : 'worker:job-1');
        await rejects(c, () => emit(FAC.b, refs.b, 'referral.held', {}), /row-level security/);
        if (role === 'codex_worker') await rejects(c, () => c.query('SELECT count(*) FROM product_events'), /permission denied/);
        await c.query('RESET ROLE');
      }
      await rejects(c, () => emit(FAC.a, refs.b, 'referral.held', {}), /"product_events_facility_id_referral_id_fkey"/);
      assert.equal((await c.query('DELETE FROM product_events WHERE id = $1', [id])).rowCount, 1, 'the owner may delete (purge)');
      // purge with the referral: deleting the referral takes its events with it
      await c.query('SAVEPOINT cascade');
      await c.query('DELETE FROM referrals WHERE facility_id = $1 AND id = $2', [FAC.a, refs.a]);
      assert.equal((await c.query('SELECT count(*) AS n FROM product_events WHERE referral_id = $1', [refs.a])).rows[0].n, '0');
      await c.query('ROLLBACK TO SAVEPOINT cascade');
    });
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
});

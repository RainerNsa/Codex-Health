// Cross-facility isolation, organisation isolation, audit immutability, the hash chain and provisioning
// coupling, against a migrated local database (SPEC §12 XF-1, XF-2, XF-9, XF-10; I3, I4). Skips cleanly
// without DATABASE_URL on a developer machine and in the CI `checks` job, and FAILS without it where a
// database is promised (the CI db-checks job sets REQUIRE_DATABASE): a skipped gate is not green.
// Every subtest runs in its own savepoint over one outer transaction that is rolled back at the end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { runChecks } from '../check.mjs';

const url = process.env.DATABASE_URL;
if (!url && process.env.REQUIRE_DATABASE) throw new Error('DATABASE_URL must be set here: the database suite may not be skipped in the db-checks job');

// Fixed, obviously synthetic ids: 2 orgs x 2 facilities (dev-alignment 1.9 seed shape).
// The "...e..." range is reserved for this test; scripts/dev/seed-synthetic.mjs uses "...a001/f0a1..."
// so the test never collides with a seeded local database.
const ORG = ['00000000-0000-4000-8000-00000000e001', '00000000-0000-4000-8000-00000000e002'];
const FAC = {
  a1: '00000000-0000-4000-8000-00000000fea1',
  a2: '00000000-0000-4000-8000-00000000fea2',
  b1: '00000000-0000-4000-8000-00000000feb1',
  b2: '00000000-0000-4000-8000-00000000feb2',
};
const ORG_OF = { a1: ORG[0], a2: ORG[0], b1: ORG[1], b2: ORG[1] };
const USER = { a: '00000000-0000-4000-8000-00000000ee01', b: '00000000-0000-4000-8000-00000000ee02' };
const ORG_TABLES = ['organizations', 'users', 'platform_audit_log'];

const asFacility = (c, id) => c.query("SELECT set_config('app.facility_id', $1, true)", [id]);
const asOrg = (c, id) => c.query("SELECT set_config('app.organization_id', $1, true)", [id]);
const count = async (c, sql, params) => Number((await c.query(sql, params)).rows[0].n);
// Writer-supplied seq 0 and a '\x00' hash: the trigger must overwrite both.
const audit = (c, facility, action = 'seed') =>
  c.query("INSERT INTO audit_log (facility_id, seq, row_hash, actor, action, entity_type) VALUES ($1, 0, '\\x00', 'system:test', $2, 'facility')", [facility, action]);
const verify = async (c, facility) => (await c.query('SELECT ok FROM audit_chain_verify($1)', [facility])).rows.map((r) => r.ok);

/** Tenant tables as the enumeration check sees them, so the suite never trails the schema (§12 XF-1). */
async function tenantTables(c) {
  const { rows } = await c.query(`
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
      AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'facility_id' AND NOT a.attisdropped)
    ORDER BY 1`);
  return rows.map((r) => r.relname);
}

// Every tenant table gets at least one row in BOTH organisations' facilities, so a "sees nothing foreign"
// assertion can never pass for lack of foreign rows.
async function seed(c) {
  for (const [i, id] of ORG.entries()) {
    await asOrg(c, id); // FORCE RLS binds the owner too; provisioning_audit requires the binding
    await c.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [id, `ZZTEST Org ${i}`]);
  }
  for (const [k, uid] of Object.entries(USER)) {
    await asOrg(c, k === 'a' ? ORG[0] : ORG[1]);
    await c.query('INSERT INTO users (id, organization_id, email, display_name) VALUES ($1, $2, $3, $4)', [
      uid, k === 'a' ? ORG[0] : ORG[1], `zztest.${k}@example.invalid`, `ZZTEST User ${k}`,
    ]);
  }
  for (const [key, id] of Object.entries(FAC)) {
    await asFacility(c, id);
    await asOrg(c, ORG_OF[key]);
    await c.query('INSERT INTO facilities (facility_id, organization_id, name) VALUES ($1, $2, $3)', [id, ORG_OF[key], `ZZTEST Facility ${key}`]);
    await c.query('INSERT INTO referrals (facility_id) VALUES ($1)', [id]);
    const user = key.startsWith('a') ? USER.a : USER.b;
    await c.query("INSERT INTO user_facility_roles (user_id, facility_id, role) VALUES ($1, $2, 'admissions_reviewer')", [user, id]);
    await audit(c, id);
    // one row per facility in every slice-2 table, so the per-table isolation assertions are never vacuous
    const ref = (await c.query('SELECT id FROM referrals WHERE facility_id = $1', [id])).rows[0].id;
    await c.query(
      `INSERT INTO documents (facility_id, referral_id, type, sha256, storage_key)
       VALUES ($1::uuid, $2::uuid, 'face_sheet', sha256(convert_to($3::text, 'UTF8')), 'documents/' || $1::uuid::text || '/' || $2::uuid::text || '/' || encode(sha256(convert_to($3::text, 'UTF8')), 'hex'))`,
      [id, ref, key],
    );
    await c.query(
      `INSERT INTO facts (facility_id, referral_id, key, value, source, note, created_by)
       VALUES ($1, $2, 'ventilator_use', '{"type":"tri_state","value":"no"}', 'user', 'SYNTHETIC seed', $3)`,
      [id, ref, `user:${user}`],
    );
    const ev = (await c.query(
      `INSERT INTO evaluations (facility_id, referral_id, raw, outcome, clinical_outcome, financial_status, trace,
         criteria_document_ref, rule_set_version, facility_profile_version, model_id, prompt_version, extractor_version, ocr_engine_version, engine_version)
       VALUES ($1, $2, false, 'admit', 'admit', 'clear', '{}', 'seed', 1, 1, 'none', 'p0', 'x0', 'o0', 'e0') RETURNING id`,
      [id, ref],
    )).rows[0].id;
    await c.query(
      "INSERT INTO decisions (facility_id, referral_id, evaluation_id, recommended_outcome, decision, decided_by) VALUES ($1, $2, $3, 'admit', 'admit', $4)",
      [id, ref, ev, user],
    );
    await c.query("INSERT INTO product_events (facility_id, referral_id, actor, event, attrs) VALUES ($1, $2, $3, 'referral.held', '{}')", [id, ref, `user:${user}`]);
    await c.query("INSERT INTO facility_profiles (facility_id, version, capabilities, created_by) VALUES ($1, 0, '{\"accepts_ventilator\": false}', 'platform:test')", [id]);
    // one transition per facility (0009): the owner puts the referral in review, the Reviewer holds it
    await c.query("UPDATE referrals SET status = 'ready_for_review' WHERE facility_id = $1", [id]);
    await c.query("INSERT INTO decision_requests (facility_id, referral_id, evaluation_id, decision, requested_by) VALUES ($1, $2, $3, 'admit', $4)", [id, ref, ev, user]);
    await c.query("INSERT INTO referral_transitions (facility_id, referral_id, transition, from_status, to_status, note, created_by) VALUES ($1, $2, 'T8', 'ready_for_review', 'on_hold', 'SYNTHETIC hold', $3)", [id, ref, `user:${user}`]);
  }
}

async function expectFailure(c, sql, pattern, params = []) {
  await c.query('SAVEPOINT expect_fail');
  await assert.rejects(c.query(sql, params), pattern);
  await c.query('ROLLBACK TO SAVEPOINT expect_fail');
}

test('row-level security, organisation isolation, audit immutability, the hash chain and provisioning', { skip: !url && 'DATABASE_URL not set' }, async (t) => {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query('BEGIN');
  // Each subtest is isolated: a SQL error inside one cannot abort the others.
  const sub = (name, fn) => t.test(name, async () => {
    await c.query('SAVEPOINT sub');
    try { await fn(); } finally { await c.query('ROLLBACK TO SAVEPOINT sub'); }
  });
  try {
    await seed(c);
    const tables = await tenantTables(c);
    assert.ok(tables.includes('referrals') && tables.includes('audit_log') && tables.includes('user_facility_roles') && tables.includes('facilities'));

    for (const role of ['codex_app', 'codex_worker']) {
      await sub(`XF-1/XF-2: ${role} sees only its own facility on every tenant table, nothing when unbound`, async () => {
        await c.query(`SET LOCAL ROLE ${role}`);
        await asFacility(c, FAC.a1);
        await asOrg(c, ORG[0]);
        let checked = 0;
        for (const tbl of tables) {
          const readable = (await c.query('SELECT has_any_column_privilege($1, $2, $3) AS ok', [role, `public.${tbl}`, 'SELECT'])).rows[0].ok;
          if (!readable) {
            await expectFailure(c, `SELECT facility_id FROM ${tbl}`, /permission denied/);
            continue;
          }
          checked += 1;
          assert.ok((await count(c, `SELECT count(facility_id) AS n FROM ${tbl}`)) >= 1, `${tbl}: own rows must be visible, or the next assertion is vacuous`);
          assert.equal(await count(c, `SELECT count(facility_id) AS n FROM ${tbl} WHERE facility_id <> $1`, [FAC.a1]), 0, `${tbl} leaks across facilities for ${role}`);
          await asFacility(c, '');
          assert.equal(await count(c, `SELECT count(facility_id) AS n FROM ${tbl}`), 0, `${tbl} visible with no tenant bound for ${role}`);
          await asFacility(c, FAC.a1);
        }
        // Exact readable-table count per role: a dropped or added SELECT grant must be a visible change here.
        assert.equal(checked, { codex_app: 12, codex_worker: 6 }[role], `${role} could read ${checked} tenant tables`);
      });
    }

    await sub('XF-9: the owner role, unbound, sees zero rows on every tenant and organisation table', async () => {
      await asFacility(c, '');
      await asOrg(c, '');
      for (const tbl of [...tables, ...ORG_TABLES]) assert.equal(await count(c, `SELECT count(*) AS n FROM ${tbl}`), 0, `${tbl} visible to the unbound owner`);
    });

    await sub('organisation isolation: org B rows are invisible when bound to org A, and nothing crosses on insert', async () => {
      await asOrg(c, ORG[0]);
      await expectFailure(c, "INSERT INTO organizations (id, name) VALUES ('00000000-0000-4000-8000-00000000e003', 'ZZTEST Org C')", /row-level security/);
      await expectFailure(c, "INSERT INTO users (id, organization_id, email, display_name) VALUES ('00000000-0000-4000-8000-00000000ee03', $1, 'zztest.c@example.invalid', 'ZZTEST C')", /row-level security/, [ORG[1]]);
      await c.query('SET LOCAL ROLE codex_app');
      for (const tbl of ['organizations', 'users']) {
        const col = tbl === 'organizations' ? 'id' : 'organization_id';
        assert.ok((await count(c, `SELECT count(*) AS n FROM ${tbl}`)) >= 1, `${tbl}: own rows visible`);
        assert.equal(await count(c, `SELECT count(*) AS n FROM ${tbl} WHERE ${col} <> $1`, [ORG[0]]), 0, `${tbl} leaks across organisations`);
      }
      await asFacility(c, FAC.a1);
      assert.equal(await count(c, 'SELECT count(*) AS n FROM users u JOIN user_facility_roles r ON r.user_id = u.id'), 1, 'join reaches only the bound org user at the bound facility');
      await asOrg(c, '');
      assert.equal(await count(c, 'SELECT count(*) AS n FROM users'), 0);
    });

    await sub('XF-10: every organisation, facility and user insert writes one platform audit row, bound to its own org', async () => {
      await asOrg(c, ORG[0]);
      const before = await count(c, 'SELECT count(*) AS n FROM platform_audit_log');
      assert.equal(before, 1 + 1 + 2, 'seed: org + user + two facilities for org A');
      const kinds = (await c.query('SELECT action, entity_type FROM platform_audit_log ORDER BY seq')).rows;
      assert.deepEqual(kinds.map((r) => r.action), ['organization.created', 'user.created', 'facility.created', 'facility.created']);
      assert.ok(kinds.every((r) => `${r.entity_type}.created` === r.action));
      // bound to A, a facility for B is refused by the provisioning trigger (the facility policy alone would allow it)
      await asFacility(c, '00000000-0000-4000-8000-00000000feb3');
      await expectFailure(c, "INSERT INTO facilities (facility_id, organization_id, name) VALUES ('00000000-0000-4000-8000-00000000feb3', $1, 'ZZTEST stray')", /provisioning: facilities insert/, [ORG[1]]);
      await asOrg(c, '');
      await expectFailure(c, "INSERT INTO organizations (id, name) VALUES ('00000000-0000-4000-8000-00000000e003', 'ZZTEST Org C')", /row-level security|provisioning/);
    });

    await sub('audit_log and platform_audit_log reject UPDATE and DELETE for the app role and for the owner', async () => {
      await asFacility(c, FAC.a1);
      await asOrg(c, ORG[0]);
      for (const tbl of ['audit_log', 'platform_audit_log']) {
        await expectFailure(c, `UPDATE ${tbl} SET action = 'tampered'`, /append-only/);
        await expectFailure(c, `DELETE FROM ${tbl}`, /append-only/);
      }
      await c.query('SET LOCAL ROLE codex_app');
      await expectFailure(c, "UPDATE audit_log SET action = 'tampered'", /permission denied|append-only/);
      await expectFailure(c, 'DELETE FROM audit_log', /permission denied|append-only/);
    });

    await sub('the chain is computed by the trigger, never by the writer, and verifies for both facilities and the platform chain', async () => {
      await asFacility(c, FAC.a1);
      const base = await count(c, 'SELECT count(*) AS n FROM audit_log');
      assert.equal(base, 6, 'the seed wrote exactly six rows per facility: user_role.granted (0005), audit(), decision.finalized, facility_profile.versioned (0008), decision.cosign_requested (0010), referral.held (0009)');
      await audit(c, FAC.a1, 'referral.created');
      await c.query("INSERT INTO audit_log (facility_id, seq, row_hash, actor, action, entity_type, at) VALUES ($1, 0, '\\x00', 'system:test', 'backdated', 'facility', '2001-01-01')", [FAC.a1]);
      const { rows } = await c.query('SELECT seq, prev_hash, row_hash, at FROM audit_log WHERE facility_id = $1 ORDER BY seq', [FAC.a1]);
      assert.deepEqual(rows.map((r) => Number(r.seq)), rows.map((_, i) => i + 1), 'writer-supplied seq 0 was overwritten; seq is dense from 1');
      assert.equal(rows.length, base + 2);
      assert.equal(rows[0].prev_hash, null);
      assert.ok(rows.every((r) => r.row_hash.length === 32 && !r.row_hash.equals(Buffer.from([0]))), 'writer-supplied hash was overwritten');
      for (let i = 1; i < rows.length; i += 1) assert.ok(rows[i].prev_hash.equals(rows[i - 1].row_hash), `row ${i + 1} chains to its predecessor`);
      assert.ok(rows.at(-1).at.getFullYear() > 2001, 'writer-supplied at was overwritten');
      assert.deepEqual(await verify(c, FAC.a1), rows.map(() => true));
      await asFacility(c, FAC.b1);
      const vb = await verify(c, FAC.b1);
      assert.ok(vb.length >= 1 && vb.every(Boolean));
      await asFacility(c, FAC.a2);
      await assert.rejects(c.query('SELECT ok FROM audit_chain_verify($1)', [FAC.b1]), /no audit rows visible/, 'verifying a facility you cannot see is an error, not a pass');
      await c.query('ROLLBACK TO SAVEPOINT sub'); await c.query('SAVEPOINT sub');
      await asOrg(c, ORG[0]);
      await c.query("INSERT INTO platform_audit_log (organization_id, actor, action, entity_type) VALUES ($1, 'platform:test', 'user.created', 'user')", [ORG[0]]);
      const pv = (await c.query('SELECT ok FROM platform_audit_chain_verify($1)', [ORG[0]])).rows.map((r) => r.ok);
      assert.deepEqual(pv, [true, true, true, true, true]);
      await expectFailure(c, "INSERT INTO platform_audit_log (organization_id, actor, action, entity_type) VALUES ($1, 'worker:j1', 'x', 'user')", /platform_audit_log_actor_check/, [ORG[0]]);
    });

    await sub('tamper test: a rewritten row and a deleted row fail verification; the grants check names the disabled trigger', async () => {
      await asFacility(c, FAC.a1);
      await audit(c, FAC.a1, 'two');
      await audit(c, FAC.a1, 'three');
      const n = await count(c, 'SELECT count(*) AS n FROM audit_log');
      const victim = n - 1; // second-to-last row, so a successor exists
      await c.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_immutable');
      await c.query("UPDATE audit_log SET action = 'tampered' WHERE facility_id = $1 AND seq = $2", [FAC.a1, victim]);
      const v1 = await verify(c, FAC.a1);
      assert.deepEqual(v1.map((ok, i) => (ok ? null : i + 1)).filter(Boolean), [victim], 'only the rewritten row fails; its successor still chains to the stored hash');
      await c.query('DELETE FROM audit_log WHERE facility_id = $1 AND seq = $2', [FAC.a1, victim]);
      const v2 = await verify(c, FAC.a1);
      assert.equal(v2.length, n - 1);
      assert.equal(v2.at(-1), false, 'the row after a gap fails');
      assert.ok(v2.slice(0, -1).every(Boolean));
      const failures = await runChecks(c);
      assert.match(JSON.stringify(failures['grants.sql'] ?? []), /no ENABLE ALWAYS statement-level trigger.*audit_log/);
    });

    await sub('audit rows carry ids, never names: malformed actor, action and entity_type are rejected', async () => {
      await asFacility(c, FAC.a1);
      const ins = (actor, action, entity) => `INSERT INTO audit_log (facility_id, seq, row_hash, actor, action, entity_type) VALUES ('${FAC.a1}', 0, '\\x00', '${actor}', '${action}', '${entity}')`;
      await expectFailure(c, ins('ZZTEST Nurse', 'seed', 'facility'), /audit_log_actor_format/);
      await expectFailure(c, ins('system:test', 'Seed Row', 'facility'), /audit_log_action_format/);
      await expectFailure(c, ins('system:test', 'seed', 'Facility'), /audit_log_entity_type_format/);
    });

    await sub('a writer bound to facility A cannot append to facility B chain', async () => {
      await c.query('SET LOCAL ROLE codex_app');
      await asFacility(c, FAC.a1);
      await expectFailure(c, "INSERT INTO audit_log (facility_id, seq, row_hash, actor, action, entity_type) VALUES ($1, 0, '\\x00', 'system:test', 'seed', 'facility')", /row-level security/, [FAC.b1]);
    });

    await sub('SPEC §5.2: the worker may move an in-flight referral to processing, partial_failure or ready_for_review, and nothing else', async () => {
      await asFacility(c, FAC.a1);
      await c.query("UPDATE referrals SET status = 'processing' WHERE facility_id = $1", [FAC.a1]); // T1 by a Reviewer
      await c.query('SET LOCAL ROLE codex_worker');
      for (const to of ['partial_failure', 'processing', 'ready_for_review']) {
        assert.equal((await c.query(`UPDATE referrals SET status = '${to}' WHERE facility_id = $1`, [FAC.a1])).rowCount, 1, `worker → ${to}`);
        if (to === 'ready_for_review') break;
      }
      await expectFailure(c, "UPDATE referrals SET status = 'processing' WHERE facility_id = $1", /codex_worker may not move/, [FAC.a1]); // from ready_for_review
      await c.query('RESET ROLE');
      await c.query("UPDATE referrals SET status = 'finalized' WHERE facility_id = $1", [FAC.a1]);
      await c.query('SET LOCAL ROLE codex_worker');
      await expectFailure(c, "UPDATE referrals SET status = 'processing' WHERE facility_id = $1", /codex_worker may not move/, [FAC.a1]); // never from finalized
      await expectFailure(c, "UPDATE referrals SET status = 'finalized' WHERE facility_id = $1", /codex_worker may not move/, [FAC.a1]);
      await c.query('RESET ROLE');
      await c.query('SET LOCAL ROLE codex_app');
      // the worker guard binds only the worker; the app role moves a referral only through referral_transitions (0009)
      await expectFailure(c, "UPDATE referrals SET status = 'amended' WHERE facility_id = $1", /permission denied/, [FAC.a1]);
      // the one column the app may name in an UPDATE exists for row locks only; the guard refuses the write itself
      await expectFailure(c, 'UPDATE referrals SET updated_at = now() WHERE facility_id = $1', /only through referral_transitions/, [FAC.a1]);
      await expectFailure(c, "INSERT INTO referrals (facility_id, status) VALUES ($1, 'finalized')", /permission denied/, [FAC.a1]);
      // no temporary tables for the app role: they would shadow the tables the guards read (re-review of PR #24)
      await expectFailure(c, 'CREATE TEMP TABLE referrals (facility_id uuid, id uuid, status referral_status)', /permission denied/);
    });

    await sub('concurrency: a second session holding one facility chain lock blocks an append to it, not to another facility', async () => {
      // This transaction already holds the locks of every seeded facility (the trigger took them), so the
      // second session locks a facility this transaction has never touched; the BEFORE trigger waits on that
      // lock before any FK check runs, which is exactly the serialisation point under test.
      const FRESH = '00000000-0000-4000-8000-00000000fef1';
      const other = new pg.Client({ connectionString: url });
      await other.connect();
      try {
        await other.query('BEGIN');
        await other.query("SELECT pg_advisory_xact_lock(hashtext('audit_log'), hashtext($1))", [FRESH]);
        await c.query("SET LOCAL statement_timeout = '400ms'");
        await asFacility(c, FRESH);
        await expectFailure(c, "INSERT INTO audit_log (facility_id, seq, row_hash, actor, action, entity_type) VALUES ($1, 0, '\\x00', 'system:test', 'blocked', 'facility')", /statement timeout/, [FRESH]);
        await asFacility(c, FAC.b1);
        const nb = await count(c, 'SELECT count(*) AS n FROM audit_log');
        await audit(c, FAC.b1, 'unblocked');
        const vb = await verify(c, FAC.b1);
        assert.equal(vb.length, nb + 1);
        assert.ok(vb.every(Boolean));
      } finally {
        await other.query('ROLLBACK');
        await other.end();
      }
    });

    await sub('privilege matrix: every table/column grant of the app, worker and anchor roles is exactly the expected set (any relkind)', async () => {
      const { rows } = await c.query(`
        SELECT grantee, table_name, privilege_type, string_agg(column_name, ',' ORDER BY column_name) AS cols
        FROM (
          SELECT grantee, table_name, privilege_type, NULL::text AS column_name FROM information_schema.role_table_grants
          WHERE grantee IN ('codex_app', 'codex_worker', 'codex_anchor') AND table_schema = 'public'
          UNION ALL
          SELECT g.grantee, g.table_name, g.privilege_type, g.column_name FROM information_schema.role_column_grants g
          WHERE g.grantee IN ('codex_app', 'codex_worker', 'codex_anchor') AND g.table_schema = 'public'
            AND NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants t
                            WHERE t.grantee = g.grantee AND t.table_name = g.table_name AND t.privilege_type = g.privilege_type AND t.table_schema = 'public')
        ) x
        GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`);
      const matrix = rows.map((x) => `${x.grantee} ${x.table_name} ${x.privilege_type}${x.cols ? ` (${x.cols})` : ''}`);
      assert.deepEqual(matrix, [
        'codex_anchor audit_log SELECT',
        'codex_anchor facilities SELECT (facility_id,organization_id)',
        'codex_anchor organizations SELECT (id)',
        'codex_anchor platform_audit_log SELECT',
        'codex_app audit_log INSERT', 'codex_app audit_log SELECT',
        'codex_app decision_requests INSERT', 'codex_app decision_requests SELECT',
        'codex_app decisions INSERT', 'codex_app decisions SELECT',
        'codex_app documents INSERT', 'codex_app documents SELECT', 'codex_app documents UPDATE (not_applicable_reason,status,updated_at)',
        'codex_app evaluations INSERT', 'codex_app evaluations SELECT',
        'codex_app facilities SELECT',
        'codex_app facility_profiles INSERT', 'codex_app facility_profiles SELECT',
        'codex_app facts INSERT', 'codex_app facts SELECT',
        'codex_app organizations SELECT',
        'codex_app product_events INSERT', 'codex_app product_events SELECT',
        'codex_app referral_transitions INSERT', 'codex_app referral_transitions SELECT',
        'codex_app referrals INSERT (facility_id)', 'codex_app referrals SELECT', 'codex_app referrals UPDATE (updated_at)',
        'codex_app rule_sets SELECT',
        'codex_app user_facility_roles SELECT',
        'codex_app users SELECT',
        'codex_worker audit_log INSERT', 'codex_worker audit_log SELECT',
        'codex_worker documents SELECT', 'codex_worker documents UPDATE (pages,status,updated_at)',
        'codex_worker evaluations INSERT', 'codex_worker evaluations SELECT',
        'codex_worker facilities SELECT',
        'codex_worker facts INSERT', 'codex_worker facts SELECT',
        'codex_worker product_events INSERT',
        'codex_worker referrals SELECT', 'codex_worker referrals UPDATE (status,updated_at)',
      ]);
      const views = await count(c, "SELECT count(*) AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('v', 'm')");
      assert.equal(views, 0, 'no view or materialized view exists in public (one would copy tenant rows out from under the policies)');
    });

    await sub('platform actors: any lowercase role name provisions; a user role grant needs the user and facility in one organisation and is audited', async () => {
      await asOrg(c, ORG[0]);
      await c.query("INSERT INTO platform_audit_log (organization_id, actor, action, entity_type) VALUES ($1, 'platform:codex_internal_admin_2', 'organization.created', 'organization')", [ORG[0]]);
      await expectFailure(c, "INSERT INTO platform_audit_log (organization_id, actor, action, entity_type) VALUES ($1, 'platform:Codex-Admin', 'x', 'organization')", /platform_audit_log_actor_check/, [ORG[0]]);
      await asFacility(c, FAC.b1);
      await asOrg(c, ORG[1]);
      // USER.a belongs to org A: granting at a B facility is refused even though the owner can see both ids
      await expectFailure(c, "INSERT INTO user_facility_roles (user_id, facility_id, role) VALUES ($1, $2, 'facility_admin')", /not visible in the same organisation/, [USER.a, FAC.b1]);
      const before = await count(c, 'SELECT count(*) AS n FROM audit_log');
      await c.query("INSERT INTO user_facility_roles (user_id, facility_id, role) VALUES ($1, $2, 'facility_admin')", [USER.b, FAC.b1]);
      await c.query("DELETE FROM user_facility_roles WHERE user_id = $1 AND facility_id = $2 AND role = 'facility_admin'", [USER.b, FAC.b1]);
      const { rows } = await c.query('SELECT action, actor, entity_id FROM audit_log ORDER BY seq DESC LIMIT 2');
      assert.deepEqual(rows.map((x) => x.action), ['user_role.revoked', 'user_role.granted']);
      assert.ok(rows.every((x) => x.entity_id === USER.b && x.actor.startsWith('platform:')));
      assert.equal(await count(c, 'SELECT count(*) AS n FROM audit_log'), before + 2);
    });

    await sub('settings (0008): shape checks, database-chosen versions, audit per version, org isolation of rule sets, no cross-facility profile write', async () => {
      const RS = "INSERT INTO rule_sets (organization_id, version, criteria_document_ref, rules, created_by) VALUES ($1, $2, 'zz', $3, 'platform:test')";
      const FP = "INSERT INTO facility_profiles (facility_id, version, capabilities, created_by) VALUES ($1, 0, $2, 'platform:test')";
      const rec = (id, kind = 'review', extra = {}) => ({ id, kind, enabled: true, inputs: ['x'], expression: 'x is yes', ...extra });
      const set = (...recs) => JSON.stringify(recs);
      // records: snake_case unique ids, a known kind, boolean enabled, string expression, string inputs
      await asOrg(c, ORG[0]);
      for (const bad of [set(rec('zz.a'), rec('zz.a')), set(rec('Bad')), '["zz.a"]', set(rec('zz.a', 'admit')), set(rec('zz.a', 'review', { enabled: 'yes' })),
        set(rec('zz.a', 'review', { expression: ' ' })), set(rec('zz.a', 'review', { inputs: 'x' })), set(rec('zz.a', 'review', { inputs: [1] }))]) {
        await expectFailure(c, RS, /rule_sets_records/, [ORG[0], 0, bad]);
      }
      // the writer's version is ignored: two inserts asking for 99 land as 1 and 2, each with its platform audit row
      const auditBefore = await count(c, "SELECT count(*) AS n FROM platform_audit_log WHERE entity_type = 'rule_set'");
      for (let i = 0; i < 2; i += 1) await c.query(RS, [ORG[0], 99, set(rec('zz.a'), rec('zz.hs', 'hard_stop'), rec('zz.pay', 'payer'))]);
      assert.deepEqual((await c.query('SELECT version FROM rule_sets WHERE organization_id = $1 ORDER BY version', [ORG[0]])).rows.map((r) => r.version), [1, 2]);
      const rows = (await c.query("SELECT organization_id, action, actor FROM platform_audit_log WHERE entity_type = 'rule_set' ORDER BY seq")).rows.slice(auditBefore);
      assert.deepEqual(rows, [0, 1].map(() => ({ organization_id: ORG[0], action: 'rule_set.versioned', actor: 'platform:test' })));
      await expectFailure(c, 'UPDATE rule_sets SET criteria_document_ref = $1', /append-only|immutable/, ['tampered']);
      await asOrg(c, ORG[1]);
      await c.query(RS, [ORG[1], 0, set(rec('zz.b'))]);
      // rule sets are organisation-scoped: org A's app role sees only its own, nothing when unbound, and cannot write
      await c.query('SET LOCAL ROLE codex_app');
      await asOrg(c, ORG[0]);
      assert.equal(await count(c, 'SELECT count(*) AS n FROM rule_sets'), 2);
      assert.equal(await count(c, 'SELECT count(*) AS n FROM rule_sets WHERE organization_id <> $1', [ORG[0]]), 0, 'rule_sets leaks across organisations');
      await expectFailure(c, RS, /permission denied/, [ORG[0], 0, set(rec('zz.c'))]);
      await asOrg(c, '');
      assert.equal(await count(c, 'SELECT count(*) AS n FROM rule_sets'), 0, 'rule_sets visible with no organisation bound');
      // profiles: bound to a1, the app role cannot write another facility's profile
      await asOrg(c, ORG[0]);
      await asFacility(c, FAC.a1);
      const FPU = "INSERT INTO facility_profiles (facility_id, version, capabilities, created_by) VALUES ($1, 0, '{}', $2)";
      await expectFailure(c, FPU, /row-level security|not an Admin/, [FAC.b1, `user:${USER.a}`]);
      await expectFailure(c, FPU, /row-level security|not an Admin/, [FAC.a2, `user:${USER.a}`]);
      // the app role cannot claim the platform, nor a user who is not an Admin here (USER.a is a Reviewer at a1)
      await expectFailure(c, FPU, /not an Admin/, [FAC.a1, 'platform:owner']);
      await expectFailure(c, FPU, /not an Admin/, [FAC.a1, `user:${USER.a}`]);
      await c.query('RESET ROLE');
      // switched-off ids: present in the organisation's latest rule set, and never a hard stop or payer rule
      const FPD = "INSERT INTO facility_profiles (facility_id, version, capabilities, disabled_rules, created_by) VALUES ($1, 0, '{}', $2, 'platform:test')";
      for (const ids of [['no.such.rule'], [''], ['ZZ BAD'], ['zz.hs'], ['zz.pay'], ['zz.b']]) {
        await expectFailure(c, FPD, /cannot be switched off/, [FAC.a1, ids]);
      }
      await c.query(FPD, [FAC.a1, ['zz.a']]);
      // capabilities: profile v0 keys of their declared types only
      for (const caps of ['{"zztest_key":true}', '{"accepts_ventilator":"false"}', '{"ventilator_beds":1.5}', '{"ventilator_beds":-1}', '{"ventilator_beds":"2"}']) {
        await expectFailure(c, FP, /facility_profiles_capabilities_v0/, [FAC.a1, caps]);
      }
      await c.query(FP, [FAC.a1, '{"accepts_ventilator":true,"ventilator_beds":2}']);
      assert.deepEqual((await c.query('SELECT version FROM facility_profiles WHERE facility_id = $1 ORDER BY version', [FAC.a1])).rows.map((r) => r.version), [1, 2, 3]);
    });

    await sub('transitions (0009): status moves only through a checked, audited transition row', async () => {
      const T = 'INSERT INTO referral_transitions (facility_id, referral_id, transition, from_status, to_status, note, department, requested_items, decision_id, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)';
      await asFacility(c, FAC.a1);
      await asOrg(c, ORG[0]);
      const ref = (await c.query('SELECT id FROM referrals WHERE facility_id = $1', [FAC.a1])).rows[0].id;
      const dec = (await c.query('SELECT id FROM decisions WHERE facility_id = $1', [FAC.a1])).rows[0].id;
      const me = `user:${USER.a}`;
      await c.query("SELECT set_config('app.user_id', $1, true)", [USER.a]); // the acting user (0010)
      await c.query('SET LOCAL ROLE codex_app');
      const status = async () => (await c.query('SELECT status FROM referrals WHERE id = $1', [ref])).rows[0].status;
      assert.equal(await status(), 'on_hold');
      // who: a Reviewer or Admin of this facility, never the platform or a foreign user
      await expectFailure(c, T, /may not move referrals/, [FAC.a1, ref, 'T11', 'on_hold', 'ready_for_review', 'n', null, '{}', null, 'platform:owner']);
      await expectFailure(c, T, /may not move referrals/, [FAC.a1, ref, 'T11', 'on_hold', 'ready_for_review', 'n', null, '{}', null, `user:${USER.b}`]);
      // from: the referral's real status, under the lock
      await expectFailure(c, T, /referral is on_hold, not ready_for_review/, [FAC.a1, ref, 'T8', 'ready_for_review', 'on_hold', 'n', null, '{}', null, me]);
      // shape: note, keys only for items, a known department, the right pair of states, extra fields refused
      for (const bad of [
        ['T11', 'on_hold', 'ready_for_review', null, null, '{}', null],
        ['T11', 'on_hold', 'finalized', 'n', null, '{}', null],
        ['T11', 'on_hold', 'ready_for_review', 'n', 'therapy', '{}', null],
        ['T11', 'on_hold', 'ready_for_review', ' ', null, '{}', null],
        ['T99', 'on_hold', 'ready_for_review', 'n', null, '{}', null],
      ]) await expectFailure(c, T, /referral_transitions_(shape|fields)|note_check/, [FAC.a1, ref, ...bad, me]);
      await c.query(T, [FAC.a1, ref, 'T11', 'on_hold', 'ready_for_review', 'SYNTHETIC resume', null, '{}', null, me]);
      assert.equal(await status(), 'ready_for_review');
      // (now in ready_for_review, so the status check passes and each row reaches the CHECKs)
      for (const bad of [
        ['T8', 'ready_for_review', 'on_hold', null, null, '{}', null],
        ['T8', 'ready_for_review', 'on_hold', 'n', null, '{ventilator_use}', null],
        ['T10', 'ready_for_review', 'escalated', 'n', null, '{}', null],
        ['T10', 'ready_for_review', 'escalated', null, 'therapy', '{}', null],
        ['T9', 'ready_for_review', 'info_requested', null, null, '{}', null],
        ['T12', 'ready_for_review', 'finalized', 'n', null, '{}', dec],
      ]) await expectFailure(c, T, /referral_transitions_(shape|fields)/, [FAC.a1, ref, ...bad, me]);
      await expectFailure(c, T, /transition_items_ok|requested_items_check/, [FAC.a1, ref, 'T9', 'ready_for_review', 'info_requested', null, null, '{"Call the hospital"}', null, me]);
      await expectFailure(c, T, /department_check/, [FAC.a1, ref, 'T10', 'ready_for_review', 'escalated', 'n', 'the_ceo', '{}', null, me]);
      // one statement, two rows from the same status: the second finds the referral already moved
      await expectFailure(c, `${T}, ($11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`, /no longer ready_for_review/,
        [FAC.a1, ref, 'T8', 'ready_for_review', 'on_hold', 'n', null, '{}', null, me, FAC.a1, ref, 'T10', 'ready_for_review', 'escalated', 'n', 'therapy', '{}', null, me]);
      await c.query('RESET ROLE');
      const EV = `INSERT INTO evaluations (facility_id, referral_id, raw, outcome, clinical_outcome, financial_status, trace, criteria_document_ref, rule_set_version,
        facility_profile_version, model_id, prompt_version, extractor_version, ocr_engine_version, engine_version)
        VALUES ($1, $2, false, 'admit', 'admit', 'clear', '{}', 'seed', 1, 1, 'none', 'p0', 'x0', 'o0', 'e0') RETURNING id`;
      // T12 on a decision whose evaluation is no longer the latest, or on an amendment, is refused
      await c.query('SAVEPOINT t12');
      await c.query(EV, [FAC.a1, ref]);
      await expectFailure(c, T, /latest evaluation/, [FAC.a1, ref, 'T12', 'ready_for_review', 'finalized', null, null, '{}', dec, me]);
      await c.query('ROLLBACK TO SAVEPOINT t12');
      await c.query('SAVEPOINT t12');
      await c.query("INSERT INTO user_facility_roles (user_id, facility_id, role) VALUES ($1, $2, 'facility_admin')", [USER.a, FAC.a1]);
      const evId = (await c.query('SELECT evaluation_id FROM decisions WHERE id = $1', [dec])).rows[0].evaluation_id;
      const amend = (await c.query("INSERT INTO decisions (facility_id, referral_id, evaluation_id, recommended_outcome, decision, override_reason, decided_by, amends_decision_id, amendment_reason) VALUES ($1, $2, $3, 'admit', 'do_not_admit', 'SYNTHETIC', $4, $5, 'SYNTHETIC') RETURNING id", [FAC.a1, ref, evId, USER.a, dec])).rows[0].id;
      await expectFailure(c, T, /must name the referral's latest decision/, [FAC.a1, ref, 'T12', 'ready_for_review', 'finalized', null, null, '{}', amend, me]);
      // as the app, an amendment or an amendment request needs a finalized referral (0011)
      await c.query('SET LOCAL ROLE codex_app');
      await expectFailure(c, "INSERT INTO decisions (facility_id, referral_id, evaluation_id, recommended_outcome, decision, override_reason, decided_by, amends_decision_id, amendment_reason) VALUES ($1, $2, $3, 'admit', 'do_not_admit', 'SYNTHETIC', $4, $5, 'SYNTHETIC')",
        /an amendment needs a finalized referral/, [FAC.a1, ref, evId, USER.a, amend]);
      await expectFailure(c, "INSERT INTO decision_requests (facility_id, referral_id, evaluation_id, decision, override_reason, requested_by, amends_decision_id, amendment_reason) VALUES ($1, $2, $3, 'do_not_admit', 'SYNTHETIC', $4, $5, 'SYNTHETIC')",
        /names the latest decision of a finalized referral/, [FAC.a1, ref, evId, USER.a, amend]);
      await c.query('ROLLBACK TO SAVEPOINT t12');
      await c.query('SET LOCAL ROLE codex_app');
      // T12 names the original decision, made by the same user who finalizes
      // (as the owner, so the actor check does not answer first: USER.b did not make this decision)
      await c.query('RESET ROLE');
      await expectFailure(c, T, /must name the referral's latest decision/, [FAC.a1, ref, 'T12', 'ready_for_review', 'finalized', null, null, '{}', dec, `user:${USER.b}`]);
      await c.query('SET LOCAL ROLE codex_app');
      await c.query(T, [FAC.a1, ref, 'T12', 'ready_for_review', 'finalized', null, null, '{}', dec, me]);
      assert.equal(await status(), 'finalized');
      // T14: a manual-entry referral needs an evaluation and no documents
      const fresh = (await c.query('INSERT INTO referrals (facility_id) VALUES ($1) RETURNING id', [FAC.a1])).rows[0].id;
      await expectFailure(c, T, /T14 needs no documents and at least one evaluation/, [FAC.a1, fresh, 'T14', 'draft', 'ready_for_review', null, null, '{}', null, me]);
      await c.query('RESET ROLE');
      const freshEv = (await c.query(EV, [FAC.a1, fresh])).rows[0].id;
      await c.query('SAVEPOINT doc');
      await c.query(`INSERT INTO documents (facility_id, referral_id, type, sha256, storage_key) VALUES ($1::uuid, $2::uuid, 'face_sheet', sha256('zz'::bytea),
        'documents/' || $1::uuid::text || '/' || $2::uuid::text || '/' || encode(sha256('zz'::bytea), 'hex'))`, [FAC.a1, fresh]);
      await c.query('SET LOCAL ROLE codex_app');
      await expectFailure(c, T, /T14 needs no documents/, [FAC.a1, fresh, 'T14', 'draft', 'ready_for_review', null, null, '{}', null, me]);
      await c.query('ROLLBACK TO SAVEPOINT doc');
      await c.query('SET LOCAL ROLE codex_app');
      // an original decision needs ready_for_review; once there, it must be finalized (T12) before commit
      const D = "INSERT INTO decisions (facility_id, referral_id, evaluation_id, recommended_outcome, decision, decided_by) VALUES ($1, $2, $3, 'admit', 'admit', $4)";
      await expectFailure(c, D, /needs the referral in ready_for_review/, [FAC.a1, fresh, freshEv, USER.a]);
      await expectFailure(c, T, /referral_transitions_fields/, [FAC.a1, fresh, 'T14', 'draft', 'ready_for_review', 'n', null, '{}', null, me]);
      await c.query(T, [FAC.a1, fresh, 'T14', 'draft', 'ready_for_review', null, null, '{}', null, me]);
      assert.equal((await c.query('SELECT status FROM referrals WHERE id = $1', [fresh])).rows[0].status, 'ready_for_review');
      await c.query('SAVEPOINT nofinal');
      await c.query(D, [FAC.a1, fresh, freshEv, USER.a]);
      await assert.rejects(c.query('SET CONSTRAINTS decisions_finalized_check IMMEDIATE'), /was never finalized/);
      await c.query('ROLLBACK TO SAVEPOINT nofinal');
      // every transition wrote its audit row; transition rows never change
      const actions = (await c.query("SELECT action FROM audit_log WHERE entity_id = $1 AND action LIKE 'referral.%' ORDER BY seq", [ref])).rows.map((x) => x.action);
      assert.deepEqual(actions, ['referral.held', 'referral.resumed', 'referral.finalized']);
      await expectFailure(c, "UPDATE referral_transitions SET note = 'x'", /immutable|permission denied/);
      await expectFailure(c, 'DELETE FROM referral_transitions', /immutable|permission denied/);
    });

    await sub('co-sign (0010): two people, two requests; every actor column is the acting user', async () => {
      const ADMIN = '00000000-0000-4000-8000-00000000ee03';
      const ADMIN2 = '00000000-0000-4000-8000-00000000ee04';
      const R2 = '00000000-0000-4000-8000-00000000ee05';
      const VIEWER = '00000000-0000-4000-8000-00000000ee06';
      await asFacility(c, FAC.a1);
      await asOrg(c, ORG[0]);
      for (const [id, role] of [[ADMIN, 'facility_admin'], [ADMIN2, 'facility_admin'], [R2, 'admissions_reviewer'], [VIEWER, 'viewer']]) {
        await c.query("INSERT INTO users (id, organization_id, email, display_name) VALUES ($1, $2, $3, 'ZZTEST Cosign')", [id, ORG[0], `zztest.${id.slice(-4)}@example.invalid`]);
        await c.query('INSERT INTO user_facility_roles (user_id, facility_id, role) VALUES ($1, $2, $3)', [id, FAC.a1, role]);
      }
      const EVQ = `INSERT INTO evaluations (facility_id, referral_id, raw, outcome, clinical_outcome, financial_status, trace, criteria_document_ref, rule_set_version,
        facility_profile_version, model_id, prompt_version, extractor_version, ocr_engine_version, engine_version)
        VALUES ($1, $2, false, 'do_not_admit', 'do_not_admit', 'clear', '{}', 'seed', 1, 1, 'none', 'p0', 'x0', 'o0', 'e0') RETURNING id`;
      const actAs = async (u) => { await c.query('RESET ROLE'); await c.query("SELECT set_config('app.user_id', $1, true)", [u]); await c.query('SET LOCAL ROLE codex_app'); };
      // a manual-entry referral whose recommendation is Do Not Admit, submitted for review by the Reviewer
      await actAs(USER.a);
      const ref = (await c.query('INSERT INTO referrals (facility_id) VALUES ($1) RETURNING id', [FAC.a1])).rows[0].id;
      await c.query('RESET ROLE');
      const ev = (await c.query(`INSERT INTO evaluations (facility_id, referral_id, raw, outcome, clinical_outcome, financial_status, trace, criteria_document_ref, rule_set_version,
        facility_profile_version, model_id, prompt_version, extractor_version, ocr_engine_version, engine_version)
        VALUES ($1, $2, false, 'do_not_admit', 'do_not_admit', 'clear', '{}', 'seed', 1, 1, 'none', 'p0', 'x0', 'o0', 'e0') RETURNING id`, [FAC.a1, ref])).rows[0].id;
      await actAs(USER.a);
      await c.query("INSERT INTO referral_transitions (facility_id, referral_id, transition, from_status, to_status, created_by) VALUES ($1, $2, 'T14', 'draft', 'ready_for_review', $3)", [FAC.a1, ref, `user:${USER.a}`]);
      const REQ = 'INSERT INTO decision_requests (facility_id, referral_id, evaluation_id, decision, override_reason, requested_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id';
      await expectFailure(c, REQ, /must be the acting user/, [FAC.a1, ref, ev, 'admit', 'SYNTHETIC', ADMIN]);
      await expectFailure(c, REQ, /override reason is required exactly/, [FAC.a1, ref, ev, 'admit', null, USER.a]);
      await expectFailure(c, REQ, /override reason is required exactly/, [FAC.a1, ref, ev, 'do_not_admit', 'SYNTHETIC', USER.a]);
      // the request guard's other checks: latest evaluation, ready_for_review, a Reviewer or Admin requester
      await c.query('SAVEPOINT reqg');
      await c.query('RESET ROLE');
      await c.query(EVQ, [FAC.a1, ref]);
      await actAs(USER.a);
      await expectFailure(c, REQ, /evaluation is not the latest/, [FAC.a1, ref, ev, 'admit', 'SYNTHETIC', USER.a]);
      await c.query('ROLLBACK TO SAVEPOINT reqg');
      await c.query('SAVEPOINT reqg');
      await actAs(USER.a);
      await c.query("INSERT INTO referral_transitions (facility_id, referral_id, transition, from_status, to_status, note, created_by) VALUES ($1, $2, 'T8', 'ready_for_review', 'on_hold', 'n', $3)", [FAC.a1, ref, `user:${USER.a}`]);
      await expectFailure(c, REQ, /not ready_for_review/, [FAC.a1, ref, ev, 'admit', 'SYNTHETIC', USER.a]);
      await c.query('ROLLBACK TO SAVEPOINT reqg');
      await actAs(VIEWER);
      await expectFailure(c, REQ, /may not decide this here/, [FAC.a1, ref, ev, 'admit', 'SYNTHETIC', VIEWER]);
      // the T12 actor must hold a Reviewer or Admin role, even when it is the acting user
      await actAs(USER.b);
      await expectFailure(c, "INSERT INTO referral_transitions (facility_id, referral_id, transition, from_status, to_status, note, created_by) VALUES ($1, $2, 'T8', 'ready_for_review', 'on_hold', 'n', $3)", /may not move referrals/, [FAC.a1, ref, `user:${USER.b}`]);
      await actAs(USER.a);
      const req = (await c.query(REQ, [FAC.a1, ref, ev, 'admit', 'SYNTHETIC: hospital confirms weaning', USER.a])).rows[0].id;
      const DEC = `INSERT INTO decisions (facility_id, referral_id, evaluation_id, recommended_outcome, decision, override_reason, decided_by, cosigned_by, decision_request_id)
        VALUES ($1, $2, $3, 'do_not_admit', $4, $5, $6, $7, $8) RETURNING id`;
      const args = (over = {}) => { const a = { decision: 'admit', reason: 'SYNTHETIC: hospital confirms weaning', by: USER.a, co: ADMIN, req, ...over }; return [FAC.a1, ref, ev, a.decision, a.reason, a.by, a.co, a.req]; };
      // the decider cannot write the co-signer's name, nor the co-signer the decider's own decision
      await expectFailure(c, DEC, /cosigned_by must be the acting user/, args());
      // a plain decision never names a request
      await expectFailure(c, DEC, /decided_by must be the acting user/, args({ co: null }));
      await actAs(ADMIN);
      await expectFailure(c, DEC, /decided_by must be the acting user/, args({ co: null, req: null }));
      await expectFailure(c, DEC, /carry out the latest request by the decider, unchanged/, args({ decision: 'do_not_admit', reason: null }));
      await expectFailure(c, DEC, /carry out the latest request by the decider, unchanged/, args({ reason: 'SYNTHETIC: different reason' }));
      await expectFailure(c, DEC, /carry out the latest request by the decider, unchanged/, args({ req: null }));
      // the co-signer cannot name themselves as the decider (the request guard answers before 0003's different-user CHECK)
      await expectFailure(c, DEC, /carry out the latest request by the decider, unchanged/, args({ by: ADMIN }));
      // someone who never filed the request cannot be named as its decider
      await expectFailure(c, DEC, /carry out the latest request by the decider, unchanged/, args({ by: R2 }));
      // the request is carried out on the evaluation it was filed on, not a newer one
      await c.query('SAVEPOINT evm');
      await c.query('RESET ROLE');
      const ev2 = (await c.query(EVQ, [FAC.a1, ref])).rows[0].id;
      await actAs(ADMIN);
      await expectFailure(c, DEC, /carry out the latest request/, [FAC.a1, ref, ev2, 'admit', 'SYNTHETIC: hospital confirms weaning', USER.a, ADMIN, req]);
      await c.query('ROLLBACK TO SAVEPOINT evm');
      await actAs(ADMIN);
      // a newer request replaces the old one: the old one can no longer be carried out
      await c.query('SAVEPOINT newer');
      await actAs(USER.a);
      await c.query(REQ, [FAC.a1, ref, ev, 'admit', 'SYNTHETIC: second thoughts', USER.a]);
      await actAs(ADMIN);
      await expectFailure(c, DEC, /carry out the latest request/, args());
      await c.query('ROLLBACK TO SAVEPOINT newer');
      await actAs(ADMIN);
      const dec = (await c.query(DEC, args())).rows[0].id;
      // only the decider or the co-signer finalizes it, not another Admin
      await actAs(ADMIN2);
      await expectFailure(c, "INSERT INTO referral_transitions (facility_id, referral_id, transition, from_status, to_status, decision_id, created_by) VALUES ($1, $2, 'T12', 'ready_for_review', 'finalized', $3, $4)", /must name the referral's latest decision/, [FAC.a1, ref, dec, `user:${ADMIN2}`]);
      await actAs(ADMIN);
      await c.query("INSERT INTO referral_transitions (facility_id, referral_id, transition, from_status, to_status, decision_id, created_by) VALUES ($1, $2, 'T12', 'ready_for_review', 'finalized', $3, $4)", [FAC.a1, ref, dec, `user:${ADMIN}`]);
      await c.query('SET CONSTRAINTS decisions_finalized_check IMMEDIATE');
      await c.query('SET CONSTRAINTS decisions_finalized_check DEFERRED'); // the mode lasts the transaction
      const row = (await c.query('SELECT decided_by, cosigned_by, cosigned_role, hard_stop_override FROM decisions WHERE id = $1', [dec])).rows[0];
      assert.deepEqual(row, { decided_by: USER.a, cosigned_by: ADMIN, cosigned_role: 'facility_admin', hard_stop_override: true });
      await c.query('RESET ROLE');
      const acts = (await c.query("SELECT actor, action FROM audit_log WHERE entity_id IN ($1, $2, $3) AND action <> 'referral.viewed' ORDER BY seq", [req, dec, ref])).rows;
      assert.deepEqual(acts, [
        { actor: `user:${USER.a}`, action: 'referral.submitted_for_review' },
        { actor: `user:${USER.a}`, action: 'decision.cosign_requested' },
        { actor: `user:${USER.a}`, action: 'decision.finalized' },
        { actor: `user:${ADMIN}`, action: 'decision.cosigned' },
        { actor: `user:${ADMIN}`, action: 'referral.finalized' },
      ]);
      await actAs(ADMIN);
      await expectFailure(c, 'UPDATE decision_requests SET override_reason = $1', /immutable|permission denied/, ['x']);

      // --- amendments (0011, T13) on the finalized referral above ----------------------------------------------
      const AMEND = `INSERT INTO decisions (facility_id, referral_id, evaluation_id, recommended_outcome, decision, override_reason, decided_by, cosigned_by, decision_request_id, amends_decision_id, amendment_reason)
        VALUES ($1, $2, $3, 'do_not_admit', $4, $5, $6, $7, $8, $9, $10) RETURNING id`;
      const T13 = "INSERT INTO referral_transitions (facility_id, referral_id, transition, from_status, to_status, decision_id, created_by) VALUES ($1, $2, 'T13', $3, 'amended', $4, $5)";
      // a Reviewer never amends (0003); the original is never updated
      await actAs(USER.a);
      await expectFailure(c, AMEND, /only an Admin may amend/, [FAC.a1, ref, ev, 'do_not_admit', null, USER.a, null, null, dec, 'SYNTHETIC: amend']);
      await expectFailure(c, 'UPDATE decisions SET decision = $1', /immutable|permission denied/, ['do_not_admit']);
      // an Admin's amendment back to the recommendation needs no co-sign, and carries its T13 by commit
      await actAs(ADMIN2);
      await c.query('SAVEPOINT not13');
      await c.query(AMEND, [FAC.a1, ref, ev, 'do_not_admit', null, ADMIN2, null, null, dec, 'SYNTHETIC: amend']);
      await assert.rejects(c.query('SET CONSTRAINTS decisions_finalized_check IMMEDIATE'), /never finalized or amended/);
      await c.query('ROLLBACK TO SAVEPOINT not13');
      await actAs(ADMIN2);
      // an Admit over the hard stop, amended without a co-sign, is refused by 0003's CHECK
      await expectFailure(c, AMEND, /decisions_hard_stop_cosign/, [FAC.a1, ref, ev, 'admit', 'SYNTHETIC', ADMIN2, null, null, dec, 'SYNTHETIC: amend']);
      // T13 never names an original decision, even the latest one, by its own co-signer
      await actAs(ADMIN);
      await expectFailure(c, T13, /must name the referral's latest decision/, [FAC.a1, ref, 'finalized', dec, `user:${ADMIN}`]);
      await actAs(ADMIN2);
      const am1 = (await c.query(AMEND, [FAC.a1, ref, ev, 'do_not_admit', null, ADMIN2, null, null, dec, 'SYNTHETIC: reversed on review'])).rows[0].id;
      // T13 names the latest decision (the amendment), not the original
      await expectFailure(c, T13, /must name the referral's latest decision/, [FAC.a1, ref, 'finalized', dec, `user:${ADMIN2}`]);
      await c.query(T13, [FAC.a1, ref, 'finalized', am1, `user:${ADMIN2}`]);
      // one T12/T13 per decision: replaying T13 on the same amendment is refused
      await expectFailure(c, T13, /referral_transitions_one_per_decision/, [FAC.a1, ref, 'amended', am1, `user:${ADMIN2}`]);
      await c.query('SET CONSTRAINTS decisions_finalized_check IMMEDIATE');
      await c.query('SET CONSTRAINTS decisions_finalized_check DEFERRED'); // the mode lasts the transaction
      // a second amendment to Admit over the hard stop goes through a request and a different Admin
      const AREQ = 'INSERT INTO decision_requests (facility_id, referral_id, evaluation_id, decision, override_reason, requested_by, amends_decision_id, amendment_reason) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id';
      await actAs(USER.a);
      await expectFailure(c, AREQ, /may not decide this here/, [FAC.a1, ref, ev, 'admit', 'SYNTHETIC', USER.a, am1, 'SYNTHETIC: re-amend']);
      await actAs(ADMIN2);
      await expectFailure(c, AREQ, /names the latest decision of a finalized referral/, [FAC.a1, ref, ev, 'admit', 'SYNTHETIC', ADMIN2, dec, 'SYNTHETIC: re-amend']);
      const areq = (await c.query(AREQ, [FAC.a1, ref, ev, 'admit', 'SYNTHETIC', ADMIN2, am1, 'SYNTHETIC: re-amend'])).rows[0].id;
      // overtaken: another Admin amends directly; the request cannot be carried out on top of the newer amendment
      await c.query('SAVEPOINT overtaken');
      await actAs(ADMIN);
      const am1b = (await c.query(AMEND, [FAC.a1, ref, ev, 'do_not_admit', null, ADMIN, null, null, am1, 'SYNTHETIC: direct'])).rows[0].id;
      await c.query(T13, [FAC.a1, ref, 'amended', am1b, `user:${ADMIN}`]);
      await expectFailure(c, AMEND, /carry out the latest request/, [FAC.a1, ref, ev, 'admit', 'SYNTHETIC', ADMIN2, ADMIN, areq, am1b, 'SYNTHETIC: re-amend']);
      await c.query('ROLLBACK TO SAVEPOINT overtaken');
      await actAs(ADMIN);
      await expectFailure(c, AMEND, /carry out the latest request/, [FAC.a1, ref, ev, 'admit', 'SYNTHETIC', ADMIN2, ADMIN, areq, am1, 'SYNTHETIC: different reason']);
      const am2 = (await c.query(AMEND, [FAC.a1, ref, ev, 'admit', 'SYNTHETIC', ADMIN2, ADMIN, areq, am1, 'SYNTHETIC: re-amend'])).rows[0].id;
      await c.query(T13, [FAC.a1, ref, 'amended', am2, `user:${ADMIN}`]);
      await c.query('SET CONSTRAINTS decisions_finalized_check IMMEDIATE');
      await c.query('SET CONSTRAINTS decisions_finalized_check DEFERRED'); // the mode lasts the transaction
      await c.query('RESET ROLE');
      assert.equal((await c.query('SELECT status FROM referrals WHERE id = $1', [ref])).rows[0].status, 'amended');
      const amendActs = (await c.query("SELECT actor, action FROM audit_log WHERE entity_id IN ($1, $2, $3, $4) AND action IN ('decision.amended', 'decision.cosigned', 'decision.cosign_requested', 'referral.amended') ORDER BY seq", [am1, am2, areq, ref])).rows;
      assert.deepEqual(amendActs, [
        { actor: `user:${ADMIN2}`, action: 'decision.amended' },
        { actor: `user:${ADMIN2}`, action: 'referral.amended' },
        { actor: `user:${ADMIN2}`, action: 'decision.cosign_requested' },
        { actor: `user:${ADMIN2}`, action: 'decision.amended' },
        { actor: `user:${ADMIN}`, action: 'decision.cosigned' },
        { actor: `user:${ADMIN}`, action: 'referral.amended' },
      ]);
    });

    await sub('document intake (0012): app inserts are uploads on an open referral, at most 20; T1, T4, T5, T6 need the right documents', async () => {
      await asFacility(c, FAC.a1);
      await asOrg(c, ORG[0]);
      await c.query("SELECT set_config('app.user_id', $1, true)", [USER.a]);
      await c.query('SET LOCAL ROLE codex_app');
      const DOC = `INSERT INTO documents (facility_id, referral_id, type, status, sha256, storage_key)
        VALUES ($1::uuid, $2::uuid, 'face_sheet', $4::document_status, sha256(convert_to($3::text, 'UTF8')),
                'documents/' || $1::uuid::text || '/' || $2::uuid::text || '/' || encode(sha256(convert_to($3::text, 'UTF8')), 'hex')) RETURNING id`;
      const T = 'INSERT INTO referral_transitions (facility_id, referral_id, transition, from_status, to_status, created_by) VALUES ($1, $2, $3, $4, $5, $6)';
      const me = `user:${USER.a}`;
      const ref = (await c.query('INSERT INTO referrals (facility_id) VALUES ($1) RETURNING id', [FAC.a1])).rows[0].id;
      assert.equal((await c.query('SELECT referral_type FROM referrals WHERE id = $1', [ref])).rows[0].referral_type, 'skilled');
      // T1 needs a document waiting to be processed
      await expectFailure(c, T, /needs a document waiting/, [FAC.a1, ref, 'T1', 'draft', 'processing', me]);
      await expectFailure(c, DOC, /inserts a document as uploaded/, [FAC.a1, ref, 'zz-processed', 'processed']);
      const doc = (await c.query(DOC, [FAC.a1, ref, 'zz-1', 'uploaded'])).rows[0].id;
      await c.query(T, [FAC.a1, ref, 'T1', 'draft', 'processing', me]);
      // the pipeline owns a processing referral: no uploads
      await expectFailure(c, DOC, /cannot be added to a processing referral/, [FAC.a1, ref, 'zz-2', 'uploaded']);
      // the worker reports a failure (done as the owner here)
      await c.query('RESET ROLE');
      await c.query("UPDATE documents SET status = 'failed' WHERE id = $1", [doc]);
      await c.query("UPDATE referrals SET status = 'partial_failure' WHERE id = $1", [ref]);
      await c.query('SET LOCAL ROLE codex_app');
      // T5 needs every failed document marked not applicable; T4 needs a new document waiting
      await expectFailure(c, T, /T5 needs every failed document marked not applicable/, [FAC.a1, ref, 'T5', 'partial_failure', 'ready_for_review', me]);
      await expectFailure(c, T, /needs a document waiting/, [FAC.a1, ref, 'T4', 'partial_failure', 'processing', me]);
      await c.query('SAVEPOINT t5');
      await c.query("UPDATE documents SET status = 'not_applicable', not_applicable_reason = 'SYNTHETIC' WHERE id = $1", [doc]);
      // T5 is blocked by any document still waiting or unreadable, not only a failed one
      for (const blocker of ['uploaded', 'unreadable']) {
        await c.query('SAVEPOINT blk');
        await c.query('RESET ROLE');
        await c.query(DOC, [FAC.a1, ref, `zz-blk-${blocker}`, blocker]);
        await c.query('SET LOCAL ROLE codex_app');
        await expectFailure(c, T, /T5 needs every failed document marked not applicable/, [FAC.a1, ref, 'T5', 'partial_failure', 'ready_for_review', me]);
        await c.query('ROLLBACK TO SAVEPOINT blk');
        await c.query('SET LOCAL ROLE codex_app');
      }
      await c.query(T, [FAC.a1, ref, 'T5', 'partial_failure', 'ready_for_review', me]);
      // T6 needs a document waiting too
      await expectFailure(c, T, /needs a document waiting/, [FAC.a1, ref, 'T6', 'ready_for_review', 'processing', me]);
      // T6: a document added in review sends the referral back to processing
      await c.query(DOC, [FAC.a1, ref, 'zz-3', 'uploaded']);
      await c.query(T, [FAC.a1, ref, 'T6', 'ready_for_review', 'processing', me]);
      await c.query('ROLLBACK TO SAVEPOINT t5');
      await c.query('SET LOCAL ROLE codex_app');
      await c.query(DOC, [FAC.a1, ref, 'zz-4', 'uploaded']);
      await c.query(T, [FAC.a1, ref, 'T4', 'partial_failure', 'processing', me]);
      // at most 20 documents per referral
      const ref2 = (await c.query('INSERT INTO referrals (facility_id) VALUES ($1) RETURNING id', [FAC.a1])).rows[0].id;
      for (let i = 0; i < 20; i += 1) await c.query(DOC, [FAC.a1, ref2, `zz-cap-${i}`, 'uploaded']);
      await expectFailure(c, DOC, /at most 20 documents per referral/, [FAC.a1, ref2, 'zz-cap-20', 'uploaded']);
      // nothing the pipeline reports, nothing on a closed referral, nothing by someone without a role here
      await c.query('SET LOCAL ROLE codex_app');
      const PAGES = DOC.replace('(facility_id, referral_id, type, status, sha256, storage_key)', '(facility_id, referral_id, type, status, pages, sha256, storage_key)').replace("$4::document_status, sha256", "$4::document_status, 1, sha256");
      const ref3 = (await c.query('INSERT INTO referrals (facility_id) VALUES ($1) RETURNING id', [FAC.a1])).rows[0].id;
      await expectFailure(c, PAGES, /nothing the pipeline reports/, [FAC.a1, ref3, 'zz-pages', 'uploaded']);
      await c.query('RESET ROLE');
      await c.query("UPDATE referrals SET status = 'finalized' WHERE id = $1", [ref3]);
      await c.query('SET LOCAL ROLE codex_app');
      await expectFailure(c, DOC, /cannot be added to a finalized referral/, [FAC.a1, ref3, 'zz-final', 'uploaded']);
      await c.query('RESET ROLE');
      await c.query("SELECT set_config('app.user_id', $1, true)", [USER.b]);
      await c.query('SET LOCAL ROLE codex_app');
      await expectFailure(c, DOC, /may not add documents here/, [FAC.a1, ref2, 'zz-norole', 'uploaded']);
      // referral_type is one of the five
      await c.query('RESET ROLE');
      await expectFailure(c, "UPDATE referrals SET referral_type = 'zz' WHERE id = $1", /referral_type_check/, [ref2]);
    });

    await sub('CONSTRAINTS check queries return zero rows', async () => {
      assert.deepEqual(await runChecks(c), {});
    });
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
});

// Cross-facility isolation, organisation isolation, audit immutability, the hash chain and provisioning
// coupling, against a migrated local database (SPEC §12 XF-1, XF-2, XF-9, XF-10; I3, I4). Skips cleanly
// without DATABASE_URL on a developer machine and FAILS without it in CI (a skipped gate is not green).
// Every subtest runs in its own savepoint over one outer transaction that is rolled back at the end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { runChecks } from '../check.mjs';

const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error('DATABASE_URL must be set in CI: the database suite may not be skipped there');

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
    await c.query("INSERT INTO user_facility_roles (user_id, facility_id, role) VALUES ($1, $2, 'admissions_reviewer')", [key.startsWith('a') ? USER.a : USER.b, id]);
    await audit(c, id);
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
        assert.ok(checked >= 2, `${role} could read ${checked} tenant tables; expected at least referrals and audit_log`);
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
      await audit(c, FAC.a1, 'referral.created');
      await c.query("INSERT INTO audit_log (facility_id, seq, row_hash, actor, action, entity_type, at) VALUES ($1, 0, '\\x00', 'system:test', 'backdated', 'facility', '2001-01-01')", [FAC.a1]);
      const { rows } = await c.query('SELECT seq, prev_hash, row_hash, at FROM audit_log WHERE facility_id = $1 ORDER BY seq', [FAC.a1]);
      assert.deepEqual(rows.map((r) => Number(r.seq)), [1, 2, 3], 'writer-supplied seq 0 was overwritten');
      assert.equal(rows[0].prev_hash, null);
      assert.ok(rows[0].row_hash.length === 32 && !rows[0].row_hash.equals(Buffer.from([0])), 'writer-supplied hash was overwritten');
      assert.ok(rows[1].prev_hash.equals(rows[0].row_hash) && rows[2].prev_hash.equals(rows[1].row_hash));
      assert.ok(rows[2].at.getFullYear() > 2001, 'writer-supplied at was overwritten');
      assert.deepEqual(await verify(c, FAC.a1), [true, true, true]);
      await asFacility(c, FAC.b1);
      assert.deepEqual(await verify(c, FAC.b1), [true]);
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
      await c.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_immutable');
      await c.query("UPDATE audit_log SET action = 'tampered' WHERE facility_id = $1 AND seq = 2", [FAC.a1]);
      assert.deepEqual(await verify(c, FAC.a1), [true, false, true], 'only the rewritten row fails; its successor still chains to the stored hash');
      await c.query('DELETE FROM audit_log WHERE facility_id = $1 AND seq = 2', [FAC.a1]);
      assert.deepEqual(await verify(c, FAC.a1), [true, false], 'the row after a gap fails');
      const failures = await runChecks(c);
      assert.match(JSON.stringify(failures['grants.sql'] ?? []), /no enabled statement-level trigger.*audit_log/);
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
      assert.equal((await c.query("UPDATE referrals SET status = 'amended' WHERE facility_id = $1", [FAC.a1])).rowCount, 1, 'the guard binds only the worker');
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
        await audit(c, FAC.b1, 'unblocked');
        assert.deepEqual(await verify(c, FAC.b1), [true, true]);
      } finally {
        await other.query('ROLLBACK');
        await other.end();
      }
    });

    await sub('CONSTRAINTS check queries return zero rows', async () => {
      assert.deepEqual(await runChecks(c), {});
    });
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
});

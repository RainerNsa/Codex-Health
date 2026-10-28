// Cross-facility isolation and audit immutability against a migrated local database.
// Skips cleanly without DATABASE_URL. Everything runs inside one transaction that is rolled back,
// so the test leaves no rows behind (audit_log rows could not be deleted anyway).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { runChecks } from '../check.mjs';

const url = process.env.DATABASE_URL;

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

const asFacility = (c, id) => c.query("SELECT set_config('app.facility_id', $1, true)", [id]);
const count = async (c, sql, params) => Number((await c.query(sql, params)).rows[0].n);

async function seed(c) {
  await c.query('INSERT INTO organizations (id, name) VALUES ($1, $2), ($3, $4)', [
    ORG[0], 'ZZTEST Org A', ORG[1], 'ZZTEST Org B',
  ]);
  const owner = { a1: ORG[0], a2: ORG[0], b1: ORG[1], b2: ORG[1] };
  for (const [key, id] of Object.entries(FAC)) {
    await asFacility(c, id); // FORCE RLS binds the owner too, so the seed inserts one facility at a time
    await c.query('INSERT INTO facilities (facility_id, organization_id, name) VALUES ($1, $2, $3)', [
      id, owner[key], `ZZTEST Facility ${key}`,
    ]);
    await c.query('INSERT INTO referrals (facility_id) VALUES ($1)', [id]);
    await c.query(
      "INSERT INTO audit_log (facility_id, seq, prev_hash, row_hash, actor, action, entity_type) VALUES ($1, 1, NULL, '\\x00', 'test', 'seed', 'facility')",
      [id],
    );
  }
}

async function expectFailure(c, sql, pattern) {
  await c.query('SAVEPOINT expect_fail');
  await assert.rejects(c.query(sql), pattern);
  await c.query('ROLLBACK TO SAVEPOINT expect_fail');
}

test('row-level security and audit immutability', { skip: !url && 'DATABASE_URL not set' }, async (t) => {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query('BEGIN');
  try {
    await seed(c);

    for (const role of ['codex_app', 'codex_worker']) {
      await t.test(`${role} sees only its own facility`, async () => {
        await c.query('SAVEPOINT role_test');
        await c.query(`SET LOCAL ROLE ${role}`);
        await asFacility(c, FAC.a1);
        assert.equal(await count(c, 'SELECT count(*) AS n FROM referrals'), 1);
        assert.equal(await count(c, 'SELECT count(*) AS n FROM referrals WHERE facility_id = $1', [FAC.b1]), 0);
        assert.equal(await count(c, 'SELECT count(*) AS n FROM facilities WHERE facility_id <> $1', [FAC.a1]), 0);
        assert.equal(await count(c, 'SELECT count(*) AS n FROM audit_log WHERE facility_id <> $1', [FAC.a1]), 0);
        await asFacility(c, ''); // unset tenant: nothing is visible
        assert.equal(await count(c, 'SELECT count(*) AS n FROM referrals'), 0);
        await c.query('ROLLBACK TO SAVEPOINT role_test');
      });
    }

    await t.test('audit_log rejects UPDATE and DELETE for the app role and for the owner', async () => {
      await c.query('SAVEPOINT app');
      await c.query('SET LOCAL ROLE codex_app');
      await asFacility(c, FAC.a1);
      await expectFailure(c, "UPDATE audit_log SET action = 'tampered'", /permission denied|append-only/);
      await expectFailure(c, 'DELETE FROM audit_log', /permission denied|append-only/);
      await c.query('ROLLBACK TO SAVEPOINT app');
      await asFacility(c, FAC.a1);
      await expectFailure(c, "UPDATE audit_log SET action = 'tampered'", /append-only/);
      await expectFailure(c, 'DELETE FROM audit_log', /append-only/);
    });

    await t.test('CONSTRAINTS check queries return zero rows', async () => {
      assert.deepEqual(await runChecks(c), {});
    });
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
});

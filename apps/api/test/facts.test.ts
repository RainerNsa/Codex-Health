// Manual fact entry end to end against a migrated database (SPEC §5 T7, §12 XF-11, I1-I4). Every request runs in a
// savepoint of one outer transaction as codex_app, exactly the role and bindings production uses, and the outer
// transaction is rolled back: the suite leaves nothing behind. Skips without DATABASE_URL; fails where
// REQUIRE_DATABASE is set (the CI db-checks job).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { buildServer } from '../src/server.ts';
import { DEV_USER_HEADER } from '../src/auth.ts';
import type { Tx } from '../src/db.ts';

const url = process.env['DATABASE_URL'];
if (!url && process.env['REQUIRE_DATABASE']) throw new Error('DATABASE_URL must be set here: the API suite may not be skipped in the db-checks job');

const ORG = { a: '00000000-0000-4000-8000-00000000c101', b: '00000000-0000-4000-8000-00000000c102' };
const FAC = { a: '00000000-0000-4000-8000-00000000fc11', b: '00000000-0000-4000-8000-00000000fc21' };
const U = { reviewer: '00000000-0000-4000-8000-00000000cc11', viewer: '00000000-0000-4000-8000-00000000cc12', admin: '00000000-0000-4000-8000-00000000cc13', other: '00000000-0000-4000-8000-00000000cc21' };
const NOTE = 'SYNTHETIC: verbal update from the hospital liaison';

describe.skipIf(!url)('manual fact entry API', () => {
  const c = new pg.Client({ connectionString: url });
  let n = 0;
  // One request = one savepoint as codex_app; RESET and cleared bindings afterwards so the next one starts clean.
  const tx: Tx = async (fn) => {
    const sp = `req_${(n += 1)}`;
    await c.query(`SAVEPOINT ${sp}`);
    await c.query('SET LOCAL ROLE codex_app');
    try {
      const r = await fn((sql, params) => c.query(sql, params));
      await c.query(`RELEASE SAVEPOINT ${sp}`);
      return r;
    } catch (err) {
      await c.query(`ROLLBACK TO SAVEPOINT ${sp}`);
      throw err;
    } finally {
      await c.query('RESET ROLE');
      await c.query("SELECT set_config('app.facility_id', '', true), set_config('app.organization_id', '', true)");
    }
  };
  const app = buildServer({ tx, auth: 'local-stub', env: 'test' });
  const as = (user: string | null) => (user ? { [DEV_USER_HEADER]: user } : {});
  const post = (path: string, user: string | null, payload?: unknown) => app.inject({ method: 'POST', url: path, headers: as(user), payload: payload as object });
  const get = (path: string, user: string | null) => app.inject({ method: 'GET', url: path, headers: as(user) });
  const fact = (key: string, v: 'yes' | 'no' | 'unknown', extra: Record<string, unknown> = {}) => ({ key, value: { type: 'tri_state', value: v }, note: NOTE, ...extra });
  const count = async (sql: string, params: unknown[] = []) => Number((await c.query(sql, params)).rows[0].n);

  beforeAll(async () => {
    await c.connect();
    await c.query('BEGIN');
    for (const [k, org] of Object.entries(ORG)) {
      await c.query("SELECT set_config('app.organization_id', $1, true)", [org]);
      await c.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [org, `ZZTEST API Org ${k}`]);
      const fac = FAC[k as keyof typeof FAC];
      await c.query("SELECT set_config('app.facility_id', $1, true)", [fac]);
      await c.query('INSERT INTO facilities (facility_id, organization_id, name) VALUES ($1, $2, $3)', [fac, org, `ZZTEST API Facility ${k}`]);
    }
    const members: [string, keyof typeof ORG, string][] = [[U.reviewer, 'a', 'admissions_reviewer'], [U.viewer, 'a', 'viewer'], [U.admin, 'a', 'facility_admin'], [U.other, 'b', 'admissions_reviewer']];
    for (const [id, k, role] of members) {
      await c.query("SELECT set_config('app.organization_id', $1, true), set_config('app.facility_id', $2, true)", [ORG[k], FAC[k]]);
      await c.query('INSERT INTO users (id, organization_id, email, display_name) VALUES ($1, $2, $3, $4)', [id, ORG[k], `zztest.api.${id.slice(-4)}@example.invalid`, 'ZZTEST API user']);
      await c.query('INSERT INTO user_facility_roles (user_id, facility_id, role) VALUES ($1, $2, $3)', [id, FAC[k], role]);
    }
    await c.query("SELECT set_config('app.facility_id', '', true), set_config('app.organization_id', '', true)");
  });
  afterAll(async () => {
    await c.query('ROLLBACK');
    await c.end();
    await app.close();
  });

  it('refuses to start the stub outside development or test', () => {
    expect(() => buildServer({ tx, auth: 'local-stub', env: 'production' })).toThrow(/refused/);
    expect(() => buildServer({ tx, auth: 'local-stub', env: undefined })).toThrow(/refused/);
  });

  it('401 without an identity; 404, not 403, for another facility, an unknown facility or a bad id', async () => {
    expect((await post(`/api/facilities/${FAC.a}/referrals`, null)).statusCode).toBe(401);
    expect((await post(`/api/facilities/${FAC.a}/referrals`, 'not-a-uuid')).statusCode).toBe(401);
    expect((await post(`/api/facilities/${FAC.a}/referrals`, U.other)).statusCode).toBe(404);
    expect((await post('/api/facilities/00000000-0000-4000-8000-0000000000ff/referrals', U.reviewer)).statusCode).toBe(404);
    expect((await post('/api/facilities/zz/referrals', U.reviewer)).statusCode).toBe(404);
  });

  let rid = '';
  it('a Reviewer creates a referral: audited, an event emitted, the form lists the rule set fact keys', async () => {
    const res = await post(`/api/facilities/${FAC.a}/referrals`, U.reviewer);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    rid = body.referral.id;
    expect(body.referral.status).toBe('draft');
    expect(body.facts).toEqual([]);
    expect(body.evaluation).toBeNull();
    expect(body.form.fact_keys.map((k: { key: string }) => k.key)).toEqual(['daily_skilled_need', 'recent_aggression', 'ventilator_use']);
    expect(body.form.fact_keys.find((k: { key: string }) => k.key === 'ventilator_use').critical).toBe(true);
    await c.query("SELECT set_config('app.facility_id', $1, true)", [FAC.a]);
    expect(await count("SELECT count(*) AS n FROM audit_log WHERE entity_id = $1 AND action = 'referral.created'", [rid])).toBe(1);
    expect(await count("SELECT count(*) AS n FROM product_events WHERE referral_id = $1 AND event = 'referral.received'", [rid])).toBe(1);
  });

  it('a Viewer may read but not write; another facility user cannot read', async () => {
    expect((await get(`/api/facilities/${FAC.a}/referrals/${rid}`, U.viewer)).statusCode).toBe(200);
    expect((await post(`/api/facilities/${FAC.a}/referrals/${rid}/facts`, U.viewer, fact('ventilator_use', 'yes'))).statusCode).toBe(403);
    expect((await post(`/api/facilities/${FAC.a}/referrals`, U.viewer)).statusCode).toBe(403);
    expect((await get(`/api/facilities/${FAC.a}/referrals/${rid}`, U.other)).statusCode).toBe(404);
    expect((await get(`/api/facilities/${FAC.b}/referrals/${rid}`, U.other)).statusCode).toBe(404); // right facility for the user, wrong referral
  });

  it('entering facts re-evaluates every time; a hard stop gives Do Not Admit, the correction supersedes it and keeps both', async () => {
    let res = await post(`/api/facilities/${FAC.a}/referrals/${rid}/facts`, U.reviewer, fact('ventilator_use', 'yes'));
    expect(res.statusCode).toBe(201);
    expect(res.json().evaluation.outcome).toBe('do_not_admit');
    res = await post(`/api/facilities/${FAC.a}/referrals/${rid}/facts`, U.reviewer, fact('ventilator_use', 'no'));
    expect([res.json().evaluation.outcome, res.json().evaluation.sub_reasons]).toEqual(['needs_review', ['missing_info']]);
    res = await post(`/api/facilities/${FAC.a}/referrals/${rid}/facts`, U.reviewer, fact('recent_aggression', 'no'));
    res = await post(`/api/facilities/${FAC.a}/referrals/${rid}/facts`, U.admin, fact('daily_skilled_need', 'yes', { as_of_date: '2001-01-02' }));
    const body = res.json();
    expect(body.evaluation.outcome).toBe('admit');
    expect(body.evaluation.trace.resolution_step).toBe('favorable_rule_true');
    expect(body.facts.map((f: { key: string; value: { value: string } }) => [f.key, f.value.value])).toEqual([['daily_skilled_need', 'yes'], ['recent_aggression', 'no'], ['ventilator_use', 'no']]);
    await c.query("SELECT set_config('app.facility_id', $1, true)", [FAC.a]);
    expect(await count("SELECT count(*) AS n FROM facts WHERE referral_id = $1 AND key = 'ventilator_use'", [rid])).toBe(2);
    expect(await count('SELECT count(*) AS n FROM evaluations WHERE referral_id = $1 AND NOT raw', [rid])).toBe(4);
    expect(await count("SELECT count(*) AS n FROM audit_log WHERE action IN ('fact.entered', 'fact.corrected') AND entity_type = 'fact'")).toBe(4);
    expect(await count("SELECT count(*) AS n FROM product_events WHERE referral_id = $1 AND event = 'fact.corrected'", [rid])).toBe(1);
    expect(await count('SELECT count(*) AS n FROM evaluations e WHERE referral_id = $1 AND previous_evaluation_id IS NULL', [rid])).toBe(1);
  });

  it('rejects bad input without echoing it: no note, a blank note, an unknown key, a wrong value, a bad date', async () => {
    const bad = [
      { ...fact('ventilator_use', 'no'), note: undefined },
      { ...fact('ventilator_use', 'no'), note: '   ' },
      { ...fact('ventilator_use', 'no'), note: 'x'.repeat(501) },
      fact('zztest_unknown_key', 'no'),
      { key: 'ventilator_use', value: { type: 'tri_state', value: 'Yes' }, note: NOTE },
      { key: 'ventilator_use', value: 'yes', note: NOTE },
      fact('ventilator_use', 'no', { as_of_date: '2001-02-30' }),
    ];
    for (const payload of bad) {
      const res = await post(`/api/facilities/${FAC.a}/referrals/${rid}/facts`, U.reviewer, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.body).not.toContain('SYNTHETIC');
      expect(res.json()).toEqual({ error: 'invalid_fact' });
    }
  });

  it('a finalized referral is not open for fact entry', async () => {
    await c.query("SELECT set_config('app.facility_id', $1, true)", [FAC.a]);
    await c.query("UPDATE referrals SET status = 'finalized' WHERE id = $1", [rid]);
    const res = await post(`/api/facilities/${FAC.a}/referrals/${rid}/facts`, U.reviewer, fact('ventilator_use', 'yes'));
    expect([res.statusCode, res.json()]).toEqual([409, { error: 'referral_not_open' }]);
    await c.query("UPDATE referrals SET status = 'ready_for_review' WHERE id = $1", [rid]);
  });

  it('every read is audited (I4) and every response is no-store', async () => {
    await c.query("SELECT set_config('app.facility_id', $1, true)", [FAC.a]);
    const before = await count("SELECT count(*) AS n FROM audit_log WHERE action = 'referral.viewed' AND entity_id = $1", [rid]);
    const res = await get(`/api/facilities/${FAC.a}/referrals/${rid}`, U.viewer);
    expect(res.headers['cache-control']).toBe('no-store');
    await c.query("SELECT set_config('app.facility_id', $1, true)", [FAC.a]);
    expect(await count("SELECT count(*) AS n FROM audit_log WHERE action = 'referral.viewed' AND entity_id = $1", [rid])).toBe(before + 1);
  });
});

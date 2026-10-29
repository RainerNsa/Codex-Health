// Manual fact entry end to end against a migrated database (SPEC §5 T7, §6, §12 XF-11, I1-I6). Every request runs
// in a savepoint of one outer transaction as codex_app, exactly the role and bindings production uses, and the
// outer transaction is rolled back: the suite leaves nothing behind. Skips without DATABASE_URL; fails where
// REQUIRE_DATABASE is set (the CI db-checks job).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { buildServer } from '../src/server.ts';
import { DEV_USER_HEADER } from '../src/auth.ts';
import { poolTx, type Tx } from '../src/db.ts';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const url = process.env['DATABASE_URL'];
const appUrl = process.env['DATABASE_URL_APP'];
if ((!url || !appUrl) && process.env['REQUIRE_DATABASE']) throw new Error('DATABASE_URL and DATABASE_URL_APP must be set here: the API suite may not be skipped in the db-checks job');

const ORG = { a: '00000000-0000-4000-8000-00000000c101', b: '00000000-0000-4000-8000-00000000c102' };
const FAC = { a: '00000000-0000-4000-8000-00000000fc11', b: '00000000-0000-4000-8000-00000000fc21' };
const U = { reviewer: '00000000-0000-4000-8000-00000000cc11', viewer: '00000000-0000-4000-8000-00000000cc12', admin: '00000000-0000-4000-8000-00000000cc13', other: '00000000-0000-4000-8000-00000000cc21', both: '00000000-0000-4000-8000-00000000cc14' };
const NOTE = 'SYNTHETIC: verbal update from the hospital liaison';
const EXAMPLES = fileURLToPath(new URL('../../../packages/schemas/examples/', import.meta.url));
const SEED_RULES = readdirSync(`${EXAMPLES}rules`).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(`${EXAMPLES}rules/${f}`, 'utf8')));
const SEED_CAPS = JSON.parse(readFileSync(`${EXAMPLES}profiles/zztest-facility.json`, 'utf8')).capabilities;

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
  const post = (path: string, user: string | null, payload?: unknown, server = app) => server.inject({ method: 'POST', url: path, headers: as(user), payload: payload as object });
  const get = (path: string, user: string | null) => app.inject({ method: 'GET', url: path, headers: as(user) });
  const fact = (key: string, v: 'yes' | 'no' | 'unknown', extra: Record<string, unknown> = {}) => ({ key, value: { type: 'tri_state', value: v }, note: NOTE, ...extra });
  const asOwner = async (facility: string) => c.query("SELECT set_config('app.facility_id', $1, true)", [facility]);
  const count = async (sql: string, params: unknown[] = []) => Number((await c.query(sql, params)).rows[0].n);
  const factsUrl = (rid: string) => `/api/facilities/${FAC.a}/referrals/${rid}/facts`;
  const newReferral = async () => (await post(`/api/facilities/${FAC.a}/referrals`, U.reviewer)).json().referral.id as string;

  beforeAll(async () => {
    await c.connect();
    await c.query('BEGIN');
    for (const [k, org] of Object.entries(ORG)) {
      await c.query("SELECT set_config('app.organization_id', $1, true)", [org]);
      await c.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [org, `ZZTEST API Org ${k}`]);
      const fac = FAC[k as keyof typeof FAC];
      await asOwner(fac);
      await c.query('INSERT INTO facilities (facility_id, organization_id, name) VALUES ($1, $2, $3)', [fac, org, `ZZTEST API Facility ${k}`]);
    }
    const members: [string, keyof typeof ORG, string[]][] = [[U.reviewer, 'a', ['admissions_reviewer']], [U.viewer, 'a', ['viewer']], [U.admin, 'a', ['facility_admin']], [U.other, 'b', ['admissions_reviewer']], [U.both, 'a', ['viewer', 'admissions_reviewer']]];
    for (const [id, k, roles] of members) {
      await c.query("SELECT set_config('app.organization_id', $1, true), set_config('app.facility_id', $2, true)", [ORG[k], FAC[k]]);
      await c.query('INSERT INTO users (id, organization_id, email, display_name) VALUES ($1, $2, $3, $4)', [id, ORG[k], `zztest.api.${id.slice(-4)}@example.invalid`, 'ZZTEST API user']);
      for (const role of roles) await c.query('INSERT INTO user_facility_roles (user_id, facility_id, role) VALUES ($1, $2, $3)', [id, FAC[k], role]);
    }
    // settings (0008): the seed rule set for both organisations, the synthetic profile for both facilities
    for (const k of ['a', 'b'] as const) {
      await c.query("SELECT set_config('app.organization_id', $1, true), set_config('app.facility_id', $2, true)", [ORG[k], FAC[k]]);
      await c.query("INSERT INTO rule_sets (organization_id, version, criteria_document_ref, rules, created_by) VALUES ($1, 0, 'seed', $2, 'platform:test')", [ORG[k], JSON.stringify(SEED_RULES)]);
      await c.query("INSERT INTO facility_profiles (facility_id, version, capabilities, created_by) VALUES ($1, 0, $2, 'platform:test')", [FAC[k], SEED_CAPS]);
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

  it('401 without an identity; 404, not 403, for another facility, an unknown facility, a bad id or an unknown route; nothing echoed', async () => {
    expect((await post(`/api/facilities/${FAC.a}/referrals`, null)).statusCode).toBe(401);
    expect((await post(`/api/facilities/${FAC.a}/referrals`, 'not-a-uuid')).statusCode).toBe(401);
    expect((await post(`/api/facilities/${FAC.a}/referrals`, U.other)).statusCode).toBe(404);
    expect((await post('/api/facilities/00000000-0000-4000-8000-0000000000ff/referrals', U.reviewer)).statusCode).toBe(404);
    expect((await post('/api/facilities/zz/referrals', U.reviewer)).statusCode).toBe(404);
    const unknown = await get(`/api/facilities/${FAC.a}/zztest-patient-name`, U.reviewer);
    expect([unknown.statusCode, unknown.json()]).toEqual([404, { error: 'not_found' }]);
    const big = await post(`/api/facilities/${FAC.a}/referrals`, U.reviewer, { note: `SYNTHETIC ${'x'.repeat(17_000)}` });
    expect([big.statusCode, big.body.includes('SYNTHETIC')]).toEqual([413, false]);
  });

  let rid = '';
  it('a Reviewer creates a referral: audited, an event emitted, the form lists the rule-set fact keys with their types', async () => {
    const res = await post(`/api/facilities/${FAC.a}/referrals`, U.reviewer);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    rid = body.referral.id;
    expect([body.referral.status, body.facts, body.evaluation]).toEqual(['draft', [], null]);
    expect(body.form.fact_keys).toEqual([
      { key: 'daily_skilled_need', type: 'tri_state', critical: false, read_by: ['seed.favorable.skilled_need_documented'] },
      { key: 'recent_aggression', type: 'tri_state', critical: false, read_by: ['seed.review.behavioral_escalation'] },
      { key: 'ventilator_use', type: 'tri_state', critical: true, read_by: ['seed.hard_stop.ventilator'] },
    ]);
    await asOwner(FAC.a);
    expect(await count("SELECT count(*) AS n FROM audit_log WHERE entity_id = $1 AND action = 'referral.created'", [rid])).toBe(1);
    expect(await count("SELECT count(*) AS n FROM product_events WHERE referral_id = $1 AND event = 'referral.received'", [rid])).toBe(1);
  });

  it('patient-level reads are for Reviewers and Admins: a Viewer is refused (SPEC §6 default); a user holding Viewer and Reviewer roles may write', async () => {
    expect((await get(`/api/facilities/${FAC.a}/referrals/${rid}`, U.viewer)).statusCode).toBe(403);
    expect((await post(factsUrl(rid), U.viewer, fact('ventilator_use', 'yes'))).statusCode).toBe(403);
    expect((await post(`/api/facilities/${FAC.a}/referrals`, U.viewer)).statusCode).toBe(403);
    expect((await get(`/api/facilities/${FAC.a}/referrals/${rid}`, U.other)).statusCode).toBe(404);
    expect((await get(`/api/facilities/${FAC.b}/referrals/${rid}`, U.other)).statusCode).toBe(404);
    const both = await post(`/api/facilities/${FAC.a}/referrals`, U.both);
    expect(both.statusCode).toBe(201);
  });

  it('entering facts re-evaluates every time: Do Not Admit, the correction supersedes and keeps both, then Admit; the stored record is exact', async () => {
    let res = await post(factsUrl(rid), U.reviewer, fact('ventilator_use', 'yes'));
    expect([res.statusCode, res.json().evaluation.outcome]).toEqual([201, 'do_not_admit']);
    res = await post(factsUrl(rid), U.reviewer, fact('ventilator_use', 'no'));
    expect([res.json().evaluation.outcome, res.json().evaluation.sub_reasons]).toEqual(['needs_review', ['missing_info']]);
    await post(factsUrl(rid), U.reviewer, fact('recent_aggression', 'no'));
    res = await post(factsUrl(rid), U.admin, fact('daily_skilled_need', 'yes', { as_of_date: '2001-01-02' }));
    const body = res.json();
    expect(body.evaluation.outcome).toBe('admit');
    expect(body.evaluation.trace.resolution_step).toBe('favorable_rule_true');
    expect(body.evaluation.trace.inputs.processing_complete).toBe(true);
    expect(body.evaluation.trace.confirmation_set).toEqual(['daily_skilled_need', 'recent_aggression', 'ventilator_use']); // 2.7, stored with the evaluation
    expect(body.evaluation.trace.inputs.referral_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.facts.map((f: { key: string; value: { value: string }; as_of_date: string | null }) => [f.key, f.value.value, f.as_of_date]))
      .toEqual([['daily_skilled_need', 'yes', '2001-01-02'], ['recent_aggression', 'no', null], ['ventilator_use', 'no', null]]);

    await asOwner(FAC.a);
    const vent = (await c.query("SELECT id, supersedes, is_critical FROM facts WHERE referral_id = $1 AND key = 'ventilator_use' ORDER BY created_at", [rid])).rows;
    expect(vent).toHaveLength(2);
    expect([vent[0].supersedes, vent[1].supersedes, vent[0].is_critical, vent[1].is_critical]).toEqual([null, vent[0].id, true, true]);
    expect(await count("SELECT count(*) AS n FROM facts WHERE referral_id = $1 AND key = 'recent_aggression' AND NOT is_critical", [rid])).toBe(1);
    const factIds = (await c.query('SELECT id FROM facts WHERE referral_id = $1', [rid])).rows.map((r) => r.id);
    expect(await count("SELECT count(*) AS n FROM audit_log WHERE action = 'fact.entered' AND entity_id = ANY($1)", [factIds])).toBe(3);
    expect(await count("SELECT count(*) AS n FROM audit_log WHERE action = 'fact.corrected' AND entity_id = ANY($1)", [factIds])).toBe(1);
    const events = (await c.query("SELECT event, attrs FROM product_events WHERE referral_id = $1 AND event LIKE 'fact.%' ORDER BY at", [rid])).rows;
    expect(events.map((e) => [e.event, e.attrs.fact_key, e.attrs.decisive])).toEqual([
      ['fact.entered', 'ventilator_use', true], ['fact.corrected', 'ventilator_use', true], ['fact.entered', 'recent_aggression', false], ['fact.entered', 'daily_skilled_need', false],
    ]);
    // a single linear chain: each evaluation points at the one evaluated just before it
    const evs = (await c.query('SELECT id, previous_evaluation_id, raw FROM evaluations WHERE referral_id = $1 ORDER BY evaluated_at', [rid])).rows;
    expect(evs).toHaveLength(4);
    expect(evs.map((e) => [e.previous_evaluation_id, e.raw])).toEqual(evs.map((_, i) => [i === 0 ? null : evs[i - 1].id, false]));
    expect(await count("SELECT count(*) AS n FROM product_events WHERE referral_id = $1 AND event = 'evaluation.created' AND (attrs->>'changed_fact_count')::int = 1", [rid])).toBe(4);
  });

  it('rejects bad input without echoing it: note, key, a value of the wrong type or shape, an impossible or future date', async () => {
    const bad = [
      { ...fact('ventilator_use', 'no'), note: undefined },
      { ...fact('ventilator_use', 'no'), note: '   ' },
      { ...fact('ventilator_use', 'no'), note: 'x'.repeat(501) },
      fact('zztest_unknown_key', 'no'),
      { key: 'ventilator_use', value: { type: 'tri_state', value: 'Yes' }, note: NOTE },
      { key: 'ventilator_use', value: 'yes', note: NOTE },
      { key: 'ventilator_use', value: { type: 'count', value: 3 }, note: NOTE }, // a count can never stand in for yes
      fact('ventilator_use', 'no', { as_of_date: '2001-02-30' }),
      fact('ventilator_use', 'no', { as_of_date: '2999-01-01' }),
    ];
    for (const payload of bad) {
      const res = await post(factsUrl(rid), U.reviewer, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.body).not.toContain('SYNTHETIC');
      expect(res.json()).toEqual({ error: 'invalid_fact' });
    }
  });

  it('count facts: accepted when the rule set reads the key as a count; refused out of range or of the wrong shape', async () => {
    const countRule = { id: 'zz.count', name: 'ZZTEST', kind: 'review', enabled: true, inputs: ['iv_days'], expression: 'iv_days >= 7', sub_reason: 'clinical' };
    await c.query("SELECT set_config('app.organization_id', $1, true)", [ORG.b]);
    await c.query("INSERT INTO rule_sets (organization_id, version, criteria_document_ref, rules, created_by) VALUES ($1, 0, 'seed', $2, 'platform:test')", [ORG.b, JSON.stringify([...SEED_RULES, countRule])]);
    await c.query("SELECT set_config('app.organization_id', '', true)");
    const url = `/api/facilities/${FAC.b}/referrals`;
    const r = (await post(url, U.other)).json().referral.id as string;
    const at = `${url}/${r}/facts`;
    for (const value of [3, null, 100000]) expect((await post(at, U.other, { key: 'iv_days', value: { type: 'count', value }, note: NOTE })).statusCode, String(value)).toBe(201);
    for (const value of [-1, 1.5, 100001, '3']) expect((await post(at, U.other, { key: 'iv_days', value: { type: 'count', value }, note: NOTE })).statusCode, String(value)).toBe(400);
    expect((await post(at, U.other, { key: 'iv_days', value: { type: 'tri_state', value: 'yes' }, note: NOTE })).statusCode).toBe(400);
    const ev = (await get(`${url}/${r}`, U.other)).json().evaluation;
    expect(ev.rule_set_version).toBe(2); // the evaluation pins the version it used
  });

  it('a document still in processing holds the outcome at processing_incomplete', async () => {
    const r = await newReferral();
    await asOwner(FAC.a);
    await c.query(`INSERT INTO documents (facility_id, referral_id, type, sha256, storage_key)
      VALUES ($1::uuid, $2::uuid, 'face_sheet', sha256('zz'::bytea), 'documents/' || $1 || '/' || $2 || '/' || encode(sha256('zz'::bytea), 'hex'))`, [FAC.a, r]);
    const res = await post(factsUrl(r), U.reviewer, fact('ventilator_use', 'no'));
    expect([res.json().evaluation.outcome, res.json().evaluation.sub_reasons, res.json().evaluation.trace.inputs.processing_complete]).toEqual(['needs_review', ['processing_incomplete'], false]);
  });

  it('a specially protected fact stays protected through every correction and its key never reaches an event', async () => {
    const r = await newReferral();
    await asOwner(FAC.a);
    await c.query(`INSERT INTO facts (facility_id, referral_id, key, value, source, evidence, confidence_band, specially_protected, created_by)
      VALUES ($1, $2, 'recent_aggression', '{"type":"tri_state","value":"yes"}', 'ai', '{"document_id":"d","page":1,"quote":"SYNTHETIC","verified":true}', 'high', true, 'worker:job-1')`, [FAC.a, r]);
    for (const v of ['no', 'yes', 'no'] as const) expect((await post(factsUrl(r), U.reviewer, fact('recent_aggression', v))).statusCode).toBe(201);
    await asOwner(FAC.a);
    expect(await count("SELECT count(*) AS n FROM facts WHERE referral_id = $1 AND key = 'recent_aggression' AND NOT specially_protected", [r])).toBe(0);
    expect(await count("SELECT count(*) AS n FROM product_events WHERE referral_id = $1 AND attrs ? 'fact_key'", [r])).toBe(0);
  });

  it('the database refuses a second root assertion for a key (0007): the lineage cannot fork', async () => {
    const r = await newReferral();
    await asOwner(FAC.a);
    const ins = () => c.query(`INSERT INTO facts (facility_id, referral_id, key, value, source, note, created_by) VALUES ($1, $2, 'ventilator_use', '{"type":"tri_state","value":"no"}', 'user', 'SYNTHETIC', $3)`, [FAC.a, r, `user:${U.reviewer}`]);
    await ins();
    await c.query('SAVEPOINT fork');
    // the insert guard would refuse first; switch it off inside the savepoint so only the index can refuse
    await c.query('ALTER TABLE facts DISABLE TRIGGER facts_insert_guard');
    await expect(ins()).rejects.toThrow(/facts_one_root_per_key/);
    await c.query('ROLLBACK TO SAVEPOINT fork');
  });

  it('a finalized referral is not open for fact entry', async () => {
    await asOwner(FAC.a);
    await c.query("UPDATE referrals SET status = 'finalized' WHERE id = $1", [rid]);
    try {
      const res = await post(factsUrl(rid), U.reviewer, fact('ventilator_use', 'yes'));
      expect([res.statusCode, res.json()]).toEqual([409, { error: 'referral_not_open' }]);
    } finally {
      await asOwner(FAC.a);
      await c.query("UPDATE referrals SET status = 'draft' WHERE id = $1", [rid]);
    }
  });

  it('every read is audited (I4) and every response is no-store', async () => {
    await asOwner(FAC.a);
    const before = await count("SELECT count(*) AS n FROM audit_log WHERE action = 'referral.viewed' AND entity_id = $1", [rid]);
    const res = await get(`/api/facilities/${FAC.a}/referrals/${rid}`, U.reviewer);
    expect([res.statusCode, res.headers['cache-control']]).toEqual([200, 'no-store']);
    await asOwner(FAC.a);
    expect(await count("SELECT count(*) AS n FROM audit_log WHERE action = 'referral.viewed' AND entity_id = $1", [rid])).toBe(before + 1);
  });

  it('settings: Reviewers read them with the completeness checklist; only an Admin saves a new profile version, which pins the next evaluation', async () => {
    const path = `/api/facilities/${FAC.a}/settings`;
    expect((await get(path, U.viewer)).statusCode).toBe(403);
    const view = (await get(path, U.reviewer)).json();
    expect([view.configured, view.rule_set.version, view.profile.version]).toEqual([true, 1, 1]);
    expect(view.completeness).toEqual({ required_keys: ['accepts_ventilator'], missing_keys: [] });
    const put = (user: string, payload: unknown) => app.inject({ method: 'PUT', url: path, headers: as(user), payload: payload as object });
    expect((await put(U.reviewer, { capabilities: {}, disabled_rules: [] })).statusCode).toBe(403);
    for (const bad of [{ capabilities: { accepts_ventilator: 'yes' }, disabled_rules: [] }, { capabilities: { zztest_key: true }, disabled_rules: [] },
      { capabilities: { ventilator_beds: -1 }, disabled_rules: [] }, { capabilities: {}, disabled_rules: ['no.such.rule'] }, { capabilities: [], disabled_rules: [] }]) {
      expect((await put(U.admin, bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    // the Admin empties the key the hard stop reads and switches the review rule off
    const saved = (await put(U.admin, { capabilities: {}, disabled_rules: ['seed.review.behavioral_escalation'] })).json();
    expect([saved.profile.version, saved.completeness.missing_keys, saved.rule_set.rules.find((x: { id: string }) => x.id === 'seed.review.behavioral_escalation').enabled_here])
      .toEqual([2, ['accepts_ventilator'], false]);
    const r = await newReferral();
    const ev = (await post(factsUrl(r), U.reviewer, fact('ventilator_use', 'no'))).json().evaluation;
    expect([ev.outcome, ev.facility_profile_version, ev.trace.empty_profile_keys]).toEqual(['needs_review', 2, ['accepts_ventilator']]);
    // the switched-off rule's fact is no longer offered or accepted
    expect((await get(`/api/facilities/${FAC.a}/referrals/${r}`, U.reviewer)).json().form.fact_keys.map((k: { key: string }) => k.key)).not.toContain('recent_aggression');
    expect((await post(factsUrl(r), U.reviewer, fact('recent_aggression', 'yes'))).json()).toEqual({ error: 'invalid_fact' });
    await asOwner(FAC.a);
    expect(await count("SELECT count(*) AS n FROM audit_log WHERE action = 'facility_profile.versioned' AND actor = $1", [`user:${U.admin}`])).toBe(1);
    // restore the seed profile for the tests that follow
    expect((await put(U.admin, { capabilities: SEED_CAPS, disabled_rules: [] })).json().profile.version).toBe(3);
  });

  it('a facility with no settings refuses fact entry rather than guessing', async () => {
    const lone = '00000000-0000-4000-8000-00000000fc12';
    await c.query("SELECT set_config('app.organization_id', $1, true), set_config('app.facility_id', $2, true)", [ORG.a, lone]);
    await c.query('INSERT INTO facilities (facility_id, organization_id, name) VALUES ($1, $2, $3)', [lone, ORG.a, 'ZZTEST API Facility unconfigured']);
    await c.query("INSERT INTO user_facility_roles (user_id, facility_id, role) VALUES ($1, $2, 'admissions_reviewer')", [U.reviewer, lone]);
    await c.query("SELECT set_config('app.facility_id', '', true), set_config('app.organization_id', '', true)");
    const created = (await post(`/api/facilities/${lone}/referrals`, U.reviewer)).json();
    expect(created.form.configured).toBe(false);
    const res = await post(`/api/facilities/${lone}/referrals/${created.referral.id}/facts`, U.reviewer, fact('ventilator_use', 'no'));
    expect([res.statusCode, res.json()]).toEqual([409, { error: 'facility_not_configured' }]);
    expect((await get(`/api/facilities/${lone}/settings`, U.reviewer)).json()).toEqual({ configured: false });
  });

  it('a database refusal is 422 and an infrastructure failure 500, and neither echoes the error message', async () => {
    const thrower = (code: string): Tx => async () => { throw Object.assign(new Error('SYNTHETIC message with ZZTEST CANARY-ALPHA'), { code }); };
    for (const [code, status, error] of [['23514', 422, 'rejected'], ['P0001', 422, 'rejected'], ['08006', 500, 'internal']] as const) {
      const server = buildServer({ tx: thrower(code), auth: 'local-stub', env: 'test' });
      const res = await post(`/api/facilities/${FAC.a}/referrals`, U.reviewer, undefined, server);
      expect([res.statusCode, res.json()]).toEqual([status, { error }]);
      expect(res.body).not.toMatch(/SYNTHETIC|CANARY/);
      await server.close();
    }
  });
});

// The transaction helper production actually runs, against the real codex_app login (read-only probes).
describe.skipIf(!appUrl)('poolTx as codex_app', () => {
  it('runs as codex_app, clears bindings between transactions, and survives a failed one', async () => {
    const db = poolTx(appUrl!);
    try {
      expect(await db.tx(async (q) => (await q<{ u: string }>('SELECT current_user AS u')).rows[0]!.u)).toBe('codex_app');
      await db.tx(async (q) => q("SELECT set_config('app.facility_id', $1, true)", [FAC.a]));
      expect(await db.tx(async (q) => (await q<{ v: string }>("SELECT coalesce(current_setting('app.facility_id', true), '') AS v")).rows[0]!.v)).toBe('');
      await expect(db.tx(async (q) => q('SELECT 1/0'))).rejects.toThrow();
      expect(await db.tx(async (q) => (await q<{ one: number }>('SELECT 1 AS one')).rows[0]!.one)).toBe(1);
    } finally {
      await db.close();
    }
  });
});

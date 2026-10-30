// Manual fact entry end to end against a migrated database (SPEC §5 T7, §6, §12 XF-11, I1-I6). Every request runs
// in a savepoint of one outer transaction as codex_app, exactly the role and bindings production uses, and the
// outer transaction is rolled back: the suite leaves nothing behind. Skips without DATABASE_URL; fails where
// REQUIRE_DATABASE is set (the CI db-checks job).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { buildServer } from '../src/server.ts';
import { DEV_USER_HEADER } from '../src/auth.ts';
import { poolTx, type Tx } from '../src/db.ts';
import { sqsEnqueue } from '../src/queue.ts';
import { s3Storage } from '../src/storage.ts';
import { CreateBucketCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
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
    // by the supersede chain, not created_at: the suite's one transaction gives both rows one timestamp
    const vent = (await c.query("SELECT id, supersedes, is_critical FROM facts WHERE referral_id = $1 AND key = 'ventilator_use' ORDER BY supersedes NULLS FIRST", [rid])).rows;
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
    const countRule = { id: 'zz.count', name: 'ZZTEST', kind: 'review', enabled: true, inputs: ['iv_days'], expression: 'iv_days >= 7', sub_reason: 'clinical', tests: [{ name: 't', facts: {}, profile: {}, expected: 'true' }, { name: 'f', facts: {}, profile: {}, expected: 'false' }, { name: 'u', facts: {}, profile: {}, expected: 'unknown' }] };
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
    const v1 = { based_on_version: 1 };
    expect((await put(U.reviewer, { capabilities: {}, disabled_rules: [], ...v1 })).statusCode).toBe(403);
    for (const bad of [{ capabilities: { accepts_ventilator: 'yes' }, disabled_rules: [], ...v1 }, { capabilities: { zztest_key: true }, disabled_rules: [], ...v1 },
      { capabilities: { ventilator_beds: -1 }, disabled_rules: [], ...v1 }, { capabilities: {}, disabled_rules: ['no.such.rule'], ...v1 }, { capabilities: [], disabled_rules: [], ...v1 },
      { capabilities: {}, disabled_rules: [] }]) {
      expect((await put(U.admin, bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    // hard stops and payer rules stay on (interim, pending F9); a save over a stale version is refused
    for (const id of ['seed.hard_stop.ventilator', 'seed.payer.medicaid_pending']) {
      expect((await put(U.admin, { capabilities: {}, disabled_rules: [id], ...v1 })).json()).toEqual({ error: 'rule_not_switchable' });
    }
    expect([(await put(U.admin, { capabilities: {}, disabled_rules: [], based_on_version: 7 })).statusCode]).toEqual([409]);
    expect(view.rule_set.rules.find((x: { id: string }) => x.id === 'seed.hard_stop.ventilator').switchable).toBe(false);
    // the Admin empties the key the hard stop reads and switches the review rule off
    const saved = (await put(U.admin, { capabilities: {}, disabled_rules: ['seed.review.behavioral_escalation'], ...v1 })).json();
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
    const stale = await put(U.admin, { capabilities: SEED_CAPS, disabled_rules: [], ...v1 });
    expect([stale.statusCode, stale.json()]).toEqual([409, { error: 'settings_changed' }]);
    expect((await put(U.admin, { capabilities: SEED_CAPS, disabled_rules: [], based_on_version: 2 })).json().profile.version).toBe(3);
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
    // a stored rule set the engine refuses answers 409 rule_set_refused on every path, never 500
    await c.query("SELECT set_config('app.organization_id', $1, true), set_config('app.facility_id', $2, true)", [ORG.a, lone]);
    await c.query("INSERT INTO facility_profiles (facility_id, version, capabilities, created_by) VALUES ($1, 0, '{}', 'platform:test')", [lone]);
    const broken = { id: 'zz.broken', name: 'ZZTEST', kind: 'hard_stop', enabled: true, inputs: ['x'], expression: 'x is is yes' };
    await c.query("INSERT INTO rule_sets (organization_id, version, criteria_document_ref, rules, created_by) VALUES ($1, 0, 'zz', $2, 'platform:test')", [ORG.a, JSON.stringify([broken])]);
    await c.query("SELECT set_config('app.facility_id', '', true), set_config('app.organization_id', '', true)");
    for (const res2 of [await get(`/api/facilities/${lone}/settings`, U.reviewer), await post(`/api/facilities/${lone}/referrals/${created.referral.id}/facts`, U.reviewer, fact('ventilator_use', 'no'))]) {
      expect([res2.statusCode, res2.json()]).toEqual([409, { error: 'rule_set_refused' }]);
    }
    // restore a valid rule set for organisation A (a newer version) for the tests that follow
    await c.query("SELECT set_config('app.organization_id', $1, true)", [ORG.a]);
    await c.query("INSERT INTO rule_sets (organization_id, version, criteria_document_ref, rules, created_by) VALUES ($1, 0, 'seed', $2, 'platform:test')", [ORG.a, JSON.stringify(SEED_RULES)]);
    await c.query("SELECT set_config('app.organization_id', '', true)");
  });

  // --- review screens (M3 slice 2): transitions T8–T11, T14 and finalize T12 ---------------------------------
  const refUrl = (rid: string) => `/api/facilities/${FAC.a}/referrals/${rid}`;
  const move = (rid: string, user: string, body: unknown) => post(`${refUrl(rid)}/transitions`, user, body);
  const finalize = (rid: string, user: string, body: unknown) => post(`${refUrl(rid)}/decision`, user, body);
  const withFacts = async (...entries: [string, 'yes' | 'no' | 'unknown'][]) => {
    const rid = await newReferral();
    let view: { evaluation: { id: string; outcome: string } } | undefined;
    for (const [k, v] of entries) view = (await post(factsUrl(rid), U.reviewer, fact(k, v))).json();
    return { rid, ev: view!.evaluation };
  };

  it('review: a manual-entry referral is submitted for review, then finalized on the evaluation the Reviewer saw', async () => {
    const { rid, ev } = await withFacts(['ventilator_use', 'no'], ['recent_aggression', 'no'], ['daily_skilled_need', 'yes']);
    expect(ev.outcome).toBe('admit');
    let view = (await get(refUrl(rid), U.reviewer)).json();
    expect([view.referral.status, view.actions]).toEqual(['draft', ['submit', 'upload']]);
    expect(view.confirmation.every((x: { confirmed: boolean }) => x.confirmed)).toBe(true);
    expect((await finalize(rid, U.reviewer, { evaluation_id: ev.id, decision: 'admit' })).json()).toEqual({ error: 'transition_not_allowed' });
    view = (await move(rid, U.reviewer, { action: 'submit', note: 'ignored: submit carries no note' })).json();
    expect([view.referral.status, view.actions, view.transitions[0].note]).toEqual(['ready_for_review', ['hold', 'request_info', 'escalate', 'upload', 'finalize'], null]);
    // another referral's evaluation, or a reason on an agreeing decision, is refused
    const other = (await withFacts(['daily_skilled_need', 'yes'])).ev.id;
    expect((await finalize(rid, U.reviewer, { evaluation_id: other, decision: 'admit' })).json()).toEqual({ error: 'evaluation_stale' });
    expect((await finalize(rid, U.reviewer, { evaluation_id: ev.id, decision: 'admit', override_reason: 'x' })).json()).toEqual({ error: 'invalid_decision' });
    expect((await finalize(rid, U.viewer, { evaluation_id: ev.id, decision: 'admit' })).statusCode).toBe(403);
    const done = await finalize(rid, U.reviewer, { evaluation_id: ev.id, decision: 'admit' });
    expect(done.statusCode).toBe(201);
    view = done.json();
    expect([view.referral.status, view.decision.decision, view.decision.evaluation_id, view.actions]).toEqual(['finalized', 'admit', ev.id, []]);
    expect((await finalize(rid, U.reviewer, { evaluation_id: ev.id, decision: 'admit' })).json()).toEqual({ error: 'transition_not_allowed' });
    expect((await post(factsUrl(rid), U.reviewer, fact('ventilator_use', 'yes'))).json()).toEqual({ error: 'referral_not_open' });
    await asOwner(FAC.a);
    const actions = (await c.query("SELECT action FROM audit_log WHERE entity_id = $1 OR entity_id = $2 ORDER BY seq", [rid, view.decision.id])).rows.map((r) => r.action);
    expect(actions.filter((a: string) => a !== 'referral.viewed')).toEqual(['referral.created', 'referral.submitted_for_review', 'decision.finalized', 'referral.finalized']);
    const ev2 = (await c.query("SELECT attrs FROM product_events WHERE referral_id = $1 AND event = 'decision.finalized'", [rid])).rows[0].attrs;
    expect([ev2.override, ev2.cosigner_present, ev2.decisive_fact_count]).toEqual([false, false, 3]);
  });

  it('review: an override needs a reason; every fact the decision rests on must be stated first', async () => {
    const nr = await withFacts(['ventilator_use', 'no'], ['recent_aggression', 'yes'], ['daily_skilled_need', 'yes']);
    expect(nr.ev.outcome).toBe('needs_review');
    await move(nr.rid, U.reviewer, { action: 'submit' });
    expect((await finalize(nr.rid, U.reviewer, { evaluation_id: nr.ev.id, decision: 'admit' })).json()).toEqual({ error: 'override_reason_required' });
    expect((await finalize(nr.rid, U.reviewer, { evaluation_id: nr.ev.id, decision: 'admit', override_reason: '   ' })).json()).toEqual({ error: 'override_reason_required' });
    const ok = (await finalize(nr.rid, U.reviewer, { evaluation_id: nr.ev.id, decision: 'admit', override_reason: 'SYNTHETIC: behaviour plan agreed with the hospital' })).json();
    expect([ok.decision.decision, ok.decision.override_reason]).toEqual(['admit', 'SYNTHETIC: behaviour plan agreed with the hospital']);
    await asOwner(FAC.a);
    expect((await c.query("SELECT attrs FROM product_events WHERE referral_id = $1 AND event = 'decision.finalized'", [nr.rid])).rows[0].attrs.override).toBe(true);
    // Admit only by positive confirmation: a hard-stop input stated as unknown is stated, but not known
    const unk = await withFacts(['ventilator_use', 'unknown'], ['recent_aggression', 'no'], ['daily_skilled_need', 'yes']);
    expect(unk.ev.outcome).toBe('needs_review');
    let v = (await move(unk.rid, U.reviewer, { action: 'submit' })).json();
    expect(v.admit_requires).toEqual(['ventilator_use']);
    expect((await finalize(unk.rid, U.reviewer, { evaluation_id: unk.ev.id, decision: 'admit', override_reason: 'SYNTHETIC' })).json()).toEqual({ error: 'confirmation_incomplete' });
    v = (await finalize(unk.rid, U.reviewer, { evaluation_id: unk.ev.id, decision: 'do_not_admit', override_reason: 'SYNTHETIC: cannot confirm' })).json();
    expect(v.decision.decision).toBe('do_not_admit');
    // the hard-stop input was never stated: the confirmation set is incomplete
    const gap = await withFacts(['daily_skilled_need', 'yes']);
    await move(gap.rid, U.reviewer, { action: 'submit' });
    const view = (await get(refUrl(gap.rid), U.reviewer)).json();
    expect(view.confirmation.find((x: { key: string }) => x.key === 'ventilator_use')).toEqual({ key: 'ventilator_use', confirmed: false, known: false });
    expect((await finalize(gap.rid, U.reviewer, { evaluation_id: gap.ev.id, decision: 'do_not_admit', override_reason: 'SYNTHETIC' })).json()).toEqual({ error: 'confirmation_incomplete' });
  });

  const requestCosign = (rid: string, user: string, body: unknown) => post(`${refUrl(rid)}/decision-requests`, user, body);
  const cosign = (rid: string, qid: string, user: string) => post(`${refUrl(rid)}/decision-requests/${qid}/cosign`, user);

  it('co-sign: a hard stop overridden to Admit is filed by the Reviewer and finalized only by a different Admin', async () => {
    const hs = await withFacts(['ventilator_use', 'yes'], ['recent_aggression', 'no'], ['daily_skilled_need', 'yes']);
    expect(hs.ev.outcome).toBe('do_not_admit');
    await move(hs.rid, U.reviewer, { action: 'submit' });
    const body = { evaluation_id: hs.ev.id, decision: 'admit', override_reason: 'SYNTHETIC: hospital confirms weaning before transfer' };
    expect((await finalize(hs.rid, U.admin, body)).json()).toEqual({ error: 'cosign_required' });
    // a decision that needs no co-sign is not filed as a request
    expect((await requestCosign(hs.rid, U.reviewer, { evaluation_id: hs.ev.id, decision: 'do_not_admit' })).json()).toEqual({ error: 'cosign_not_needed' });
    expect((await requestCosign(hs.rid, U.viewer, body)).statusCode).toBe(403);
    let view = (await requestCosign(hs.rid, U.reviewer, body)).json();
    const qid = view.pending_request.id as string;
    expect([view.referral.status, view.pending_request.decision, view.pending_request.can_cosign, view.actions.includes('cosign')]).toEqual(['ready_for_review', 'admit', false, false]);
    // the requester cannot co-sign; a Reviewer cannot co-sign; the Admin sees it as theirs to co-sign
    expect((await cosign(hs.rid, qid, U.reviewer)).json()).toEqual({ error: 'cosign_admin_only' });
    view = (await get(refUrl(hs.rid), U.admin)).json();
    expect([view.pending_request.can_cosign, view.actions.includes('cosign')]).toEqual([true, true]);
    view = (await cosign(hs.rid, qid, U.admin)).json();
    expect([view.referral.status, view.decision.decision, view.decision.decided_by, view.pending_request, view.actions]).toEqual(['finalized', 'admit', U.reviewer, null, ['amend']]);
    await asOwner(FAC.a);
    const row = (await c.query('SELECT cosigned_by, cosigned_role, hard_stop_override, decision_request_id FROM decisions WHERE referral_id = $1', [hs.rid])).rows[0];
    expect(row).toEqual({ cosigned_by: U.admin, cosigned_role: 'facility_admin', hard_stop_override: true, decision_request_id: qid });
    const ev = (await c.query("SELECT attrs FROM product_events WHERE referral_id = $1 AND event = 'decision.finalized'", [hs.rid])).rows[0].attrs;
    expect([ev.override, ev.cosigner_present]).toEqual([true, true]);
    expect((await cosign(hs.rid, qid, U.admin)).json()).toEqual({ error: 'transition_not_allowed' });
  });

  it('co-sign: an Admit after a hard stop cleared by a settings change still needs the second Admin', async () => {
    const hs = await withFacts(['ventilator_use', 'yes'], ['recent_aggression', 'no'], ['daily_skilled_need', 'yes']);
    expect(hs.ev.outcome).toBe('do_not_admit');
    await move(hs.rid, U.reviewer, { action: 'submit' });
    // the Admin switches the capability on and re-evaluates: the recommendation becomes Admit
    const path = `/api/facilities/${FAC.a}/settings`;
    const cur = (await get(path, U.admin)).json();
    const put = (caps: unknown, v: number) => app.inject({ method: 'PUT', url: path, headers: as(U.admin), payload: { capabilities: caps, disabled_rules: cur.profile.disabled_rules, based_on_version: v } });
    await put({ ...cur.profile.capabilities, accepts_ventilator: true }, cur.profile.version);
    const view = (await post(`${refUrl(hs.rid)}/evaluate`, U.admin)).json();
    expect([view.evaluation.outcome, view.cosign.admit]).toEqual(['admit', true]);
    expect((await finalize(hs.rid, U.admin, { evaluation_id: view.evaluation.id, decision: 'admit' })).json()).toEqual({ error: 'cosign_required' });
    // a Do Not Admit needs no co-sign; the Admit goes through a second Admin (the Reviewer files, the Admin co-signs)
    const filed = (await requestCosign(hs.rid, U.reviewer, { evaluation_id: view.evaluation.id, decision: 'admit' })).json().pending_request;
    expect([filed.requested_by, filed.requested_by_name]).toEqual([U.reviewer, 'ZZTEST API user']);
    // a requester who loses their role here can no longer have their decision carried out
    await c.query('SAVEPOINT lost');
    await asOwner(FAC.a);
    await c.query("DELETE FROM user_facility_roles WHERE user_id = $1 AND facility_id = $2", [U.reviewer, FAC.a]);
    expect((await get(refUrl(hs.rid), U.admin)).json().pending_request).toBe(null);
    expect((await cosign(hs.rid, filed.id, U.admin)).json()).toEqual({ error: 'request_not_current' });
    await c.query('ROLLBACK TO SAVEPOINT lost');
    expect((await cosign(hs.rid, filed.id, U.admin)).json().decision).toMatchObject({ decision: 'admit', decided_by: U.reviewer });
    await put(cur.profile.capabilities, cur.profile.version + 1);
  });

  it('co-sign: an Admin cannot co-sign their own request; a newer request or a newer evaluation replaces the old one', async () => {
    const hs = await withFacts(['ventilator_use', 'yes'], ['recent_aggression', 'no'], ['daily_skilled_need', 'yes']);
    await move(hs.rid, U.reviewer, { action: 'submit' });
    const body = { evaluation_id: hs.ev.id, decision: 'admit', override_reason: 'SYNTHETIC: first request' };
    // an Admin's own request needs another Admin (this facility has one: open founder item, one-Admin facilities)
    const ownView = (await requestCosign(hs.rid, U.admin, body)).json();
    expect([ownView.pending_request.can_cosign, ownView.actions.includes('cosign')]).toEqual([false, false]);
    const own = ownView.pending_request.id as string;
    expect((await cosign(hs.rid, own, U.admin)).json()).toEqual({ error: 'cosign_own_request' });
    const first = (await requestCosign(hs.rid, U.reviewer, body)).json().pending_request.id as string;
    expect((await cosign(hs.rid, own, U.admin)).json()).toEqual({ error: 'request_not_current' });
    // a fact entered after the request makes a new evaluation: the request no longer stands
    await post(factsUrl(hs.rid), U.reviewer, fact('recent_aggression', 'no'));
    const view = (await get(refUrl(hs.rid), U.admin)).json();
    expect(view.pending_request).toBe(null);
    expect((await cosign(hs.rid, first, U.admin)).json()).toEqual({ error: 'evaluation_stale' });
    // a settings change also retires a filed request
    const again = await withFacts(['ventilator_use', 'yes'], ['recent_aggression', 'no'], ['daily_skilled_need', 'yes']);
    await move(again.rid, U.reviewer, { action: 'submit' });
    const filed = (await requestCosign(again.rid, U.reviewer, { ...body, evaluation_id: again.ev.id })).json().pending_request.id as string;
    const path = `/api/facilities/${FAC.a}/settings`;
    const cur = (await get(path, U.admin)).json();
    await app.inject({ method: 'PUT', url: path, headers: as(U.admin), payload: { capabilities: cur.profile.capabilities, disabled_rules: cur.profile.disabled_rules, based_on_version: cur.profile.version } });
    expect((await get(refUrl(again.rid), U.admin)).json().pending_request).toBe(null);
    expect((await cosign(again.rid, filed, U.admin)).json()).toEqual({ error: 'evaluation_stale' });
  });

  it('a document against a person holds Admit until that key is stated again; other entries do not clear it', async () => {
    const rid = await newReferral();
    expect((await post(factsUrl(rid), U.reviewer, fact('ventilator_use', 'no'))).statusCode).toBe(201);
    await post(factsUrl(rid), U.reviewer, fact('recent_aggression', 'no'));
    await asOwner(FAC.a);
    await c.query(`INSERT INTO evaluations (facility_id, referral_id, previous_evaluation_id, raw, outcome, clinical_outcome, financial_status, sub_reasons, trace, criteria_document_ref, rule_set_version, facility_profile_version, model_id, prompt_version, extractor_version, ocr_engine_version, engine_version, evaluated_at)
      SELECT facility_id, referral_id, id, raw, outcome, clinical_outcome, financial_status, sub_reasons, trace || '{"disagreements": ["ventilator_use"]}', criteria_document_ref, rule_set_version, facility_profile_version, model_id, prompt_version, extractor_version, ocr_engine_version, engine_version, now() + interval '1 second'
      FROM evaluations WHERE facility_id = $1 AND referral_id = $2 ORDER BY evaluated_at DESC LIMIT 1`, [FAC.a, rid]);
    await c.query("SELECT set_config('app.facility_id', '', true)");
    const view = async () => (await get(refUrl(rid), U.reviewer)).json();
    let v = await view();
    expect(v.admit_requires).toContain('ventilator_use');
    await post(`${refUrl(rid)}/transitions`, U.reviewer, { action: 'submit' });
    v = await view();
    expect((await post(`${refUrl(rid)}/decision`, U.reviewer, { evaluation_id: v.evaluation.id, decision: 'admit' })).json().error).toBe('confirmation_incomplete');
  });

  it('co-sign: after a flipped hard-stop input every decision is filed for co-sign; unknown -> known and other corrections are not flips', async () => {
    const flip = await withFacts(['ventilator_use', 'yes'], ['ventilator_use', 'no'], ['recent_aggression', 'no'], ['daily_skilled_need', 'yes']);
    expect(flip.ev.outcome).toBe('admit');
    const fv = (await move(flip.rid, U.reviewer, { action: 'submit' })).json();
    expect([fv.cosign.any, fv.actions.includes('finalize')]).toEqual([true, true]);
    expect((await finalize(flip.rid, U.reviewer, { evaluation_id: flip.ev.id, decision: 'admit' })).json()).toEqual({ error: 'cosign_required' });
    // after a flip, Do Not Admit needs the co-sign too (the database's hard-stop CHECK covers only Admit)
    const dna = { evaluation_id: flip.ev.id, decision: 'do_not_admit', override_reason: 'SYNTHETIC' };
    expect((await finalize(flip.rid, U.reviewer, dna)).json()).toEqual({ error: 'cosign_required' });
    expect((await requestCosign(flip.rid, U.reviewer, dna)).json().pending_request.decision).toBe('do_not_admit');
    const qid = (await requestCosign(flip.rid, U.reviewer, { evaluation_id: flip.ev.id, decision: 'admit' })).json().pending_request.id as string;
    expect((await cosign(flip.rid, qid, U.admin)).json().decision).toMatchObject({ decision: 'admit', override_reason: null });
    // AI readings that differ, with no person involved, are not a person's correction: no co-sign is forced
    const aiOnly = await newReferral();
    await asOwner(FAC.a);
    const ai = (v: 'yes' | 'no', sup: string | null) => c.query(`INSERT INTO facts (facility_id, referral_id, key, value, source, evidence, confidence_band, supersedes, created_by)
      VALUES ($1, $2, 'ventilator_use', $3, 'ai', $4, 'high', $5, 'worker:zz') RETURNING id`, [FAC.a, aiOnly, { type: 'tri_state', value: v }, { document_id: 'zz', page: 1, quote: 'SYNTHETIC', verified: true }, sup]);
    const firstAi = (await ai('yes', null)).rows[0].id as string;
    await ai('no', firstAi);
    await c.query("SELECT set_config('app.facility_id', '', true)");
    expect((await get(refUrl(aiOnly), U.reviewer)).json().cosign.any).toBe(false);
    // ...but a person correcting the AI's reading is a flip
    await post(factsUrl(aiOnly), U.reviewer, fact('ventilator_use', 'yes'));
    expect((await get(refUrl(aiOnly), U.reviewer)).json().cosign.any).toBe(true);
    for (const steps of [[['ventilator_use', 'unknown'], ['ventilator_use', 'no']], [['ventilator_use', 'no'], ['daily_skilled_need', 'no'], ['daily_skilled_need', 'yes']]] as [string, 'yes' | 'no' | 'unknown'][][]) {
      const r = await withFacts(...steps, ['recent_aggression', 'no'], ['daily_skilled_need', 'yes']);
      await move(r.rid, U.reviewer, { action: 'submit' });
      expect((await finalize(r.rid, U.reviewer, { evaluation_id: r.ev.id, decision: 'admit' })).statusCode, JSON.stringify(steps)).toBe(201);
    }
  });

  // --- amendments (M3 slice 4; T13) ----------------------------------------------------------------------
  const amend = (rid: string, user: string, body: unknown) => post(`${refUrl(rid)}/amendments`, user, body);

  it('amend: an Admin records a new decision on a finalized referral with a reason; the original stays as it was', async () => {
    const { rid, ev } = await withFacts(['ventilator_use', 'no'], ['recent_aggression', 'no'], ['daily_skilled_need', 'yes']);
    await move(rid, U.reviewer, { action: 'submit' });
    const done = (await finalize(rid, U.reviewer, { evaluation_id: ev.id, decision: 'admit' })).json();
    const original = done.decision;
    expect([done.actions, (await get(refUrl(rid), U.admin)).json().actions]).toEqual([[], ['amend']]);
    const body = { evaluation_id: ev.id, decision: 'do_not_admit', override_reason: 'SYNTHETIC: bed no longer available', amendment_reason: 'SYNTHETIC: facility capacity changed' };
    expect((await amend(rid, U.reviewer, body)).json()).toEqual({ error: 'amend_admin_only' });
    expect((await amend(rid, U.viewer, body)).statusCode).toBe(403);
    expect((await amend(rid, U.admin, { ...body, amendment_reason: ' ' })).json()).toEqual({ error: 'amendment_reason_required' });
    expect((await amend(rid, U.admin, { ...body, override_reason: undefined })).json()).toEqual({ error: 'override_reason_required' });
    // settings changed after finalize do not block an amendment: the facts are frozen and it decides on the record
    const path = `/api/facilities/${FAC.a}/settings`;
    const cur = (await get(path, U.admin)).json();
    await app.inject({ method: 'PUT', url: path, headers: as(U.admin), payload: { capabilities: cur.profile.capabilities, disabled_rules: cur.profile.disabled_rules, based_on_version: cur.profile.version } });
    let view = (await amend(rid, U.admin, body)).json();
    expect([view.referral.status, view.decision.decision, view.decision.amends_decision_id, view.decisions.length]).toEqual(['amended', 'do_not_admit', original.id, 2]);
    expect(view.decisions[1]).toEqual(original); // untouched
    // amend again, back to the recommendation: no override reason, a new amendment reason
    view = (await amend(rid, U.admin, { evaluation_id: ev.id, decision: 'admit', amendment_reason: 'SYNTHETIC: bed reopened' })).json();
    expect([view.referral.status, view.decisions.map((d: { decision: string }) => d.decision), view.transitions.map((t: { transition: string }) => t.transition)])
      .toEqual(['amended', ['admit', 'do_not_admit', 'admit'], ['T14', 'T12', 'T13', 'T13']]);
    // an amendment pins the recorded evaluation
    const other = (await withFacts(['daily_skilled_need', 'yes'])).ev.id;
    expect((await amend(rid, U.admin, { ...body, evaluation_id: other })).json()).toEqual({ error: 'evaluation_stale' });
    // facts stay frozen after amending too
    expect((await post(factsUrl(rid), U.reviewer, fact('ventilator_use', 'yes'))).json()).toEqual({ error: 'referral_not_open' });
    await asOwner(FAC.a);
    const audit = (await c.query("SELECT action FROM audit_log WHERE entity_id = ANY($1) AND action IN ('decision.amended', 'referral.amended') ORDER BY seq",
      [[rid, ...view.decisions.map((d: { id: string }) => d.id)]])).rows.map((r) => r.action);
    expect(audit).toEqual(['decision.amended', 'referral.amended', 'decision.amended', 'referral.amended']);
    const evs = (await c.query("SELECT attrs FROM product_events WHERE referral_id = $1 AND event = 'decision.amended' ORDER BY at", [rid])).rows.map((r) => r.attrs.override);
    expect(evs).toEqual([true, false]);
  });

  it('amend: an amendment to Admit over a hard stop is filed by one Admin and co-signed by another', async () => {
    const ADMIN2 = '00000000-0000-4000-8000-00000000cc15';
    await c.query("SELECT set_config('app.organization_id', $1, true), set_config('app.facility_id', $2, true)", [ORG.a, FAC.a]);
    await c.query("INSERT INTO users (id, organization_id, email, display_name) VALUES ($1, $2, 'zztest.api.cc15@example.invalid', 'ZZTEST API admin two') ON CONFLICT DO NOTHING", [ADMIN2, ORG.a]);
    await c.query("INSERT INTO user_facility_roles (user_id, facility_id, role) VALUES ($1, $2, 'facility_admin') ON CONFLICT DO NOTHING", [ADMIN2, FAC.a]);
    await c.query("SELECT set_config('app.facility_id', '', true), set_config('app.organization_id', '', true)");
    const hs = await withFacts(['ventilator_use', 'yes'], ['recent_aggression', 'no'], ['daily_skilled_need', 'yes']);
    await move(hs.rid, U.reviewer, { action: 'submit' });
    await finalize(hs.rid, U.reviewer, { evaluation_id: hs.ev.id, decision: 'do_not_admit' });
    const body = { evaluation_id: hs.ev.id, decision: 'admit', override_reason: 'SYNTHETIC: weaned before transfer', amendment_reason: 'SYNTHETIC: new discharge summary' };
    expect((await amend(hs.rid, U.admin, body)).json()).toEqual({ error: 'cosign_required' });
    expect((await requestCosign(hs.rid, U.reviewer, body)).json()).toEqual({ error: 'amend_admin_only' });
    const filed = (await requestCosign(hs.rid, U.admin, body)).json().pending_request;
    expect([filed.amendment_reason, filed.can_cosign]).toEqual(['SYNTHETIC: new discharge summary', false]);
    expect((await cosign(hs.rid, filed.id, U.admin)).json()).toEqual({ error: 'cosign_own_request' });
    const view = (await cosign(hs.rid, filed.id, ADMIN2)).json();
    expect([view.referral.status, view.decision.decision, view.decision.decided_by, view.decision.cosigned_by, view.pending_request])
      .toEqual(['amended', 'admit', U.admin, ADMIN2, null]);
    expect((await cosign(hs.rid, filed.id, ADMIN2)).json()).toEqual({ error: 'request_not_current' });
    // a blank amendment reason is a missing one, not an original request
    expect((await requestCosign(hs.rid, U.admin, { ...body, amendment_reason: '  ' })).json()).toEqual({ error: 'amendment_reason_required' });
    // overtaken: a filing is replaced by another Admin's direct amendment and can no longer be co-signed
    const again = (await requestCosign(hs.rid, U.admin, { ...body, amendment_reason: 'SYNTHETIC: confirm again' })).json().pending_request;
    expect((await amend(hs.rid, ADMIN2, { evaluation_id: hs.ev.id, decision: 'do_not_admit', amendment_reason: 'SYNTHETIC: direct' })).statusCode).toBe(201);
    expect((await get(refUrl(hs.rid), ADMIN2)).json().pending_request).toBe(null);
    expect((await cosign(hs.rid, again.id, ADMIN2)).json()).toEqual({ error: 'request_not_current' });
    // a filer who is no longer an Admin cannot have an amendment carried out
    const third = (await requestCosign(hs.rid, U.admin, { ...body, amendment_reason: 'SYNTHETIC: third' })).json().pending_request;
    await c.query('SAVEPOINT demoted');
    await c.query("SELECT set_config('app.organization_id', $1, true), set_config('app.facility_id', $2, true)", [ORG.a, FAC.a]);
    await c.query("DELETE FROM user_facility_roles WHERE user_id = $1 AND facility_id = $2", [U.admin, FAC.a]);
    await c.query("INSERT INTO user_facility_roles (user_id, facility_id, role) VALUES ($1, $2, 'admissions_reviewer')", [U.admin, FAC.a]);
    expect((await get(refUrl(hs.rid), ADMIN2)).json().pending_request).toBe(null);
    expect((await cosign(hs.rid, third.id, ADMIN2)).json()).toEqual({ error: 'request_not_current' });
    await c.query('ROLLBACK TO SAVEPOINT demoted');
  });

  it('amend: an Admit amendment holds under the settings the evaluation was made under, not only the current ones', async () => {
    // a review-rule input left unknown: the Reviewer records Do Not Admit
    const r = await withFacts(['ventilator_use', 'no'], ['daily_skilled_need', 'unknown'], ['recent_aggression', 'unknown']);
    expect(r.ev.outcome).toBe('needs_review');
    await move(r.rid, U.reviewer, { action: 'submit' });
    expect((await finalize(r.rid, U.reviewer, { evaluation_id: r.ev.id, decision: 'do_not_admit', override_reason: 'SYNTHETIC: cannot confirm' })).statusCode).toBe(201);
    const body = { evaluation_id: r.ev.id, decision: 'admit', override_reason: 'SYNTHETIC', amendment_reason: 'SYNTHETIC: amend' };
    expect((await amend(r.rid, U.admin, body)).json()).toEqual({ error: 'confirmation_incomplete' });
    // switching the review rule off does not open the gate: the recorded evaluation was made with it on
    const path = `/api/facilities/${FAC.a}/settings`;
    const cur = (await get(path, U.admin)).json();
    const put = (disabled: string[], v: number) => app.inject({ method: 'PUT', url: path, headers: as(U.admin), payload: { capabilities: cur.profile.capabilities, disabled_rules: disabled, based_on_version: v } });
    expect((await put(['seed.review.behavioral_escalation'], cur.profile.version)).statusCode).toBe(200);
    expect((await amend(r.rid, U.admin, body)).json()).toEqual({ error: 'confirmation_incomplete' });
    await put(cur.profile.disabled_rules, cur.profile.version + 1);
  });

  // --- documents (M3 slice 5): signed upload into quarantine, checked bytes, T1/T4/T5/T6 ------------------
  const BUCKET = process.env['S3_DOCUMENTS_BUCKET'] ?? 'codex-health-documents-local';
  const withS3 = !!process.env['AWS_ENDPOINT_URL']; // localstack only
  if (!withS3 && process.env['REQUIRE_DATABASE']) throw new Error('AWS_ENDPOINT_URL (localstack) must be set here: the document tests may not be skipped in the db-checks job');
  // rebuilt for each test: the upload rate limit counts per server, and the suite would otherwise add up to it
  let docApp = buildServer({ tx, auth: 'local-stub', env: 'test', storage: withS3 ? s3Storage(BUCKET) : null });
  beforeEach(() => { docApp = buildServer({ tx, auth: 'local-stub', env: 'test', storage: withS3 ? s3Storage(BUCKET) : null }); });
  const PDF = (n: number) => Buffer.from(`%PDF-1.4\nZZTEST synthetic document ${n}\n`);
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
  /** Upload like the browser: ask for a URL, PUT the bytes, then ask the API to check and record them. */
  const upload = async (rid: string, body: Buffer, extra: Record<string, unknown> = {}, user = U.reviewer) => {
    const link = await post(`${refUrl(rid)}/documents/uploads`, user, { sha256: sha(body), bytes: body.length }, docApp);
    if (link.statusCode !== 201) return link;
    expect((await fetch(link.json().url, { method: 'PUT', body })).status).toBe(200);
    return post(`${refUrl(rid)}/documents`, user, { sha256: sha(body), type: 'face_sheet', ...extra }, docApp);
  };
  const asPipeline = async (rid: string, docStatus: 'failed' | 'processed', refStatus: 'partial_failure' | 'ready_for_review') => {
    // the worker's part (M4), done here as the owner: report the document and move the referral
    await asOwner(FAC.a);
    await c.query("UPDATE documents SET status = $2, updated_at = now() WHERE referral_id = $1 AND status = 'uploaded'", [rid, docStatus]);
    await c.query('UPDATE referrals SET status = $2 WHERE id = $1', [rid, refStatus]);
    await c.query("SELECT set_config('app.facility_id', '', true)");
  };

  describe.skipIf(!withS3)('documents', () => {
    const s3 = new S3Client({ endpoint: process.env['AWS_ENDPOINT_URL'], forcePathStyle: true }); // localstack only
    beforeAll(async () => { // localstack only
      await s3.send(new CreateBucketCommand({ Bucket: BUCKET })).catch((err: { name?: string }) => {
        if (err.name !== 'BucketAlreadyOwnedByYou' && err.name !== 'BucketAlreadyExists') throw err;
      });
    });

    it('a job is queued only after the move to processing commits, with ids alone; a queue failure is reported', async () => {
      const order: string[] = [];
      const sent: [string, string][] = [];
      let down = false;
      const watched: typeof tx = async (fn) => { const r = await tx(fn); order.push('commit'); return r; };
      docApp = buildServer({ tx: watched, auth: 'local-stub', env: 'test', storage: s3Storage(BUCKET), enqueue: async (f, r) => {
        order.push('send');
        if (down) throw new Error('SYNTHETIC-CANARY');
        sent.push([f, r]);
      } });
      const act = (rid: string, action: string, extra = {}) => docApp.inject({ method: 'POST', url: `${refUrl(rid)}/transitions`, headers: as(U.reviewer), payload: { action, ...extra } });
      const rid = await newReferral();
      await upload(rid, PDF(41));
      expect(sent).toEqual([]); // a draft waits for an explicit process (T1)
      order.length = 0;
      expect((await act(rid, 'process')).statusCode).toBe(201);
      expect(sent).toEqual([[FAC.a, rid]]);
      expect(order.slice(-2)).toEqual(['commit', 'send']); // the worker must find it processing

      const setStatus = async (id: string, status: string) => {
        await asOwner(FAC.a);
        await c.query('UPDATE referrals SET status = $2 WHERE id = $1', [id, status]);
        await c.query("SELECT set_config('app.facility_id', '', true)");
      };
      const later = await newReferral();
      await upload(later, PDF(42));
      await setStatus(later, 'ready_for_review');
      await upload(later, PDF(43)); // T6: a new document on a referral under review goes straight to the pipeline
      expect(sent.at(-1)).toEqual([FAC.a, later]);
      const failedDoc = (await get(refUrl(later), U.reviewer)).json().documents[0].id as string;
      await asOwner(FAC.a);
      await c.query("UPDATE documents SET status = 'failed' WHERE id = $1", [failedDoc]);
      await setStatus(later, 'partial_failure');
      sent.length = 0;
      expect((await upload(later, PDF(45), { replaces: failedDoc })).statusCode).toBe(201); // T4
      expect(sent).toEqual([[FAC.a, later]]);

      const held = await newReferral();
      await post(factsUrl(held), U.reviewer, fact('ventilator_use', 'no'));
      await setStatus(held, 'ready_for_review');
      sent.length = 0;
      expect((await act(held, 'hold', { note: 'SYNTHETIC' })).statusCode).toBe(201);
      expect(sent).toEqual([]); // no other transition sends a job

      const third = await newReferral();
      await upload(third, PDF(44));
      down = true;
      const refused = await act(third, 'process');
      expect([refused.statusCode, refused.body.includes('CANARY'), refused.json().error]).toEqual([503, false, 'queue_unavailable']);
      expect((await get(refUrl(third), U.reviewer)).json().referral.status).toBe('processing'); // the known gap: the watchdog (slice 6) re-sends
    });

    it('the job message is exactly the three ids, with a fresh job id each time', async () => {
      const bodies: Record<string, string>[] = [];
      const queues: (string | undefined)[] = [];
      const send = sqsEnqueue('q-url', async (cmd) => { bodies.push(JSON.parse(cmd.input.MessageBody ?? '')); queues.push(cmd.input.QueueUrl); });
      await send(FAC.a, 'r-1');
      await send(FAC.a, 'r-1');
      expect(Object.keys(bodies[0]!).sort()).toEqual(['facilityId', 'jobId', 'referralId']);
      expect([bodies[0]!['facilityId'], bodies[0]!['referralId'], queues[0]]).toEqual([FAC.a, 'r-1', 'q-url']);
      expect(bodies[0]!['jobId']).toMatch(/^[a-z0-9-]{1,64}$/);
      expect(bodies[0]!['jobId']).not.toBe(bodies[1]!['jobId']);
    });

    /** A referral with one processed document and one AI reading of it. */
    const withReading = async (n: number, key = 'ventilator_use', value: 'yes' | 'no' = 'no', verified = true) => {
      const rid = await newReferral();
      const docId = (await upload(rid, PDF(n))).json().documents[0].id as string;
      await asOwner(FAC.a);
      await c.query("UPDATE documents SET status = 'processed' WHERE id = $1", [docId]);
      const factId = (await c.query(`INSERT INTO facts (facility_id, referral_id, key, value, source, evidence, confidence_band, single_source, created_by) VALUES ($1, $2, $3, $4, 'ai', $5, 'high', true, 'worker:zz') RETURNING id`,
        [FAC.a, rid, key, { type: 'tri_state', value }, { document_id: docId, page: 2, quote: 'SYNTHETIC not on a ventilator', verified, span: null, coordinates: null }])).rows[0].id as string;
      await c.query("SELECT set_config('app.facility_id', '', true)");
      return { rid, docId, factId };
    };
    const open = (rid: string, docId: string, factId = '', user = U.reviewer) => docApp.inject({ method: 'GET', url: `${refUrl(rid)}/documents/${docId}/view${factId ? `?fact=${factId}` : ''}`, headers: as(user) });

    it('evidence: the view carries the quote; a link is audited, counted only when the fact cites it, and stays inside its referral', async () => {
      const { rid, docId, factId } = await withReading(51);
      const fact = (await get(refUrl(rid), U.reviewer)).json().facts.find((f: { key: string }) => f.key === 'ventilator_use');
      expect([fact.source, fact.evidence, fact.confidence_band, fact.single_source]).toEqual(['ai', { document_id: docId, page: 2, quote: 'SYNTHETIC not on a ventilator', verified: true }, 'high', true]);

      const res = await open(rid, docId, factId);
      expect(res.statusCode).toBe(200);
      expect(res.json().url).toContain('X-Amz-Expires=120');
      expect(res.json().url).toContain('response-content-disposition=inline');
      expect(res.json().url).toContain('response-cache-control=no-store');
      await asOwner(FAC.a);
      expect(await count("SELECT count(*) AS n FROM audit_log WHERE action = 'document.viewed' AND entity_id = $1", [docId])).toBe(1);
      const seen = async () => (await c.query("SELECT attrs FROM product_events WHERE referral_id = $1 AND event = 'evidence.viewed'", [rid])).rows.map((r) => r.attrs);
      expect(await seen()).toEqual([{ fact_key: 'ventilator_use', document_id: docId, page: 2, decisive: false }]);
      await c.query("SELECT set_config('app.facility_id', '', true)");

      await open(rid, docId); // opened without a fact
      await asOwner(FAC.a);
      expect(await seen()).toHaveLength(1);
      await c.query("SELECT set_config('app.facility_id', '', true)");

      const other = await newReferral();
      expect((await open(other, docId)).statusCode).toBe(404);
      expect((await open(rid, 'not-a-uuid')).statusCode).toBe(404);
      expect((await open(rid, docId, '', U.viewer)).statusCode).toBe(403); // a Viewer sees no referral, and so no document
      let n = 60;
      for (const status of ['uploaded', 'failed', 'unreadable']) { // only a document that was read opens inline
        const fresh = await newReferral();
        const id = (await upload(fresh, PDF((n += 1)))).json().documents[0].id as string;
        await asOwner(FAC.a);
        await c.query('UPDATE documents SET status = $2 WHERE id = $1', [id, status]);
        await c.query("SELECT set_config('app.facility_id', '', true)");
        expect((await open(fresh, id)).statusCode).toBe(404);
      }
    });

    it('the trust signals survive the trip: an unverified quote stays unverified, a protected key stays out, a foreign fact counts nothing', async () => {
      const { rid, docId } = await withReading(55, 'ventilator_use', 'no', false);
      expect((await get(refUrl(rid), U.reviewer)).json().facts[0].evidence.verified).toBe(false);
      const other = await withReading(56);
      await open(rid, docId, other.factId); // a fact of another referral opens nothing in the count
      await open(rid, docId, '00000000-0000-4000-8000-000000000000');
      await asOwner(FAC.a);
      const events = async (id: string) => (await c.query("SELECT attrs FROM product_events WHERE referral_id = $1 AND event = 'evidence.viewed'", [id])).rows.map((r) => r.attrs);
      expect(await events(rid)).toEqual([]);
      await c.query("SELECT set_config('app.facility_id', '', true)");
    });

    it('the queue reports a raw recommendation as raw', async () => {
      const rid = await newReferral();
      await post(factsUrl(rid), U.reviewer, fact('ventilator_use', 'no'));
      await asOwner(FAC.a);
      await c.query(`INSERT INTO evaluations (facility_id, referral_id, previous_evaluation_id, raw, outcome, clinical_outcome, financial_status, sub_reasons, trace, criteria_document_ref, rule_set_version, facility_profile_version, model_id, prompt_version, extractor_version, ocr_engine_version, engine_version, evaluated_at)
        SELECT facility_id, referral_id, id, true, outcome, clinical_outcome, financial_status, sub_reasons, trace, criteria_document_ref, rule_set_version, facility_profile_version, model_id, prompt_version, extractor_version, ocr_engine_version, engine_version, now() + interval '1 second'
        FROM evaluations WHERE facility_id = $1 AND referral_id = $2 ORDER BY evaluated_at DESC LIMIT 1`, [FAC.a, rid]);
      await c.query("SELECT set_config('app.facility_id', '', true)");
      const list = (await docApp.inject({ method: 'GET', url: `/api/facilities/${FAC.a}/referrals`, headers: as(U.reviewer) })).json().referrals;
      expect(list.find((r: { id: string }) => r.id === rid).raw).toBe(true);
    });

    it('evidence.viewed never names a specially protected key', async () => {
      const rid = await newReferral();
      const docId = (await upload(rid, PDF(57))).json().documents[0].id as string;
      await asOwner(FAC.a);
      await c.query("UPDATE documents SET status = 'processed' WHERE id = $1", [docId]);
      const id = (await c.query(`INSERT INTO facts (facility_id, referral_id, key, value, source, evidence, confidence_band, specially_protected, created_by) VALUES ($1, $2, 'ventilator_use', $3, 'ai', $4, 'high', true, 'worker:zz') RETURNING id`,
        [FAC.a, rid, { type: 'tri_state', value: 'no' }, { document_id: docId, page: 2, quote: 'SYNTHETIC', verified: true }])).rows[0].id as string;
      await c.query("SELECT set_config('app.facility_id', '', true)");
      expect((await open(rid, docId, id)).statusCode).toBe(200);
      await asOwner(FAC.a);
      const attrs = (await c.query("SELECT attrs FROM product_events WHERE referral_id = $1 AND event = 'evidence.viewed'", [rid])).rows;
      expect(attrs).toEqual([{ attrs: { document_id: docId, page: 2, decisive: false } }]);
      await c.query("SELECT set_config('app.facility_id', '', true)");
    });

    it('confirming needs the page opened by this person, on the current reading, and keeps the flag', async () => {
      const { rid, docId, factId } = await withReading(52);
      const confirm = (over = {}, user = U.reviewer) => post(factsUrl(rid), user, { ...fact('ventilator_use', 'no'), confirms: factId, ...over });
      expect((await confirm()).json().error).toBe('evidence_not_viewed');
      await open(rid, docId, factId, U.admin);
      expect((await confirm()).json().error).toBe('evidence_not_viewed'); // someone else opening it does not count
      await open(rid, docId, factId);
      expect((await confirm({ value: { type: 'tri_state', value: 'yes' } })).json().error).toBe('fact_changed');
      const done = await confirm();
      expect(done.statusCode).toBe(201);
      const now = done.json().facts.find((f: { key: string }) => f.key === 'ventilator_use');
      expect([now.source, now.single_source]).toEqual(['user', true]);
      await asOwner(FAC.a);
      expect((await c.query("SELECT event FROM product_events WHERE referral_id = $1 AND event LIKE 'fact.%'", [rid])).rows).toEqual([{ event: 'fact.confirmed' }]);
      await c.query("SELECT set_config('app.facility_id', '', true)");
      expect((await confirm()).json().error).toBe('fact_changed'); // the reading is no longer the current fact
    });

    it('a Confirm from a stale screen cannot clear a disagreement', async () => {
      const { rid, docId, factId } = await withReading(53);
      await open(rid, docId, factId);
      await asOwner(FAC.a);
      await c.query(`INSERT INTO facts (facility_id, referral_id, key, value, source, is_critical, supersedes, created_by) VALUES ($1, $2, 'ventilator_use', $3, 'ai', true, $4, 'worker:zz')`, [FAC.a, rid, { type: 'tri_state', value: 'unknown' }, factId]);
      await c.query("SELECT set_config('app.facility_id', '', true)");
      expect((await post(factsUrl(rid), U.reviewer, { ...fact('ventilator_use', 'no'), confirms: factId })).json().error).toBe('fact_changed');
    });

    it('typing the same value with a note of your own is a correction, not a confirmation', async () => {
      const { rid } = await withReading(54);
      await post(factsUrl(rid), U.reviewer, fact('ventilator_use', 'no'));
      await asOwner(FAC.a);
      expect((await c.query("SELECT event FROM product_events WHERE referral_id = $1 AND event LIKE 'fact.%'", [rid])).rows).toEqual([{ event: 'fact.corrected' }]);
      await c.query("SELECT set_config('app.facility_id', '', true)");
    });

    it('upload: a checked document is recorded, offered for processing, and submitted (T1)', async () => {
      const rid = await newReferral();
      expect((await post(`${refUrl(rid)}/documents/uploads`, U.reviewer, { sha256: sha(PDF(1)), bytes: 10 })).json()).toEqual({ error: 'storage_unavailable' });
      const res = await upload(rid, PDF(1));
      expect(res.statusCode).toBe(201);
      let view = res.json();
      expect([view.referral.status, view.documents.map((d: { type: string; status: string }) => [d.type, d.status]), view.actions])
        .toEqual(['draft', [['face_sheet', 'uploaded']], ['process', 'upload']]);
      expect(JSON.stringify(view)).not.toContain('documents/'); // no storage key in a response
      expect((await post(`${refUrl(rid)}/documents/uploads`, U.reviewer, { sha256: sha(PDF(1)), bytes: PDF(1).length }, docApp)).json()).toEqual({ error: 'document_duplicate' });
      // the checked bytes left quarantine and sit at their content address, typed from the check, as an attachment
      const head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: `documents/${FAC.a}/${rid}/${sha(PDF(1))}` }));
      expect([head.ContentType, head.ContentDisposition]).toEqual(['application/pdf', 'attachment']);
      await expect(s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: `quarantine/${FAC.a}/${rid}/${sha(PDF(1))}` }))).rejects.toMatchObject({ name: 'NotFound' });
      view = (await move(rid, U.reviewer, { action: 'process' })).json();
      expect([view.referral.status, view.actions]).toEqual(['processing', []]);
      expect((await upload(rid, PDF(2))).json()).toEqual({ error: 'referral_not_open' }); // the pipeline owns it now
      await asOwner(FAC.a);
      const doc = view.documents[0].id as string;
      expect((await c.query("SELECT action FROM audit_log WHERE entity_id = $1 OR (entity_id = $2 AND action LIKE 'referral.sub%') ORDER BY seq", [doc, rid])).rows.map((r) => r.action))
        .toEqual(['document.uploaded', 'referral.submitted_for_processing']);
      expect((await c.query("SELECT attrs FROM product_events WHERE referral_id = $1 AND event = 'referral.uploaded'", [rid])).rows[0].attrs)
        .toEqual({ document_id: doc, bytes: PDF(1).length });
    });

    it('upload: refused when the bytes are not a PDF or image, do not match the declared hash, are missing, or too large; Viewers cannot upload', async () => {
      const rid = await newReferral();
      const html = Buffer.from('<html>ZZTEST</html>');
      expect((await upload(rid, html)).json()).toEqual({ error: 'document_rejected' });
      // the rejected object was removed from quarantine
      expect((await post(`${refUrl(rid)}/documents`, U.reviewer, { sha256: sha(html), type: 'face_sheet' }, docApp)).json()).toEqual({ error: 'upload_missing' });
      // declared one hash, uploaded other bytes under it
      const link = (await post(`${refUrl(rid)}/documents/uploads`, U.reviewer, { sha256: sha(PDF(3)), bytes: PDF(3).length }, docApp)).json();
      await fetch(link.url, { method: 'PUT', body: PDF(4) });
      expect((await post(`${refUrl(rid)}/documents`, U.reviewer, { sha256: sha(PDF(3)), type: 'face_sheet' }, docApp)).json()).toEqual({ error: 'document_rejected' });
      for (const bad of [{ sha256: 'x', bytes: 10 }, { sha256: sha(PDF(5)), bytes: 0 }, { sha256: sha(PDF(5)), bytes: 25 * 1024 * 1024 + 1 }]) {
        expect((await post(`${refUrl(rid)}/documents/uploads`, U.reviewer, bad, docApp)).json(), JSON.stringify(bad)).toEqual({ error: 'invalid_document' });
      }
      expect((await post(`${refUrl(rid)}/documents`, U.reviewer, { sha256: sha(PDF(5)), type: 'not_a_type' }, docApp)).json()).toEqual({ error: 'invalid_document' });
      expect((await upload(rid, PDF(5), {}, U.viewer)).statusCode).toBe(403);
      // a Viewer cannot complete a Reviewer's upload either
      const link10 = (await post(`${refUrl(rid)}/documents/uploads`, U.reviewer, { sha256: sha(PDF(10)), bytes: PDF(10).length }, docApp)).json();
      await fetch(link10.url, { method: 'PUT', body: PDF(10) });
      expect((await post(`${refUrl(rid)}/documents`, U.viewer, { sha256: sha(PDF(10)) }, docApp)).statusCode).toBe(403);
      expect((await get(refUrl(rid), U.reviewer)).json().documents).toEqual([]);
    });

    it('upload: a failed document is replaced (T4) or marked not applicable with a reason (T5, re-evaluated)', async () => {
      const rid = await newReferral();
      await upload(rid, PDF(6));
      await move(rid, U.reviewer, { action: 'process' });
      await asPipeline(rid, 'failed', 'partial_failure');
      let view = (await get(refUrl(rid), U.reviewer)).json();
      expect(view.actions).toEqual(['upload', 'resolve_failures']);
      const failed = view.documents[0].id as string;
      expect((await upload(rid, PDF(7))).json()).toEqual({ error: 'replace_required' });
      view = (await upload(rid, PDF(8), { replaces: failed })).json();
      expect([view.referral.status, view.documents.map((d: { status: string; not_applicable_reason: string | null }) => [d.status, d.not_applicable_reason]).sort()])
        .toEqual(['processing', [['not_applicable', 'Replaced by a new upload'], ['uploaded', null]]]);
      // the replacement fails too: this time staff mark it not applicable
      await asPipeline(rid, 'failed', 'partial_failure');
      const second = view.documents.find((d: { status: string }) => d.status === 'uploaded').id as string;
      const resolve = (body: unknown) => post(`${refUrl(rid)}/documents/resolve`, U.reviewer, body);
      expect((await resolve({ documents: [{ id: second, reason: ' ' }] })).json()).toEqual({ error: 'invalid_document' });
      expect((await resolve({ documents: [] })).json()).toEqual({ error: 'resolve_all_failed' });
      view = (await resolve({ documents: [{ id: second, reason: 'SYNTHETIC: duplicate fax page' }] })).json();
      expect([view.referral.status, view.documents.every((d: { status: string }) => d.status === 'not_applicable'), view.evaluation !== null]).toEqual(['ready_for_review', true, true]);
      expect(view.transitions.map((t: { transition: string }) => t.transition)).toEqual(['T1', 'T4', 'T5']);
    });

    it('upload: a replace must name a failed document; at most 20 documents; upload calls are rate limited', async () => {
      const rid = await newReferral();
      await upload(rid, PDF(13));
      await upload(rid, PDF(14));
      await move(rid, U.reviewer, { action: 'process' });
      // one document fails, the other is processed
      await asOwner(FAC.a);
      const ids2 = (await c.query('SELECT id FROM documents WHERE referral_id = $1 ORDER BY created_at', [rid])).rows.map((r) => r.id as string);
      await c.query("UPDATE documents SET status = 'failed' WHERE id = $1", [ids2[0]]);
      await c.query("UPDATE documents SET status = 'processed' WHERE id = $1", [ids2[1]]);
      await c.query("UPDATE referrals SET status = 'partial_failure' WHERE id = $1", [rid]);
      expect((await upload(rid, PDF(15), { replaces: ids2[1] })).json()).toEqual({ error: 'replace_not_failed' });
      expect((await get(refUrl(rid), U.reviewer)).json().documents.find((d: { id: string }) => d.id === ids2[1]).status).toBe('processed');
      // the 21st document is refused before any upload link is issued
      const full = await newReferral();
      await asOwner(FAC.a);
      for (let i = 0; i < 20; i += 1) {
        await c.query(`INSERT INTO documents (facility_id, referral_id, type, sha256, storage_key) VALUES ($1::uuid, $2::uuid, 'other', sha256(convert_to($3::text, 'UTF8')),
          'documents/' || $1::uuid::text || '/' || $2::uuid::text || '/' || encode(sha256(convert_to($3::text, 'UTF8')), 'hex'))`, [FAC.a, full, `zz-${i}`]);
      }
      await c.query("SELECT set_config('app.facility_id', '', true)");
      expect((await post(`${refUrl(full)}/documents/uploads`, U.reviewer, { sha256: sha(PDF(16)), bytes: PDF(16).length }, docApp)).json()).toEqual({ error: 'document_limit' });
      // 30 upload calls a minute per user, on a fresh server so earlier tests do not count
      const limited = buildServer({ tx, auth: 'local-stub', env: 'test', storage: s3Storage(BUCKET) });
      const ask = () => post(`${refUrl(rid)}/documents/uploads`, U.admin, { sha256: sha(PDF(17)), bytes: PDF(17).length }, limited);
      for (let i = 0; i < 30; i += 1) expect((await ask()).statusCode).not.toBe(429);
      expect((await ask()).json()).toEqual({ error: 'rate_limited' });
    });

    it('upload: adding a document to a referral in review sends it back to processing (T6)', async () => {
      const { rid } = await withFacts(['daily_skilled_need', 'yes']);
      await move(rid, U.reviewer, { action: 'submit' });
      const view = (await upload(rid, PDF(9))).json();
      expect([view.referral.status, view.transitions.map((t: { transition: string }) => t.transition)]).toEqual(['processing', ['T14', 'T6']]);
    });
  });

  it('queue: a facility\'s referrals by status, with codes and counts only, paged without skipping ties, audited', async () => {
    const QF = '00000000-0000-4000-8000-00000000fc13';
    await c.query("SELECT set_config('app.organization_id', $1, true), set_config('app.facility_id', $2, true)", [ORG.a, QF]);
    await c.query('INSERT INTO facilities (facility_id, organization_id, name) VALUES ($1, $2, $3)', [QF, ORG.a, 'ZZTEST API Facility queue']);
    for (const [u, role] of [[U.reviewer, 'admissions_reviewer'], [U.admin, 'facility_admin'], [U.viewer, 'viewer']]) {
      await c.query('INSERT INTO user_facility_roles (user_id, facility_id, role) VALUES ($1, $2, $3)', [u, QF, role]);
    }
    await c.query("INSERT INTO facility_profiles (facility_id, version, capabilities, created_by) VALUES ($1, 0, $2, 'platform:test')", [QF, SEED_CAPS]);
    await c.query("SELECT set_config('app.facility_id', '', true), set_config('app.organization_id', '', true)");
    const base = `/api/facilities/${QF}/referrals`;
    let reads = 0; // successful list reads, each audited
    const list = async (query = '', user = U.reviewer) => { const r = await get(`${base}${query}`, user); if (r.statusCode === 200 && user === U.reviewer) reads += 1; return r; };
    const owner = async (sql: string, params: unknown[]) => {
      await c.query("SELECT set_config('app.facility_id', $1, true)", [QF]);
      await c.query(sql, params);
      await c.query("SELECT set_config('app.facility_id', '', true)");
    };
    const mk = async () => (await post(base, U.reviewer)).json().referral.id as string;
    const factIn = (rid: string, k: string, v: 'yes' | 'no' | 'unknown') => post(`${base}/${rid}/facts`, U.reviewer, fact(k, v));

    expect((await list('', U.viewer)).statusCode).toBe(403);
    expect((await list('', U.other)).statusCode).toBe(404);
    const someId = '00000000-0000-4000-8000-0000000000aa';
    for (const bad of ['?filter=everything', '?filter=__proto__', '?filter=constructor', '?after=garbage', `?after=2026-10-30|not-a-uuid`,
      `?after=1|${someId}`, `?after=${encodeURIComponent(`2026-02-30 10:00:00+00|${someId}`)}`, `?after=${encodeURIComponent(`2026-10-30 10:00:00+00|${someId}|x`)}`]) {
      expect((await list(bad)).json(), bad).toEqual({ error: 'invalid_query' });
    }

    const draft = await mk();
    const ready = await mk();
    for (const [k, v] of [['ventilator_use', 'no'], ['recent_aggression', 'no'], ['daily_skilled_need', 'yes']] as const) await factIn(ready, k, v);
    await post(`${base}/${ready}/transitions`, U.reviewer, { action: 'submit' });
    const done = await mk();
    for (const [k, v] of [['ventilator_use', 'no'], ['recent_aggression', 'no'], ['daily_skilled_need', 'yes']] as const) await factIn(done, k, v);
    const doneEv = (await post(`${base}/${done}/transitions`, U.reviewer, { action: 'submit' })).json().evaluation.id;
    await post(`${base}/${done}/decision`, U.reviewer, { evaluation_id: doneEv, decision: 'admit' });
    // a hard stop the Reviewer filed for co-sign
    const filed = await mk();
    for (const [k, v] of [['ventilator_use', 'yes'], ['recent_aggression', 'no'], ['daily_skilled_need', 'yes']] as const) await factIn(filed, k, v);
    const filedEv = (await post(`${base}/${filed}/transitions`, U.reviewer, { action: 'submit' })).json().evaluation.id;
    await post(`${base}/${filed}/decision-requests`, U.reviewer, { evaluation_id: filedEv, decision: 'admit', override_reason: 'SYNTHETIC: queue' });
    // one in processing with a failed document (the pipeline's part done as the owner)
    const proc = await mk();
    await c.query("SELECT set_config('app.facility_id', $1, true)", [QF]);
    await c.query(`INSERT INTO documents (facility_id, referral_id, type, status, sha256, storage_key) VALUES ($1::uuid, $2::uuid, 'other', 'failed', sha256('zzq'::bytea),
      'documents/' || $1::uuid::text || '/' || $2::uuid::text || '/' || encode(sha256('zzq'::bytea), 'hex'))`, [QF, proc]);
    await c.query("UPDATE referrals SET status = 'processing' WHERE id = $1", [proc]);
    await c.query("SELECT set_config('app.facility_id', '', true)");

    const open = (await list()).json();
    expect(open.filter).toBe('open');
    // (every row here shares the test's one transaction, so one updated_at: order falls to the id tie-breaker)
    expect(open.referrals.map((r: { id: string }) => r.id)).toEqual([draft, ready, filed].sort());
    const row = (id: string, rows: Record<string, unknown>[]) => rows.find((r) => r['id'] === id)!;
    expect([row(draft, open.referrals)['outcome'], row(ready, open.referrals)['outcome'], row(filed, open.referrals)['outcome']]).toEqual([null, 'admit', 'do_not_admit']);
    expect([row(ready, open.referrals)['cosign_waiting'], row(filed, open.referrals)['cosign_waiting']]).toEqual([false, true]);
    expect(Object.keys(row(ready, open.referrals)).sort()).toEqual(['cosign_waiting', 'created_at', 'documents', 'failed_documents', 'id', 'outcome', 'raw', 'referral_type', 'status', 'sub_reasons', 'updated_at']);
    expect(JSON.stringify(open)).not.toContain('SYNTHETIC'); // no notes, reasons or fact values in a list
    const processing = (await list('?filter=processing')).json().referrals;
    expect([processing.length, processing[0].id, processing[0].documents, processing[0].failed_documents]).toEqual([1, proc, 1, 1]);
    expect((await list('?filter=closed')).json().referrals.map((r: { id: string }) => r.id)).toEqual([done]);

    // real ordering, with distinct times: open work longest waiting first
    await owner("UPDATE referrals SET updated_at = now() - interval '2 hours' WHERE id = $1", [ready]);
    await owner("UPDATE referrals SET updated_at = now() - interval '1 hour' WHERE id = $1", [draft]);
    expect((await list()).json().referrals.map((r: { id: string }) => r.id)).toEqual([ready, draft, filed]);
    // a document failure needs staff (open, not processing); an amended referral is decided; counts leave out
    // not-applicable documents and count everything else, failed and unreadable as failures
    await owner("UPDATE referrals SET status = 'partial_failure' WHERE id = $1", [proc]);
    for (const [st, tag] of [['not_applicable', 'na'], ['unreadable', 'un'], ['uploaded', 'up']] as const) {
      await owner(`INSERT INTO documents (facility_id, referral_id, type, status, not_applicable_reason, sha256, storage_key) VALUES ($1::uuid, $2::uuid, 'other', $3::document_status, $4,
        sha256(convert_to($5::text, 'UTF8')), 'documents/' || $1::uuid::text || '/' || $2::uuid::text || '/' || encode(sha256(convert_to($5::text, 'UTF8')), 'hex'))`,
        [QF, proc, st, st === 'not_applicable' ? 'SYNTHETIC' : null, `zzq-${tag}`]);
    }
    await owner("UPDATE referrals SET status = 'amended' WHERE id = $1", [done]);
    const open2 = (await list()).json().referrals;
    expect([row(proc, open2)['documents'], row(proc, open2)['failed_documents']]).toEqual([3, 2]);
    expect((await list('?filter=processing')).json().referrals).toEqual([]);
    expect((await list('?filter=closed')).json().referrals.map((r: { id: string }) => r.id)).toEqual([done]);
    // the co-sign flag clears once the filed decision is carried out, or once a newer recommendation replaces it
    const req = (await get(`${base}/${filed}`, U.admin)).json().pending_request.id as string;
    await post(`${base}/${filed}/decision-requests/${req}/cosign`, U.admin);
    expect(row(filed, (await list('?filter=closed')).json().referrals)['cosign_waiting']).toBe(false);
    const filed2 = await mk();
    for (const [k, v] of [['ventilator_use', 'yes'], ['recent_aggression', 'no'], ['daily_skilled_need', 'yes']] as const) await factIn(filed2, k, v);
    const ev2 = (await post(`${base}/${filed2}/transitions`, U.reviewer, { action: 'submit' })).json().evaluation.id;
    await post(`${base}/${filed2}/decision-requests`, U.reviewer, { evaluation_id: ev2, decision: 'admit', override_reason: 'SYNTHETIC: queue' });
    expect(row(filed2, (await list()).json().referrals)['cosign_waiting']).toBe(true);
    await factIn(filed2, 'recent_aggression', 'no'); // a new evaluation
    expect(row(filed2, (await list()).json().referrals)['cosign_waiting']).toBe(false);
    // decided referrals page newest first, across distinct times and ties, every referral once
    await owner(`INSERT INTO referrals (facility_id, status, updated_at) SELECT $1, 'finalized', now() - (n % 3) * interval '1 minute' FROM generate_series(1, 101) n`, [QF]);
    const c1 = (await list('?filter=closed')).json();
    const c2 = (await list(`?filter=closed&after=${encodeURIComponent(c1.next)}`)).json();
    const closedRows = [...c1.referrals, ...c2.referrals] as { id: string; updated_at: string }[];
    expect([c1.referrals.length, c2.next, closedRows.length, new Set(closedRows.map((r) => r.id)).size]).toEqual([100, null, 103, 103]);
    expect(closedRows.every((r, i) => i === 0 || Date.parse(closedRows[i - 1]!.updated_at) >= Date.parse(r.updated_at))).toBe(true);

    // 101 more drafts written in one transaction share one updated_at: two pages, every referral exactly once
    await c.query("SELECT set_config('app.facility_id', $1, true)", [QF]);
    await c.query('INSERT INTO referrals (facility_id) SELECT $1 FROM generate_series(1, 101)', [QF]);
    await c.query("SELECT set_config('app.facility_id', '', true)");
    const p1 = (await list()).json();
    expect([p1.referrals.length, typeof p1.next]).toEqual([100, 'string']);
    const p2 = (await list(`?after=${encodeURIComponent(p1.next)}`)).json();
    expect([p2.referrals.length, p2.next]).toEqual([5, null]);
    const seen = [...p1.referrals, ...p2.referrals].map((r: { id: string }) => r.id);
    expect([seen.length, new Set(seen).size]).toEqual([105, 105]); // draft, ready, proc, filed2 and the 101

    await asOwner(QF);
    expect(await count("SELECT count(*) AS n FROM audit_log WHERE facility_id = $1 AND action = 'referrals.listed' AND actor = $2", [QF, `user:${U.reviewer}`])).toBe(reads); // every successful read; refused queries read nothing
  });

  it('review time: one start per open review, one end per start, never more time than has passed, nothing for refused callers', async () => {
    const rid = await newReferral();
    const time = (user: string, body: unknown, id = rid, fac = FAC.a) => post(`/api/facilities/${fac}/referrals/${id}/review-time`, user, body);
    // nothing is open yet: an end without a start is refused
    expect((await time(U.reviewer, { active_ms: 1000 })).json()).toEqual({ error: 'no_review_open' });
    // refused readers start nothing
    expect((await get(refUrl(rid), U.viewer)).statusCode).toBe(403);
    expect((await get(refUrl(rid), U.other)).statusCode).toBe(404);
    await get(refUrl(rid), U.reviewer);
    await get(refUrl(rid), U.reviewer); // reopening adds no second start
    for (const bad of [{}, { active_ms: 0 }, { active_ms: -5 }, { active_ms: 1.5 }, { active_ms: '42000' }, { active_ms: 8 * 3600 * 1000 + 1 }]) {
      expect((await time(U.reviewer, bad)).json(), JSON.stringify(bad)).toEqual({ error: 'invalid_review_time' });
    }
    expect((await time(U.viewer, { active_ms: 1000 })).statusCode).toBe(403);
    expect((await time(U.other, { active_ms: 1000 })).statusCode).toBe(404);
    // another facility's real referral, through this facility's URL
    const foreign = (await post(`/api/facilities/${FAC.b}/referrals`, U.other)).json().referral.id as string;
    expect((await time(U.reviewer, { active_ms: 1000 }, foreign)).statusCode).toBe(404);
    // 42 seconds claimed a few milliseconds after the start: stored as at most the time that has passed
    expect((await time(U.reviewer, { active_ms: 42_000 })).statusCode).toBe(204);
    expect((await time(U.reviewer, { active_ms: 1000 })).json()).toEqual({ error: 'no_review_open' }); // one end per start
    await asOwner(FAC.a);
    const ev = (await c.query("SELECT event, actor, attrs FROM product_events WHERE referral_id = $1 AND event LIKE 'review.%' ORDER BY at", [rid])).rows;
    expect(ev.map((e) => [e.event, e.actor])).toEqual([['review.started', `user:${U.reviewer}`], ['review.ended', `user:${U.reviewer}`]]);
    expect(ev[1].attrs.screen).toBe('review');
    expect(ev[1].attrs.active_ms).toBeGreaterThanOrEqual(1);
    expect(ev[1].attrs.active_ms).toBeLessThan(42_000);
  });

  it('review: hold, request information, escalate and resume move only from the states §5.1 allows, each with its fields', async () => {
    const { rid } = await withFacts(['daily_skilled_need', 'yes']);
    await move(rid, U.reviewer, { action: 'submit' });
    for (const bad of [{ action: 'hold' }, { action: 'hold', note: ' ' }, { action: 'fly', note: NOTE }, { action: 'escalate', note: NOTE }, { action: 'escalate', note: NOTE, department: 'the_ceo' },
      { action: 'request_info' }, { action: 'request_info', items: ['Call the hospital'] }, { action: 'request_info', items: ['no_such_key'] }, { action: 'hold', note: 'x'.repeat(501) }]) {
      expect((await move(rid, U.reviewer, bad)).json(), JSON.stringify(bad)).toEqual({ error: 'invalid_transition' });
    }
    expect((await move(rid, U.viewer, { action: 'hold', note: NOTE })).statusCode).toBe(403);
    let view = (await move(rid, U.reviewer, { action: 'hold', note: NOTE })).json();
    expect([view.referral.status, view.actions]).toEqual(['on_hold', ['resume', 'upload']]);
    expect((await move(rid, U.reviewer, { action: 'escalate', note: NOTE, department: 'therapy' })).json()).toEqual({ error: 'transition_not_allowed' });
    // facts may still be entered while held (T7), and the status does not move
    expect((await post(factsUrl(rid), U.reviewer, fact('ventilator_use', 'no'))).json().referral.status).toBe('on_hold');
    await move(rid, U.reviewer, { action: 'resume', note: NOTE });
    view = (await move(rid, U.reviewer, { action: 'request_info', items: ['recent_aggression', 'recent_aggression'], note: 'SYNTHETIC: asked the liaison' })).json();
    expect(view.transitions.at(-1)).toMatchObject({ transition: 'T9', requested_items: ['recent_aggression'], note: 'SYNTHETIC: asked the liaison' });
    expect((await finalize(rid, U.reviewer, { evaluation_id: view.evaluation.id, decision: 'do_not_admit', override_reason: 'SYNTHETIC' })).json()).toEqual({ error: 'transition_not_allowed' });
    await move(rid, U.reviewer, { action: 'resume', note: NOTE });
    view = (await move(rid, U.admin, { action: 'escalate', note: NOTE, department: 'director_of_nursing' })).json();
    expect([view.referral.status, view.transitions.map((t: { transition: string }) => t.transition)]).toEqual(['escalated', ['T14', 'T8', 'T11', 'T9', 'T11', 'T10']]);
    await asOwner(FAC.a);
    const events = (await c.query("SELECT event, attrs FROM product_events WHERE referral_id = $1 AND event IN ('referral.held', 'referral.info_requested', 'referral.escalated') ORDER BY at", [rid])).rows;
    expect(events).toEqual([{ event: 'referral.held', attrs: {} }, { event: 'referral.info_requested', attrs: { items_requested: 1 } }, { event: 'referral.escalated', attrs: { department: 'director_of_nursing' } }]);
    expect((await c.query("SELECT attrs FROM product_events WHERE referral_id = $1 AND event = 'review.started' LIMIT 1", [rid])).rows[0].attrs).toEqual({ screen: 'review' });
    const audited = (await c.query("SELECT action FROM audit_log WHERE entity_id = $1 AND action LIKE 'referral.%' AND action <> 'referral.viewed' ORDER BY seq", [rid])).rows.map((r) => r.action);
    expect(audited).toEqual(['referral.created', 'referral.submitted_for_review', 'referral.held', 'referral.resumed', 'referral.info_requested', 'referral.resumed', 'referral.escalated']);
  });

  it('review: a decision on the same referral after a newer evaluation, or after a settings change, waits for a fresh evaluation', async () => {
    const { rid, ev } = await withFacts(['ventilator_use', 'no'], ['recent_aggression', 'no'], ['daily_skilled_need', 'yes']);
    await move(rid, U.reviewer, { action: 'submit' });
    const newer = (await post(factsUrl(rid), U.reviewer, fact('recent_aggression', 'no'))).json().evaluation.id;
    expect((await finalize(rid, U.reviewer, { evaluation_id: ev.id, decision: 'admit' })).json()).toEqual({ error: 'evaluation_stale' });
    // the Admin saves the profile again: same content, a new version, so the evaluation is outdated
    const path = `/api/facilities/${FAC.a}/settings`;
    const cur = (await get(path, U.admin)).json();
    await app.inject({ method: 'PUT', url: path, headers: as(U.admin), payload: { capabilities: cur.profile.capabilities, disabled_rules: cur.profile.disabled_rules, based_on_version: cur.profile.version } });
    let view = (await get(refUrl(rid), U.reviewer)).json();
    expect([view.evaluation_outdated, view.actions]).toEqual([true, ['hold', 'request_info', 'escalate', 'upload', 'reevaluate']]);
    expect((await finalize(rid, U.reviewer, { evaluation_id: newer, decision: 'admit' })).json()).toEqual({ error: 'evaluation_stale' });
    expect((await post(`${refUrl(rid)}/evaluate`, U.viewer)).statusCode).toBe(403);
    view = (await post(`${refUrl(rid)}/evaluate`, U.reviewer)).json();
    expect([view.evaluation_outdated, view.evaluation.facility_profile_version]).toEqual([false, cur.profile.version + 1]);
    expect((await post(`${refUrl(rid)}/evaluate`, U.reviewer)).json()).toEqual({ error: 'evaluation_current' });
    expect((await finalize(rid, U.reviewer, { evaluation_id: view.evaluation.id, decision: 'admit' })).statusCode).toBe(201);
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

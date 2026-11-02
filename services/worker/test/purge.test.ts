// The deletion job against the real database and LocalStack, with versioned files. Skips without them; fails where
// REQUIRE_DATABASE is set. Fresh ids each run: audit rows and decisions can never be cleaned up.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { CreateBucketCommand, DeleteObjectCommand, ListObjectVersionsCommand, PutBucketVersioningCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import pg from 'pg';
import { parseArgs, purge } from '../src/purge.ts';
import { poolTx } from '../src/db.ts';

const url = process.env['DATABASE_URL'];
if (!url && process.env['REQUIRE_DATABASE']) throw new Error('DATABASE_URL must be set here: the purge suite may not be skipped in the db-checks job');
const endpoint = process.env['AWS_ENDPOINT_URL']; // localstack only; unset in AWS
const live = Boolean(url && endpoint);

const PAST = new Date('2026-06-01T00:00:00Z');
const OLD = '2026-01-01T00:00:00Z';
const BUCKET = `zztest-purge-${randomUUID()}`;
const S = 'SYNTHETIC ZZTEST note';
const USER = `user:${randomUUID()}`;

test('arguments: a facility, a past date, and a preview unless told otherwise', () => {
  const now = new Date('2026-11-02T00:00:00Z');
  const facility = randomUUID();
  assert.deepEqual(parseArgs(['--facility', facility, '--before', '2026-06-01'], now), { facility, before: PAST, apply: false, local: false });
  assert.equal(parseArgs(['--facility', facility, '--before', '2026-06-01', '--apply'], now).apply, true);
  for (const bad of [['--before', '2026-06-01'], ['--facility', 'x', '--before', '2026-06-01'], ['--facility', facility], ['--facility', facility, '--before', '2027-01-01'], ['--facility', facility, '--before', 'soon'], ['--facility', facility, '--before', '2026-13-45']]) {
    assert.throws(() => parseArgs(bad, now), /must be/);
  }
});

test('the purge', { skip: !live }, async (t) => {
  const pool = new pg.Pool({ connectionString: url, max: 3 });
  t.after(() => pool.end());
  const tx = poolTx(url!);
  const s3 = new S3Client({ region: 'us-east-1', forcePathStyle: true });
  const send = ((c: never) => s3.send(c)) as unknown as Parameters<typeof purge>[1];
  await send(new CreateBucketCommand({ Bucket: BUCKET }));
  await send(new PutBucketVersioningCommand({ Bucket: BUCKET, VersioningConfiguration: { Status: 'Enabled' } }));

  const org = randomUUID();
  const facs = [randomUUID(), randomUUID()] as const;
  const owner = async <T>(facility: string, fn: (c: pg.PoolClient) => Promise<T>) => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.facility_id', $1, true), set_config('app.organization_id', $2, true)", [facility, org]);
      const r = await fn(c);
      await c.query('COMMIT');
      return r;
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  };
  await owner(facs[0], async (c) => { await c.query("INSERT INTO organizations (id, name) VALUES ($1, 'ZZTEST Purge Org')", [org]); });
  for (const f of facs) await owner(f, async (c) => { await c.query("INSERT INTO facilities (facility_id, organization_id, name) VALUES ($1, $2, 'ZZTEST Purge Facility')", [f, org]); });

  const keys = (f: string, r: string) => [`documents/${f}/${r}/aa`, `documents/${f}/${r}/pages/aa/1.png`, `quarantine/${f}/${r}/aa`];
  const seed = (facility: string, status: string, updated = OLD) => owner(facility, async (c) => {
    const id = (await c.query("INSERT INTO referrals (facility_id, status) VALUES ($1, 'ready_for_review') RETURNING id", [facility])).rows[0].id as string;
    await c.query(`INSERT INTO documents (facility_id, referral_id, type, sha256, storage_key) VALUES ($1::uuid, $2::uuid, 'other', sha256('x'::bytea), 'documents/' || $1::text || '/' || $2::text || '/' || encode(sha256('x'::bytea), 'hex'))`, [facility, id]);
    const fact = (await c.query(`INSERT INTO facts (facility_id, referral_id, key, value, source, note, created_by) VALUES ($1, $2, 'ventilator_use', '{"type":"tri_state","value":"yes"}', 'user', $3, $4) RETURNING id`, [facility, id, S, USER])).rows[0].id as string;
    await c.query(`INSERT INTO facts (facility_id, referral_id, key, value, source, note, created_by, supersedes) VALUES ($1, $2, 'ventilator_use', '{"type":"tri_state","value":"no"}', 'user', $3, $4, $5)`, [facility, id, S, USER, fact]);
    await c.query(`INSERT INTO product_events (facility_id, referral_id, actor, event, attrs) VALUES ($1, $2, $3, 'referral.held', '{}')`, [facility, id, USER]);
    await c.query(`INSERT INTO referral_transitions (facility_id, referral_id, transition, from_status, to_status, note, created_by) VALUES ($1, $2, 'T8', 'ready_for_review', 'on_hold', $3, $4)`, [facility, id, S, USER]);
    await c.query(`INSERT INTO evaluations (facility_id, referral_id, raw, outcome, clinical_outcome, financial_status, sub_reasons, trace, criteria_document_ref, rule_set_version, facility_profile_version, model_id, prompt_version, extractor_version, ocr_engine_version, engine_version)
      VALUES ($1, $2, false, 'admit', 'admit', 'clear', '{}', '{"triggered_rules":[]}', 'seed', 1, 1, 'none', 'p0', 'x0', 'o0', 'e0')`, [facility, id]);
    await c.query('UPDATE referrals SET status = $3, updated_at = $4 WHERE facility_id = $1 AND id = $2', [facility, id, status, updated]);
    for (const Key of keys(facility, id)) {
      await send(new PutObjectCommand({ Bucket: BUCKET, Key, Body: 'one' }));
      await send(new PutObjectCommand({ Bucket: BUCKET, Key, Body: 'two' }));
    }
    await send(new DeleteObjectCommand({ Bucket: BUCKET, Key: keys(facility, id)[0]! })); // a delete marker over old versions
    return id;
  });
  const counts = (facility: string, id: string) => owner(facility, async (c) => {
    const n = async (sql: string) => Number((await c.query(sql, [facility, id])).rows[0].n);
    return {
      facts: await n('SELECT count(*) n FROM facts WHERE facility_id = $1 AND referral_id = $2'),
      documents: await n('SELECT count(*) n FROM documents WHERE facility_id = $1 AND referral_id = $2'),
      events: await n('SELECT count(*) n FROM product_events WHERE facility_id = $1 AND referral_id = $2'),
      notes: await n('SELECT count(*) n FROM referral_transitions WHERE facility_id = $1 AND referral_id = $2 AND note IS NOT NULL'),
      evaluations: await n('SELECT count(*) n FROM evaluations WHERE facility_id = $1 AND referral_id = $2'),
      audits: await n("SELECT count(*) n FROM audit_log WHERE facility_id = $1 AND entity_id = $2 AND action = 'referral.purged'"),
      purged: await n('SELECT count(*) n FROM referrals WHERE facility_id = $1 AND id = $2 AND purged_at IS NOT NULL'),
    };
  });
  const files = async (f: string, r: string) => {
    let n = 0;
    for (const root of ['documents', 'quarantine']) {
      const l = await send(new ListObjectVersionsCommand({ Bucket: BUCKET, Prefix: `${root}/${f}/${r}/` }));
      n += ((l['Versions'] as unknown[]) ?? []).length + ((l['DeleteMarkers'] as unknown[]) ?? []).length;
    }
    return n;
  };
  const whole = { facts: 2, documents: 1, events: 1, notes: 1, evaluations: 1, audits: 0, purged: 0 };

  const due = await seed(facs[0], 'finalized');
  const amended = await seed(facs[0], 'amended');
  const open = await seed(facs[0], 'ready_for_review');
  const recent = await seed(facs[0], 'finalized', '2026-10-30T00:00:00Z');
  const foreign = await seed(facs[1], 'finalized');
  const fileCount = await files(facs[0], due);
  assert.equal(fileCount, 7, 'six versions and a delete marker');

  await t.test('a preview counts and changes nothing', async () => {
    assert.deepEqual(await purge(tx, send, BUCKET, facs[0], PAST, false), { due: 2, purged: 0, files: 0 });
    assert.deepEqual(await counts(facs[0], due), whole);
    assert.equal(await files(facs[0], due), fileCount);
  });

  await t.test('a storage fault leaves the referral whole in the database, and the next run finishes it', async () => {
    let calls = 0;
    const failing: typeof send = async (c) => { if (c instanceof DeleteObjectCommand && ++calls > 2) throw new Error('down'); return send(c); };
    await assert.rejects(purge(tx, failing, BUCKET, facs[0], PAST, true), /down/);
    assert.deepEqual(await counts(facs[0], due), whole);
  });

  await t.test('due referrals lose their files and short-class data; the record of the decision stays', async () => {
    const r = await purge(tx, send, BUCKET, facs[0], PAST, true);
    assert.equal(r.purged, 2);
    const gone = { facts: 0, documents: 0, events: 0, notes: 1, evaluations: 1, audits: 1, purged: 1 };
    for (const id of [due, amended]) {
      assert.deepEqual(await counts(facs[0], id), gone);
      assert.equal(await files(facs[0], id), 0, 'every version and marker');
    }
  });

  await t.test('open, recent and other facilities\' referrals are untouched', async () => {
    assert.deepEqual(await counts(facs[0], open), whole);
    assert.deepEqual(await counts(facs[0], recent), whole);
    assert.deepEqual(await counts(facs[1], foreign), whole);
    for (const [f, id] of [[facs[0], open], [facs[0], recent], [facs[1], foreign]] as const) assert.equal(await files(f, id), 7);
  });

  await t.test('a second run finds nothing and writes no second audit row', async () => {
    assert.deepEqual(await purge(tx, send, BUCKET, facs[0], PAST, true), { due: 0, purged: 0, files: 0 });
    assert.equal((await counts(facs[0], due)).audits, 1);
  });

  await t.test('the audit chain still verifies after a purge', async () => {
    const broken = await owner(facs[0], async (c) => (await c.query('SELECT count(*) n FROM audit_chain_verify($1) WHERE NOT ok', [facs[0]])).rows[0].n);
    assert.equal(Number(broken), 0);
  });

  await t.test('a purged referral takes no new data, from anyone', async () => {
    const insert = (sql: string, refused = /has been purged/) => assert.rejects(owner(facs[0], (c) => c.query(sql, [facs[0], due, S, USER])), refused);
    await insert(`INSERT INTO facts (facility_id, referral_id, key, value, source, note, created_by) VALUES ($1, $2, 'ventilator_use', '{"type":"tri_state","value":"no"}', 'user', $3, $4)`);
    await insert(`INSERT INTO referral_transitions (facility_id, referral_id, transition, from_status, to_status, note, created_by) SELECT $1, $2, 'T8', 'ready_for_review', 'on_hold', $3, $4`, /purged|not ready_for_review/);
    await insert(`INSERT INTO evaluations (facility_id, referral_id, raw, outcome, clinical_outcome, financial_status, sub_reasons, trace, criteria_document_ref, rule_set_version, facility_profile_version, model_id, prompt_version, extractor_version, ocr_engine_version, engine_version)
      SELECT $1, $2, length($3) < 0, 'admit', 'admit', 'clear', '{}', '{"triggered_rules":[]}', 'seed', 1, 1, 'none', 'p0', 'x0', length($4)::text, 'e0'`);
  });

  await t.test('transition rows stay immutable, and their notes remain until counsel rules', async () => {
    await assert.rejects(owner(facs[0], (c) => c.query("UPDATE referral_transitions SET note = '[purged]' WHERE facility_id = $1 AND referral_id = $2", [facs[0], due])), /immutable/);
    await assert.rejects(owner(facs[0], (c) => c.query('DELETE FROM referral_transitions WHERE facility_id = $1 AND referral_id = $2', [facs[0], due])), /immutable/);
  });

  await t.test('nothing is purged for a facility that does not exist', async () => {
    await assert.rejects(purge(tx, send, BUCKET, randomUUID(), PAST, true), /unknown facility/);
  });
});

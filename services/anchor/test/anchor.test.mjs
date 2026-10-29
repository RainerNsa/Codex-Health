// Anchoring job and verifier against a migrated local database and LocalStack S3 (SPEC §12 "the chain before
// anchoring"; I4). Runs as codex_anchor inside one rolled-back transaction; the bucket is created per run and
// deleted at the end (LocalStack allows deletion; the real bucket denies it). Skips without DATABASE_URL and
// AWS_ENDPOINT_URL (the localstack endpoint); fails where REQUIRE_DATABASE is set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { CreateBucketCommand, DeleteBucketCommand, DeleteObjectCommand, ListObjectVersionsCommand, PutBucketVersioningCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { runAnchor, runVerify } from '../src/lib.mjs';

const url = process.env.DATABASE_URL;
const endpoint = process.env.AWS_ENDPOINT_URL; // localstack only; unset in AWS
if ((!url || !endpoint) && process.env.REQUIRE_DATABASE) throw new Error('DATABASE_URL and AWS_ENDPOINT_URL (localstack) must be set here: the anchoring suite may not be skipped in the db-checks job');

const ORG = '00000000-0000-4000-8000-00000000b001';
const FAC = { a: '00000000-0000-4000-8000-00000000fba1', b: '00000000-0000-4000-8000-00000000fbb1' };
const MINE = [FAC.a, FAC.b, ORG];
const mine = (list) => list.filter((r) => MINE.includes(r.id));
const bind = async (c, facility, org = ORG) => {
  await c.query("SELECT set_config('app.facility_id', $1, true)", [facility]);
  await c.query("SELECT set_config('app.organization_id', $1, true)", [org]);
};
const audit = (c, facility, action) =>
  c.query("INSERT INTO audit_log (facility_id, actor, action, entity_type) VALUES ($1, 'system:anchor_test', $2, 'facility')", [facility, action]);
// Versioned bucket: a plain DeleteObject only adds a delete marker, so a test undo must remove every version.
async function purgeKey(s3, bucket, key) {
  const { Versions = [], DeleteMarkers = [] } = await s3.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: key }));
  for (const v of [...Versions, ...DeleteMarkers]) if (v.Key === key) await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key, VersionId: v.VersionId }));
}
const sorted = (problems) => problems.map(({ scope, id, problem, key }) => ({ scope, id, problem, key })).sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));

test('anchoring job and verifier', { skip: !(url && endpoint) && 'DATABASE_URL or AWS_ENDPOINT_URL (localstack) not set' }, async (t) => {
  const c = new pg.Client({ connectionString: url });
  const s3 = new S3Client({ forcePathStyle: true });
  const bucket = `zztest-anchor-${Date.now().toString(36)}`;
  let bucketCreated = false;
  let connected = false;
  const sub = (name, fn) => t.test(name, async () => {
    await c.query('SAVEPOINT sub');
    try { await fn(); } finally { await c.query('ROLLBACK TO SAVEPOINT sub'); }
  });
  try {
    await c.connect();
    connected = true;
    await c.query('BEGIN');
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    bucketCreated = true;
    await s3.send(new PutBucketVersioningCommand({ Bucket: bucket, VersioningConfiguration: { Status: 'Enabled' } }));
    await bind(c, '');
    await c.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [ORG, 'ZZTEST Anchor Org']);
    for (const [k, id] of Object.entries(FAC)) {
      await bind(c, id);
      await c.query('INSERT INTO facilities (facility_id, organization_id, name) VALUES ($1, $2, $3)', [id, ORG, `ZZTEST Anchor Facility ${k}`]);
      await audit(c, id, 'referral.created');
      await audit(c, id, 'referral.submitted');
    }
    const asAnchor = async () => { await c.query('SET LOCAL ROLE codex_anchor'); await bind(c, '', ''); };
    const asOwner = async (facility) => { await c.query('RESET ROLE'); await bind(c, facility); };

    await sub('codex_anchor enumerates facility and organisation ids and can read nothing else; it writes nothing', async () => {
      await asAnchor();
      assert.ok(Number((await c.query('SELECT count(*) AS n FROM facilities')).rows[0].n) >= 2);
      assert.ok(Number((await c.query('SELECT count(*) AS n FROM organizations')).rows[0].n) >= 1);
      for (const tbl of ['audit_log', 'platform_audit_log']) assert.equal((await c.query(`SELECT count(*) AS n FROM ${tbl}`)).rows[0].n, '0', `${tbl} unbound: no rows`);
      const { rows: rels } = await c.query("SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND relkind IN ('r','p','v','m') ORDER BY 1");
      const allowed = new Set(['facilities', 'organizations', 'audit_log', 'platform_audit_log']);
      for (const { relname } of rels) {
        if (allowed.has(relname)) continue;
        await c.query('SAVEPOINT p');
        await assert.rejects(c.query(`SELECT count(*) FROM ${relname}`), /permission denied/, `${relname} must be unreadable to codex_anchor`);
        await c.query('ROLLBACK TO SAVEPOINT p');
      }
      for (const sql of ['SELECT name FROM facilities', 'SELECT * FROM organizations']) {
        await c.query('SAVEPOINT p');
        await assert.rejects(c.query(sql), /permission denied/, `${sql}: only ids are for the anchor role`);
        await c.query('ROLLBACK TO SAVEPOINT p');
      }
      for (const sql of [
        `INSERT INTO audit_log (facility_id, actor, action, entity_type) VALUES ('${FAC.a}', 'system:x', 'x', 'facility')`,
        `UPDATE audit_log SET action = 'x'`, 'DELETE FROM audit_log', `INSERT INTO facilities (facility_id, organization_id, name) VALUES ('${FAC.a}', '${ORG}', 'x')`,
        `INSERT INTO platform_audit_log (organization_id, actor, action, entity_type) VALUES ('${ORG}', 'system:x', 'x', 'organization')`,
      ]) {
        await c.query('SAVEPOINT p');
        await assert.rejects(c.query(sql), /permission denied/, `must be refused: ${sql.slice(0, 30)}`);
        await c.query('ROLLBACK TO SAVEPOINT p');
      }
    });

    await sub('anchor writes one write-once object per chain per day; a second run reports exists; verify passes', async () => {
      await asAnchor();
      const before = await runVerify({ client: c, s3, bucket });
      assert.deepEqual(sorted(mine(before.problems)), sorted(MINE.map((id) => ({ scope: id === ORG ? 'organization' : 'facility', id, problem: 'no_anchor', key: undefined }))), 'unanchored chains are reported, not ignored');
      const first = await runAnchor({ client: c, s3, bucket, date: '2001-01-01' });
      assert.deepEqual(mine(first).map((r) => r.status), ['written', 'written', 'written']);
      const seqs = mine(first).map((r) => r.seq);
      assert.deepEqual(seqs.slice(0, 2), [2, 2], 'two audit rows per facility'); // the org chain holds its provisioning rows
      assert.ok(first.every((r) => !('name' in r) && r.status !== 'broken' && r.status !== 'regressed'));
      const second = await runAnchor({ client: c, s3, bucket, date: '2001-01-01' });
      assert.deepEqual(mine(second).map((r) => [r.status, r.seq]), seqs.map((q) => ['exists', q]), 'exists reports the stored anchor seq');
      const { Versions } = await s3.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: `${FAC.a}/` }));
      assert.deepEqual(Versions.map((v) => v.Key), [`${FAC.a}/2001-01-01.json`], 'If-None-Match kept the key at one version');
      const v = await runVerify({ client: c, s3, bucket });
      assert.deepEqual(mine(v.problems), []);
      await asOwner(FAC.a);
      await audit(c, FAC.a, 'after_anchor');
      await asAnchor();
      assert.deepEqual(mine((await runVerify({ client: c, s3, bucket })).problems), [], 'appending after the anchor is fine');
      const third = await runAnchor({ client: c, s3, bucket, date: '2001-01-02' });
      assert.deepEqual(mine(third).map((r) => [r.status, r.seq]), [['written', 3], ['written', 2], ['written', seqs[2]]]);
    });

    await sub('verify pins each problem to the right chain: rewritten anchored row, truncation, deleted chain, org chain, overwritten anchor; anchor refuses a regressed chain', async () => {
      // Own ids: S3 is not rolled back between subtests, so these chains have exactly the anchors written here.
      const ORG = '00000000-0000-4000-8000-00000000b002';
      const FAC = { a: '00000000-0000-4000-8000-00000000fbc1', b: '00000000-0000-4000-8000-00000000fbd1' };
      const MINE = [FAC.a, FAC.b, ORG];
      const mine = (list) => list.filter((r) => MINE.includes(r.id));
      await bind(c, '', ORG);
      await c.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [ORG, 'ZZTEST Anchor Org 2']);
      for (const [k, id] of Object.entries(FAC)) {
        await bind(c, id, ORG);
        await c.query('INSERT INTO facilities (facility_id, organization_id, name) VALUES ($1, $2, $3)', [id, ORG, `ZZTEST Anchor Facility ${k}2`]);
        await audit(c, id, 'referral.created');
        await audit(c, id, 'referral.submitted');
      }
      await c.query('SAVEPOINT seeded');
      const reseed = async () => { await c.query('ROLLBACK TO SAVEPOINT seeded'); await c.query('SAVEPOINT seeded'); };
      await asAnchor();
      await runAnchor({ client: c, s3, bucket, date: '2001-01-03' });
      const KEY = { a: `${FAC.a}/2001-01-03.json`, b: `${FAC.b}/2001-01-03.json`, org: `organization/${ORG}/2001-01-03.json` };
      // 1. consistent rewrite of an anchored row (hash recomputed so only the anchor can tell)
      await asOwner(FAC.a);
      await c.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_immutable');
      await c.query("UPDATE audit_log SET action = 'tampered' WHERE facility_id = $1 AND seq = 2", [FAC.a]);
      await c.query(`UPDATE audit_log a SET row_hash = sha256(coalesce(p.row_hash, '\\x'::bytea) || audit_row_canon('facility', a.facility_id, a.seq, a.actor, a.action, a.entity_type, a.entity_id, a.at))
                     FROM (SELECT row_hash FROM audit_log WHERE facility_id = $1 AND seq = 1) p WHERE a.facility_id = $1 AND a.seq = 2`, [FAC.a]);
      await asAnchor();
      let v = await runVerify({ client: c, s3, bucket });
      assert.deepEqual(sorted(mine(v.problems)), sorted([{ scope: 'facility', id: FAC.a, problem: 'anchored_row_differs', key: KEY.a }]));
      const re = await runAnchor({ client: c, s3, bucket, date: '2001-01-04' });
      assert.deepEqual(mine(re).map((r) => r.status), ['regressed', 'written', 'written'], 'a chain that disagrees with its anchor is not re-anchored');
      await reseed();
      await purgeKey(s3, bucket, `${FAC.b}/2001-01-04.json`); // LocalStack lets the test undo the 'written' ones
      await purgeKey(s3, bucket, `organization/${ORG}/2001-01-04.json`);
      // 2. truncation below the anchor on facility b
      await asOwner(FAC.b);
      await c.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_immutable');
      await c.query('DELETE FROM audit_log WHERE facility_id = $1 AND seq = 2', [FAC.b]);
      await asAnchor();
      v = await runVerify({ client: c, s3, bucket });
      assert.deepEqual(sorted(mine(v.problems)), sorted([{ scope: 'facility', id: FAC.b, problem: 'chain_truncated_below_anchor', key: KEY.b }]));
      assert.deepEqual(mine(await runAnchor({ client: c, s3, bucket, date: '2001-01-05' })).map((r) => r.status), ['written', 'regressed', 'written']);
      await reseed();
      await purgeKey(s3, bucket, `${FAC.a}/2001-01-05.json`);
      await purgeKey(s3, bucket, `organization/${ORG}/2001-01-05.json`);
      // 3. the whole chain and its facility deleted from the database: the bucket still knows it
      await asOwner(FAC.a);
      await c.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_immutable');
      await c.query('DELETE FROM audit_log WHERE facility_id = $1', [FAC.a]);
      await c.query('DELETE FROM facilities WHERE facility_id = $1', [FAC.a]);
      await asAnchor();
      v = await runVerify({ client: c, s3, bucket });
      assert.deepEqual(sorted(mine(v.problems)), sorted([{ scope: 'facility', id: FAC.a, problem: 'chain_missing', key: undefined }]));
      await reseed();
      // 4. the organisation chain is verified too
      await asOwner(''); await bind(c, '', ORG);
      await c.query('ALTER TABLE platform_audit_log DISABLE TRIGGER platform_audit_log_immutable');
      await c.query('DELETE FROM platform_audit_log WHERE organization_id = $1', [ORG]);
      await asAnchor();
      v = await runVerify({ client: c, s3, bucket });
      assert.deepEqual(sorted(mine(v.problems)), sorted([{ scope: 'organization', id: ORG, problem: 'chain_truncated_below_anchor', key: KEY.org }]));
      await reseed();
      // 5. an overwrite (impossible on the real bucket) shows up as a second version; the FIRST version is still compared
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: KEY.a, Body: JSON.stringify({ scope: 'facility', id: FAC.a, date: '2001-01-03', seq: 1, row_hash: '00' }) }));
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: `${FAC.b}/2001-01-06.json`, Body: 'ZZTEST not json {' }));
      await asAnchor();
      v = await runVerify({ client: c, s3, bucket });
      assert.deepEqual(sorted(mine(v.problems)), sorted([
        { scope: 'facility', id: FAC.a, problem: 'anchor_rewritten', key: KEY.a },
        { scope: 'facility', id: FAC.b, problem: 'anchor_unreadable', key: `${FAC.b}/2001-01-06.json` },
      ]));
    });
  } finally {
    if (connected) { await c.query('ROLLBACK').catch(() => {}); await c.end(); }
    if (bucketCreated) {
      const { Versions = [], DeleteMarkers = [] } = await s3.send(new ListObjectVersionsCommand({ Bucket: bucket }));
      for (const v of [...Versions, ...DeleteMarkers]) await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: v.Key, VersionId: v.VersionId }));
      await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
    }
  }
});

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
const bind = async (c, facility, org = ORG) => {
  await c.query("SELECT set_config('app.facility_id', $1, true)", [facility]);
  await c.query("SELECT set_config('app.organization_id', $1, true)", [org]);
};
const audit = (c, facility, action) =>
  c.query("INSERT INTO audit_log (facility_id, actor, action, entity_type) VALUES ($1, 'system:anchor_test', $2, 'facility')", [facility, action]);

test('anchoring job and verifier', { skip: !(url && endpoint) && 'DATABASE_URL or AWS_ENDPOINT_URL (localstack) not set' }, async (t) => {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  const s3 = new S3Client({ forcePathStyle: true });
  const bucket = `zztest-anchor-${Date.now().toString(36)}`;
  await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  await s3.send(new PutBucketVersioningCommand({ Bucket: bucket, VersioningConfiguration: { Status: 'Enabled' } }));
  await c.query('BEGIN');
  const sub = (name, fn) => t.test(name, async () => {
    await c.query('SAVEPOINT sub');
    try { await fn(); } finally { await c.query('ROLLBACK TO SAVEPOINT sub'); }
  });
  try {
    await bind(c, '');
    await c.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [ORG, 'ZZTEST Anchor Org']);
    for (const [k, id] of Object.entries(FAC)) {
      await bind(c, id);
      await c.query('INSERT INTO facilities (facility_id, organization_id, name) VALUES ($1, $2, $3)', [id, ORG, `ZZTEST Anchor Facility ${k}`]);
      await audit(c, id, 'referral.created');
      await audit(c, id, 'referral.submitted');
    }
    const asAnchor = async () => { await c.query('SET LOCAL ROLE codex_anchor'); await bind(c, '', ''); };

    await sub('codex_anchor enumerates facilities and organisations and nothing else; reads chains only when bound', async () => {
      await asAnchor();
      assert.ok(Number((await c.query('SELECT count(*) AS n FROM facilities')).rows[0].n) >= 2);
      assert.ok(Number((await c.query('SELECT count(*) AS n FROM organizations')).rows[0].n) >= 1);
      assert.equal((await c.query('SELECT count(*) AS n FROM audit_log')).rows[0].n, '0', 'unbound: no chain rows');
      for (const tbl of ['referrals', 'documents', 'facts', 'evaluations', 'decisions', 'product_events', 'users', 'user_facility_roles']) {
        await c.query('SAVEPOINT p');
        await assert.rejects(c.query(`SELECT count(*) FROM ${tbl}`), /permission denied/, `${tbl} must be unreadable to codex_anchor`);
        await c.query('ROLLBACK TO SAVEPOINT p');
      }
      await c.query('SAVEPOINT p');
      await assert.rejects(c.query('SELECT name FROM facilities'), /permission denied/, 'facility names are not for the anchor role');
      await c.query('ROLLBACK TO SAVEPOINT p');
      await c.query('SAVEPOINT p');
      await assert.rejects(audit(c, FAC.a, 'x'), /permission denied/, 'the anchor role writes nothing');
      await c.query('ROLLBACK TO SAVEPOINT p');
    });

    await sub('anchor writes one write-once object per chain per day; a second run reports exists; verify passes', async () => {
      await asAnchor();
      const first = await runAnchor({ client: c, s3, bucket, date: '2001-01-01' });
      const mine = first.filter((r) => [FAC.a, FAC.b, ORG].includes(r.id));
      assert.deepEqual(mine.map((r) => r.status), ['written', 'written', 'written']);
      assert.ok(first.every((r) => !('name' in r) && r.status !== 'broken'));
      const second = await runAnchor({ client: c, s3, bucket, date: '2001-01-01' });
      assert.deepEqual(second.filter((r) => [FAC.a, FAC.b, ORG].includes(r.id)).map((r) => r.status), ['exists', 'exists', 'exists']);
      const { Versions } = await s3.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: `${FAC.a}/` }));
      assert.equal(Versions.length, 1, 'If-None-Match kept the key at one version');
      const v = await runVerify({ client: c, s3, bucket });
      assert.deepEqual(v, { ok: true, problems: [] });
      await c.query('RESET ROLE'); await bind(c, FAC.a);
      await audit(c, FAC.a, 'after_anchor');
      await asAnchor();
      assert.equal((await runVerify({ client: c, s3, bucket })).ok, true, 'appending after the anchor is fine');
    });

    await sub('verify detects a rewritten anchored row, truncation below the anchor, and an overwritten anchor', async () => {
      await asAnchor();
      await runAnchor({ client: c, s3, bucket, date: '2001-01-02' });
      await c.query('RESET ROLE'); await bind(c, FAC.a);
      await c.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_immutable');
      await c.query("UPDATE audit_log SET action = 'tampered' WHERE facility_id = $1 AND seq = 2", [FAC.a]);
      // keep the stored hash consistent with the rewrite so only the anchor can tell
      await c.query(`UPDATE audit_log a SET row_hash = sha256(coalesce(p.row_hash, '\\x'::bytea) || audit_row_canon('facility', a.facility_id, a.seq, a.actor, a.action, a.entity_type, a.entity_id, a.at))
                     FROM (SELECT row_hash FROM audit_log WHERE facility_id = $1 AND seq = 1) p WHERE a.facility_id = $1 AND a.seq = 2`, [FAC.a]);
      await asAnchor();
      let v = await runVerify({ client: c, s3, bucket });
      assert.ok(v.problems.some((p) => p.id === FAC.a && p.problem === 'anchored_row_differs'), JSON.stringify(v));
      await c.query('ROLLBACK TO SAVEPOINT sub'); await c.query('SAVEPOINT sub');
      await bind(c, FAC.b);
      await c.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_immutable');
      await c.query('DELETE FROM audit_log WHERE facility_id = $1 AND seq = 2', [FAC.b]);
      await asAnchor();
      v = await runVerify({ client: c, s3, bucket });
      assert.ok(v.problems.some((p) => p.id === FAC.b && p.problem === 'chain_truncated_below_anchor'), JSON.stringify(v));
      await c.query('ROLLBACK TO SAVEPOINT sub'); await c.query('SAVEPOINT sub');
      // an overwrite (impossible on the real bucket) shows up as a second version
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: `${FAC.a}/2001-01-02.json`, Body: JSON.stringify({ scope: 'facility', id: FAC.a, date: '2001-01-02', seq: 1, row_hash: '00' }) }));
      await asAnchor();
      v = await runVerify({ client: c, s3, bucket });
      assert.ok(v.problems.some((p) => p.id === FAC.a && p.problem === 'anchor_rewritten' && p.versions === 2), JSON.stringify(v));
      assert.ok(!v.problems.some((p) => p.id === FAC.a && p.problem === 'anchored_row_differs'), 'the FIRST version is still the one compared');
    });
  } finally {
    await c.query('ROLLBACK');
    await c.end();
    const { Versions = [], DeleteMarkers = [] } = await s3.send(new ListObjectVersionsCommand({ Bucket: bucket }));
    for (const v of [...Versions, ...DeleteMarkers]) await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: v.Key, VersionId: v.VersionId }));
    await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
  }
});

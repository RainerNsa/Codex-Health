// Anchoring and verification over the per-facility and per-organisation audit chains (SPEC §12, I4;
// dev-alignment 1.10). Pure functions over a database client and an S3 client so the test can run them
// inside one rolled-back transaction against LocalStack. Payloads carry ids, sequence numbers and hashes:
// never a name, a value or a quote.
//
// Anchor key scheme (infra/terraform/modules/audit-anchor): <facility_id>/<date>.json and
// organization/<organization_id>/<date>.json, one per chain per day, write-once (If-None-Match: *; the
// bucket policy denies overwrites and deletes). The verifier reads the FIRST version of every key: a
// later version is itself evidence of tampering.
import { GetObjectCommand, ListObjectVersionsCommand, PutObjectCommand } from '@aws-sdk/client-s3';

const SCOPES = {
  facility: { table: 'audit_log', column: 'facility_id', setting: 'app.facility_id', verify: 'audit_chain_verify', list: 'SELECT facility_id AS id FROM facilities ORDER BY 1', prefix: (id) => `${id}/`, key: (id, date) => `${id}/${date}.json` },
  organization: { table: 'platform_audit_log', column: 'organization_id', setting: 'app.organization_id', verify: 'platform_audit_chain_verify', list: 'SELECT id FROM organizations ORDER BY 1', prefix: (id) => `organization/${id}/`, key: (id, date) => `organization/${id}/${date}.json` },
};

export const today = (now = new Date()) => now.toISOString().slice(0, 10);

/** Head of one chain under the caller's binding: null when the chain has no rows. */
async function chainHead(client, scope, id) {
  await client.query('SELECT set_config($1, $2, true)', [scope.setting, id]);
  const { rows } = await client.query(`SELECT seq, encode(row_hash, 'hex') AS row_hash FROM ${scope.table} WHERE ${scope.column} = $1 ORDER BY seq DESC LIMIT 1`, [id]);
  return rows[0] ? { seq: Number(rows[0].seq), row_hash: rows[0].row_hash } : null;
}

async function chainOk(client, scope, id) {
  const { rows } = await client.query(`SELECT seq, ok FROM ${scope.verify}($1)`, [id]);
  return rows.filter((r) => !r.ok).map((r) => Number(r.seq));
}

/** Write today's anchor for every chain. Returns one record per chain; `status` is written | exists | empty | broken. */
export async function runAnchor({ client, s3, bucket, date = today() }) {
  const results = [];
  for (const [name, scope] of Object.entries(SCOPES)) {
    const { rows } = await client.query(scope.list);
    for (const { id } of rows) {
      const head = await chainHead(client, scope, id);
      if (!head) { results.push({ scope: name, id, status: 'empty' }); continue; }
      const broken = await chainOk(client, scope, id);
      if (broken.length) { results.push({ scope: name, id, status: 'broken', seqs: broken }); continue; }
      const body = JSON.stringify({ scope: name, id, date, seq: head.seq, row_hash: head.row_hash, anchored_at: new Date().toISOString() });
      try {
        await s3.send(new PutObjectCommand({ Bucket: bucket, Key: scope.key(id, date), Body: body, ContentType: 'application/json', IfNoneMatch: '*' }));
        results.push({ scope: name, id, status: 'written', seq: head.seq });
      } catch (err) {
        if (err.$metadata?.httpStatusCode === 412 || err.name === 'PreconditionFailed') results.push({ scope: name, id, status: 'exists', seq: head.seq });
        else throw err;
      }
    }
  }
  return results;
}

/** The first (oldest) version of every anchor key under a prefix, parsed. */
async function firstVersions(s3, bucket, prefix) {
  const out = new Map();
  let KeyMarker;
  let VersionIdMarker;
  do {
    const page = await s3.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: prefix, KeyMarker, VersionIdMarker }));
    // S3 lists a key's versions newest first, so the last one seen per key is the FIRST version written.
    // (Timestamps cannot be used: two versions can share a second.)
    for (const v of page.Versions ?? []) {
      if (out.has(v.Key)) out.set(`${v.Key}#count`, (out.get(`${v.Key}#count`) ?? 1) + 1);
      out.set(v.Key, v);
    }
    KeyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
    VersionIdMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
  } while (KeyMarker);
  const anchors = [];
  for (const [key, v] of out) {
    if (key.endsWith('#count')) continue;
    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key, VersionId: v.VersionId }));
    anchors.push({ key, versions: out.get(`${key}#count`) ?? 1, ...JSON.parse(await obj.Body.transformToString()) });
  }
  return anchors.sort((a, b) => (a.date < b.date ? -1 : 1));
}

/**
 * Check every chain against its anchors. A chain fails when: its own hashes do not verify; the anchored
 * (seq, row_hash) is not present with that hash (rewrite, or truncation below the anchor); the current head is
 * below the latest anchored seq (truncation); or any anchor key has more than one version (overwrite attempt).
 * Returns { ok, problems[] } with ids only.
 */
export async function runVerify({ client, s3, bucket }) {
  const problems = [];
  for (const [name, scope] of Object.entries(SCOPES)) {
    const { rows } = await client.query(scope.list);
    for (const { id } of rows) {
      const anchors = await firstVersions(s3, bucket, scope.prefix(id));
      const head = await chainHead(client, scope, id);
      if (anchors.length === 0 && head) problems.push({ scope: name, id, problem: 'no_anchor' });
      if (head) {
        const broken = await chainOk(client, scope, id);
        if (broken.length) problems.push({ scope: name, id, problem: 'chain_hash_mismatch', seqs: broken });
      }
      for (const a of anchors) {
        if (a.versions > 1) problems.push({ scope: name, id, problem: 'anchor_rewritten', key: a.key, versions: a.versions });
        if (!head || head.seq < a.seq) { problems.push({ scope: name, id, problem: 'chain_truncated_below_anchor', anchored_seq: a.seq, head_seq: head?.seq ?? 0 }); continue; }
        const { rows: at } = await client.query(`SELECT encode(row_hash, 'hex') AS row_hash FROM ${scope.table} WHERE ${scope.column} = $1 AND seq = $2`, [id, a.seq]);
        if (!at[0] || at[0].row_hash !== a.row_hash) problems.push({ scope: name, id, problem: 'anchored_row_differs', anchored_seq: a.seq });
      }
    }
  }
  return { ok: problems.length === 0, problems };
}

// Anchoring and verification over the per-facility and per-organisation audit chains (SPEC §12, I4;
// dev-alignment 1.10). Pure functions over a database client and an S3 client so the test can run them
// inside one rolled-back transaction against LocalStack. Payloads carry ids, sequence numbers and hashes:
// never a name, a value or a quote.
//
// Anchor key scheme (infra/terraform/modules/audit-anchor): <facility_id>/<date>.json and
// organization/<organization_id>/<date>.json, one per chain per day, write-once (If-None-Match: *; the
// bucket policy denies overwrites and deletes). The verifier reads the FIRST version of every key: a
// later version is itself evidence of tampering. The set of chains to verify is the UNION of what the
// database lists and what the bucket holds, so a chain deleted from the database is reported, not forgotten.
//
// What anchoring cannot see: rows appended and removed again between two anchor runs, and truncation
// down to exactly the last anchored row. The window is the anchoring interval.
import { GetObjectCommand, ListObjectVersionsCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SCOPES = {
  facility: { table: 'audit_log', column: 'facility_id', setting: 'app.facility_id', verify: 'audit_chain_verify', list: 'SELECT facility_id AS id FROM facilities ORDER BY 1', root: '', key: (id, date) => `${id}/${date}.json` },
  organization: { table: 'platform_audit_log', column: 'organization_id', setting: 'app.organization_id', verify: 'platform_audit_chain_verify', list: 'SELECT id FROM organizations ORDER BY 1', root: 'organization/', key: (id, date) => `organization/${id}/${date}.json` },
};
const prefixOf = (scope, id) => `${scope.root}${id}/`;

export const today = (now = new Date()) => now.toISOString().slice(0, 10);

/** Head of one chain under the caller's binding: null when the chain has no rows. */
async function chainHead(client, scope, id) {
  await client.query('SELECT set_config($1, $2, true)', [scope.setting, id]);
  const { rows } = await client.query(`SELECT seq, encode(row_hash, 'hex') AS row_hash FROM ${scope.table} WHERE ${scope.column} = $1 ORDER BY seq DESC LIMIT 1`, [id]);
  return rows[0] ? { seq: Number(rows[0].seq), row_hash: rows[0].row_hash } : null;
}

async function brokenSeqs(client, scope, id) {
  const { rows } = await client.query(`SELECT seq, ok FROM ${scope.verify}($1)`, [id]);
  return rows.filter((r) => !r.ok).map((r) => Number(r.seq));
}

async function hashAt(client, scope, id, seq) {
  const { rows } = await client.query(`SELECT encode(row_hash, 'hex') AS row_hash FROM ${scope.table} WHERE ${scope.column} = $1 AND seq = $2`, [id, seq]);
  return rows[0]?.row_hash ?? null;
}

/** Chain ids the bucket holds anchors for, under a scope's root (one "directory" per id). */
async function anchoredIds(s3, bucket, scope) {
  const ids = [];
  let ContinuationToken;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: scope.root, Delimiter: '/', ContinuationToken }));
    for (const p of page.CommonPrefixes ?? []) {
      const id = p.Prefix.slice(scope.root.length, -1);
      if (UUID.test(id)) ids.push(id);
    }
    ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return ids;
}

/** The first (oldest) version of every anchor key under a prefix, parsed; unreadable bodies are reported, not thrown. */
async function firstVersions(s3, bucket, prefix) {
  const first = new Map();
  const counts = new Map();
  let KeyMarker;
  let VersionIdMarker;
  do {
    const page = await s3.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: prefix, KeyMarker, VersionIdMarker }));
    // S3 lists a key's versions newest first, so the last one seen per key is the FIRST version written.
    // (Timestamps cannot be used: two versions can share a second.)
    for (const v of page.Versions ?? []) {
      counts.set(v.Key, (counts.get(v.Key) ?? 0) + 1);
      first.set(v.Key, v);
    }
    KeyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
    VersionIdMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
  } while (KeyMarker);
  const anchors = [];
  for (const [key, v] of first) {
    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key, VersionId: v.VersionId }));
    const text = await obj.Body.transformToString();
    let body;
    try { body = JSON.parse(text); } catch { body = null; }
    const valid = body && typeof body.seq === 'number' && typeof body.row_hash === 'string' && typeof body.date === 'string';
    anchors.push({ key, versions: counts.get(key), unreadable: !valid, ...(valid ? body : {}) });
  }
  return anchors.sort((a, b) => ((a.date ?? '') < (b.date ?? '') ? -1 : 1));
}

/**
 * Write today's anchor for every chain the database lists. Per chain `status` is one of:
 * written | exists (today's key already holds an anchor; its stored seq is reported) | empty (no rows) |
 * broken (hashes do not verify; nothing written) | regressed (the head is below, or disagrees with, the latest
 * existing anchor; nothing written). The job exits non-zero on broken or regressed.
 */
export async function runAnchor({ client, s3, bucket, date = today() }) {
  const results = [];
  for (const [name, scope] of Object.entries(SCOPES)) {
    const { rows } = await client.query(scope.list);
    for (const { id } of rows) {
      const head = await chainHead(client, scope, id);
      if (!head) { results.push({ scope: name, id, status: 'empty' }); continue; }
      const broken = await brokenSeqs(client, scope, id);
      if (broken.length) { results.push({ scope: name, id, status: 'broken', seqs: broken }); continue; }
      const anchors = await firstVersions(s3, bucket, prefixOf(scope, id));
      const latest = anchors.filter((a) => !a.unreadable).at(-1);
      if (latest && (head.seq < latest.seq || (await hashAt(client, scope, id, latest.seq)) !== latest.row_hash)) {
        results.push({ scope: name, id, status: 'regressed', anchored_seq: latest.seq, head_seq: head.seq });
        continue;
      }
      const existing = anchors.find((a) => a.key === scope.key(id, date));
      if (existing) { results.push({ scope: name, id, status: 'exists', seq: existing.seq }); continue; }
      const body = JSON.stringify({ scope: name, id, date, seq: head.seq, row_hash: head.row_hash, anchored_at: new Date().toISOString() });
      try {
        await s3.send(new PutObjectCommand({ Bucket: bucket, Key: scope.key(id, date), Body: body, ContentType: 'application/json', IfNoneMatch: '*' }));
        results.push({ scope: name, id, status: 'written', seq: head.seq });
      } catch (err) {
        if (err.$metadata?.httpStatusCode === 412 || err.name === 'PreconditionFailed') results.push({ scope: name, id, status: 'exists' });
        else throw err;
      }
    }
  }
  return results;
}

/**
 * Check every chain the database or the bucket knows against its anchors. Problems, ids only:
 * chain_hash_mismatch | chain_missing (anchored in the bucket, absent from the database) | no_anchor |
 * anchor_unreadable | anchor_rewritten (more than one version of a key) | chain_truncated_below_anchor |
 * anchored_row_differs | anchor_id_mismatch (body id differs from the key).
 */
export async function runVerify({ client, s3, bucket }) {
  const problems = [];
  for (const [name, scope] of Object.entries(SCOPES)) {
    const { rows } = await client.query(scope.list);
    const inDb = new Set(rows.map((r) => r.id));
    const ids = new Set([...inDb, ...(await anchoredIds(s3, bucket, scope))]);
    for (const id of [...ids].sort()) {
      const anchors = await firstVersions(s3, bucket, prefixOf(scope, id));
      const head = inDb.has(id) ? await chainHead(client, scope, id) : null;
      if (!inDb.has(id)) { problems.push({ scope: name, id, problem: 'chain_missing', anchors: anchors.length }); continue; }
      if (anchors.length === 0 && head) problems.push({ scope: name, id, problem: 'no_anchor' });
      if (head) {
        const broken = await brokenSeqs(client, scope, id);
        if (broken.length) problems.push({ scope: name, id, problem: 'chain_hash_mismatch', seqs: broken });
      }
      for (const a of anchors) {
        if (a.unreadable) { problems.push({ scope: name, id, problem: 'anchor_unreadable', key: a.key }); continue; }
        if (a.versions > 1) problems.push({ scope: name, id, problem: 'anchor_rewritten', key: a.key, versions: a.versions });
        if (a.id !== id || a.scope !== name) { problems.push({ scope: name, id, problem: 'anchor_id_mismatch', key: a.key }); continue; }
        if (!head || head.seq < a.seq) { problems.push({ scope: name, id, problem: 'chain_truncated_below_anchor', key: a.key, anchored_seq: a.seq, head_seq: head?.seq ?? 0 }); continue; }
        if ((await hashAt(client, scope, id, a.seq)) !== a.row_hash) problems.push({ scope: name, id, problem: 'anchored_row_differs', key: a.key, anchored_seq: a.seq });
      }
    }
  }
  return { ok: problems.length === 0, problems };
}

// The deletion job (SPEC §9), first half. A person runs it for one facility with an explicit cut-off, so no retention
// period lives in code. It previews unless --apply is passed. It runs as the owner, bound to that facility. It claims the
// referral, which freezes it, then deletes files, then rows, so a failure part-way leaves a referral the next run finishes.
// Only ids and counts are printed.
// shortcut: manual, closed referrals only, no legal hold, and transition notes, override and amendment reasons remain; finish and schedule it once counsel has ruled.
// Evaluation traces keep codes, counts and dates, and the job has no AWS role yet: compute-roles grants no version listing or delete.
// Backups, the dead-letter queue and Textract's store age out on their own clocks; the deletion drill (M6) proves that.
import { pathToFileURL } from 'node:url';
import { DeleteObjectCommand, ListObjectVersionsCommand, S3Client } from '@aws-sdk/client-s3';
import { requireEnv } from '@codex-health/shared';
import type { Send } from './adapters.ts';
import { poolTx } from './db.ts';
import type { Query, Tx } from './pipeline.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// a claimed referral stays due whatever happened since: a run that stopped part-way must be finished
const DUE = "status IN ('finalized', 'amended') AND purged_at IS NULL AND (purge_started_at IS NOT NULL OR updated_at < $2)";
const ACTOR = 'platform:purge';

async function bind(q: Query, facility: string) {
  await q("SELECT set_config('app.facility_id', $1, true)", [facility]);
  const org = (await q<{ organization_id: string }>('SELECT organization_id FROM facilities WHERE facility_id = $1', [facility])).rows[0]?.organization_id;
  if (!org) throw new Error('unknown facility');
  await q("SELECT set_config('app.organization_id', $1, true)", [org]);
}

/** Every version and delete marker under one referral's prefixes. The prefixes are built from checked ids and end in a slash. */
async function deleteFiles(send: Send, bucket: string, facility: string, referral: string) {
  if (!UUID.test(facility) || !UUID.test(referral)) throw new Error('refusing a key that is not two ids');
  let removed = 0;
  for (const root of ['documents', 'quarantine']) {
    const Prefix = `${root}/${facility}/${referral}/`;
    for (;;) { // list again after each page: what was deleted no longer appears
      const r = await send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix }));
      const entries = [...(r['Versions'] ?? []) as { Key: string; VersionId: string }[], ...(r['DeleteMarkers'] ?? []) as { Key: string; VersionId: string }[]];
      if (!entries.length) break;
      for (const { Key, VersionId } of entries) await send(new DeleteObjectCommand({ Bucket: bucket, Key, VersionId }));
      removed += entries.length;
    }
  }
  return removed;
}

export async function purge(tx: Tx, send: Send, bucket: string, facility: string, before: Date, apply: boolean) {
  const due = await tx(async (q) => {
    await bind(q, facility);
    return (await q<{ id: string }>(`SELECT id FROM referrals WHERE facility_id = $1 AND ${DUE} ORDER BY updated_at`, [facility, before])).rows.map((r) => r.id);
  });
  if (!apply) return { due: due.length, purged: 0, files: 0 };
  let purged = 0;
  let files = 0;
  for (const id of due) {
    const claimed = await tx(async (q) => {
      await bind(q, facility);
      return (await q(`UPDATE referrals SET purge_started_at = coalesce(purge_started_at, now()) WHERE facility_id = $1 AND ${DUE} AND id = $3`, [facility, before, id])).rowCount;
    });
    if (!claimed) continue; // reopened by an amendment since the list was read
    files += await deleteFiles(send, bucket, facility, id);
    await tx(async (q) => {
      await bind(q, facility);
      const scope = [facility, id];
      await q('DELETE FROM facts WHERE facility_id = $1 AND referral_id = $2', scope);
      await q('DELETE FROM documents WHERE facility_id = $1 AND referral_id = $2', scope);
      await q('DELETE FROM product_events WHERE facility_id = $1 AND referral_id = $2', scope);
      await q('UPDATE referrals SET purged_at = now() WHERE facility_id = $1 AND id = $2', scope);
      await q('INSERT INTO audit_log (facility_id, actor, action, entity_type, entity_id) VALUES ($1, $2, $3, $4, $5)', [facility, ACTOR, 'referral.purged', 'referral', id]);
      purged += 1;
    });
  }
  return { due: due.length, purged, files };
}

/** --facility <uuid> --before <YYYY-MM-DD> [--apply]; --local for LocalStack's path-style addresses. */
export function parseArgs(argv: string[], now = new Date()) {
  const value = (name: string) => { const i = argv.indexOf(name); return i < 0 ? undefined : argv[i + 1]; };
  const facility = value('--facility') ?? '';
  const raw = value('--before') ?? '';
  const before = new Date(`${raw}T00:00:00Z`);
  if (!UUID.test(facility)) throw new Error('--facility must be a facility id');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(before.getTime()) || before >= now) throw new Error('--before must be a past date, YYYY-MM-DD');
  return { facility, before, apply: argv.includes('--apply'), local: argv.includes('--local') };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { facility, before, apply, local } = parseArgs(process.argv.slice(2));
  const s3 = new S3Client({ region: requireEnv('AWS_REGION'), forcePathStyle: local });
  console.log(JSON.stringify({ event: 'purge', apply, ...await purge(poolTx(requireEnv('DATABASE_URL')), (c) => s3.send(c as never) as unknown as Promise<Record<string, unknown>>, requireEnv('S3_DOCUMENTS_BUCKET'), facility, before, apply) }));
  process.exit(0);
}

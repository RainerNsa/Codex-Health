// Daily anchoring job entry point. Connects as codex_anchor (DATABASE_URL_ANCHOR), writes today's anchors (the
// date is always today here; the parameter exists for the test)
// to AUDIT_ANCHOR_BUCKET, prints one JSON line per chain (ids only) and exits non-zero on a broken chain.
import pg from 'pg';
import { S3Client } from '@aws-sdk/client-s3';
import { runAnchor } from './lib.mjs';

for (const v of ['DATABASE_URL_ANCHOR', 'AUDIT_ANCHOR_BUCKET', 'AWS_REGION']) {
  if (!process.env[v]) { console.error(`missing required environment variable ${v}`); process.exit(2); }
}
const client = new pg.Client({ connectionString: process.env.DATABASE_URL_ANCHOR });
await client.connect();
try {
  await client.query('BEGIN'); // SET LOCAL bindings live inside one read-only transaction
  await client.query('SET TRANSACTION READ ONLY');
  const results = await runAnchor({ client, s3: new S3Client({}), bucket: process.env.AUDIT_ANCHOR_BUCKET });
  await client.query('ROLLBACK');
  for (const r of results) console.log(JSON.stringify(r));
  process.exit(results.some((r) => r.status === 'broken' || r.status === 'regressed') ? 1 : 0);
} finally {
  await client.end();
}

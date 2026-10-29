// Verifier entry point: every chain against every anchor's first version. Exit 1 on any problem.
import pg from 'pg';
import { S3Client } from '@aws-sdk/client-s3';
import { runVerify } from './lib.mjs';

for (const v of ['DATABASE_URL_ANCHOR', 'AUDIT_ANCHOR_BUCKET', 'AWS_REGION']) {
  if (!process.env[v]) { console.error(`missing required environment variable ${v}`); process.exit(2); }
}
const client = new pg.Client({ connectionString: process.env.DATABASE_URL_ANCHOR });
await client.connect();
try {
  await client.query('BEGIN');
  await client.query('SET TRANSACTION READ ONLY');
  const result = await runVerify({ client, s3: new S3Client({}), bucket: process.env.AUDIT_ANCHOR_BUCKET });
  await client.query('ROLLBACK');
  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
} finally {
  await client.end();
}

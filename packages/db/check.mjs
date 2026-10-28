// Runs every CONSTRAINTS check in sql/checks/ against DATABASE_URL. Each file must return zero rows.
// Exit 1 and print the offending rows otherwise. Used locally and by CI (scripts/checks) at M1.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export const CHECKS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sql', 'checks');

/** Returns { file: rows } for every check that returned rows. Empty object means all checks pass. */
export async function runChecks(client, dir = CHECKS_DIR) {
  const failures = {};
  for (const file of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
    const { rows } = await client.query(await readFile(path.join(dir, file), 'utf8'));
    if (rows.length) failures[file] = rows;
  }
  return failures;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set (see .env.example)');
    process.exit(2);
  }
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const failures = await runChecks(client);
    for (const [file, rows] of Object.entries(failures)) {
      console.error(`FAIL ${file}`);
      console.table(rows);
    }
    if (Object.keys(failures).length) process.exit(1);
    console.log('db checks: all pass');
  } finally {
    await client.end();
  }
}

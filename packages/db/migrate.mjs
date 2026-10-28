// Tiny migration runner. Applies migrations/NNNN_name.sql in name order, each in its own transaction,
// and records each in schema_migrations. Connects with DATABASE_URL (role codex_migrator). No ORM.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

/** Migration files not yet applied, in the order they must run. */
export function pending(files, applied) {
  const done = new Set(applied);
  return files.filter((f) => /^\d{4}_.+\.sql$/.test(f) && !done.has(f)).sort();
}

export async function migrate(client, dir = MIGRATIONS_DIR) {
  await client.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
  );
  const { rows } = await client.query('SELECT name FROM schema_migrations');
  const todo = pending(await readdir(dir), rows.map((r) => r.name));
  for (const name of todo) {
    const sql = await readFile(path.join(dir, name), 'utf8');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`migration ${name} failed: ${err.message}`);
    }
    console.log(`applied ${name}`);
  }
  return todo;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set (see .env.example)');
    process.exit(2);
  }
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const applied = await migrate(client);
    console.log(applied.length ? `${applied.length} migration(s) applied` : 'nothing to apply');
  } finally {
    await client.end();
  }
}

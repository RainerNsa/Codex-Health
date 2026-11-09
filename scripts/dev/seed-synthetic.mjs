// Seeds the local database with obviously fake organizations, facilities and users (dev-alignment 1.9 shape).
// Plus the seed rule set per organisation and the synthetic profile per facility. No referrals, no documents, no patient data. Idempotent: fixed ids, ON CONFLICT DO NOTHING.
// Runs as codex_migrator via DATABASE_URL. 'pg' resolves from the root workspace install (hoisted from packages/db).
import pg from 'pg';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FACILITIES, ORGS, seedOrgs, USERS } from './seed-core.mjs';

// The seed rule set (packages/schemas/examples/rules, criteria 'seed') and the synthetic profile for every facility.
const EXAMPLES = fileURLToPath(new URL('../../packages/schemas/examples/', import.meta.url));
const SEED_RULES = readdirSync(`${EXAMPLES}rules`).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(`${EXAMPLES}rules/${f}`, 'utf8')));
const SEED_CAPABILITIES = JSON.parse(readFileSync(`${EXAMPLES}profiles/zztest-facility.json`, 'utf8')).capabilities;

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set (see .env.example)');
  process.exit(2);
}
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
try {
  await c.query('BEGIN');
  await seedOrgs((sql, params) => c.query(sql, params), SEED_RULES, SEED_CAPABILITIES);
  await c.query('COMMIT');
  console.log(`seeded ${ORGS.length} orgs, ${FACILITIES.length} facilities, ${USERS.length} users (all ZZTEST synthetic)`);
} catch (err) {
  await c.query('ROLLBACK');
  throw err;
} finally {
  await c.end();
}

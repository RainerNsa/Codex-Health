// Seeds the local database with obviously fake organizations, facilities and users (dev-alignment 1.9 shape).
// Plus the seed rule set per organisation and the synthetic profile per facility. No referrals, no documents, no patient data. Idempotent: fixed ids, ON CONFLICT DO NOTHING.
// Runs as codex_migrator via DATABASE_URL. 'pg' resolves from the root workspace install (hoisted from packages/db).
import pg from 'pg';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The seed rule set (packages/schemas/examples/rules, criteria 'seed') and the synthetic profile for every facility.
const EXAMPLES = fileURLToPath(new URL('../../packages/schemas/examples/', import.meta.url));
const SEED_RULES = readdirSync(`${EXAMPLES}rules`).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(`${EXAMPLES}rules/${f}`, 'utf8')));
const SEED_CAPABILITIES = JSON.parse(readFileSync(`${EXAMPLES}profiles/zztest-facility.json`, 'utf8')).capabilities;

const ORGS = [
  { id: '00000000-0000-4000-8000-00000000a001', name: 'ZZTEST Organization Alpha' },
  { id: '00000000-0000-4000-8000-00000000a002', name: 'ZZTEST Organization Beta' },
];
const FACILITIES = [
  { id: '00000000-0000-4000-8000-00000000f0a1', org: ORGS[0].id, name: 'ZZTEST Alpha Facility 1' },
  { id: '00000000-0000-4000-8000-00000000f0a2', org: ORGS[0].id, name: 'ZZTEST Alpha Facility 2' },
  { id: '00000000-0000-4000-8000-00000000f0b1', org: ORGS[1].id, name: 'ZZTEST Beta Facility 1' },
  { id: '00000000-0000-4000-8000-00000000f0b2', org: ORGS[1].id, name: 'ZZTEST Beta Facility 2' },
];
// Three staff accounts in org Alpha, one per role, all on Alpha Facility 1. Emails use the reserved .invalid TLD.
const USERS = [
  { id: '00000000-0000-4000-8000-0000000000e1', org: ORGS[0].id, email: 'zztest.admin@example.invalid', name: 'ZZTEST, Admin', role: 'facility_admin' },
  { id: '00000000-0000-4000-8000-0000000000e2', org: ORGS[0].id, email: 'zztest.reviewer@example.invalid', name: 'ZZTEST, Reviewer', role: 'admissions_reviewer' },
  { id: '00000000-0000-4000-8000-0000000000e3', org: ORGS[0].id, email: 'zztest.viewer@example.invalid', name: 'ZZTEST, Viewer', role: 'viewer' },
];

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set (see .env.example)');
  process.exit(2);
}
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
try {
  await c.query('BEGIN');
  for (const o of ORGS) {
    // Provisioning writes must be bound to the organisation they create (migration 0002, provisioning_audit).
    await c.query("SELECT set_config('app.organization_id', $1, true)", [o.id]);
    await c.query('INSERT INTO organizations (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [o.id, o.name]);
  }
  for (const f of FACILITIES) {
    // FORCE RLS applies to the owner too: scope each facility's rows to itself before inserting.
    await c.query("SELECT set_config('app.facility_id', $1, true)", [f.id]);
    await c.query("SELECT set_config('app.organization_id', $1, true)", [f.org]);
    await c.query(
      'INSERT INTO facilities (facility_id, organization_id, name) VALUES ($1, $2, $3) ON CONFLICT (facility_id) DO NOTHING',
      [f.id, f.org, f.name],
    );
  }
  await c.query("SELECT set_config('app.facility_id', $1, true)", [FACILITIES[0].id]);
  for (const u of USERS) {
    await c.query("SELECT set_config('app.organization_id', $1, true)", [u.org]);
    await c.query(
      'INSERT INTO users (id, organization_id, email, display_name) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING',
      [u.id, u.org, u.email, u.name],
    );
    await c.query(
      'INSERT INTO user_facility_roles (user_id, facility_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [u.id, FACILITIES[0].id, u.role],
    );
  }
  // Settings (migration 0008): one rule set per organisation and one profile per facility, only when absent.
  for (const o of ORGS) {
    await c.query("SELECT set_config('app.organization_id', $1, true)", [o.id]);
    const has = await c.query('SELECT 1 FROM rule_sets WHERE organization_id = $1', [o.id]);
    if (!has.rowCount) await c.query("INSERT INTO rule_sets (organization_id, version, criteria_document_ref, rules, created_by) VALUES ($1, 0, 'seed', $2, 'platform:seed')", [o.id, JSON.stringify(SEED_RULES)]);
  }
  for (const f of FACILITIES) {
    await c.query("SELECT set_config('app.facility_id', $1, true), set_config('app.organization_id', $2, true)", [f.id, f.org]);
    const has = await c.query('SELECT 1 FROM facility_profiles WHERE facility_id = $1', [f.id]);
    if (!has.rowCount) await c.query("INSERT INTO facility_profiles (facility_id, version, capabilities, disabled_rules, created_by) VALUES ($1, 0, $2, '{}', 'platform:seed')", [f.id, SEED_CAPABILITIES]);
  }
  await c.query('COMMIT');
  console.log(`seeded ${ORGS.length} orgs, ${FACILITIES.length} facilities, ${USERS.length} users (all ZZTEST synthetic)`);
} catch (err) {
  await c.query('ROLLBACK');
  throw err;
} finally {
  await c.end();
}

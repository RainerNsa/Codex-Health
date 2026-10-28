// Seeds the local database with obviously fake organizations, facilities and users (dev-alignment 1.9 shape).
// No referrals, no documents, no patient data of any kind. Idempotent: fixed ids, ON CONFLICT DO NOTHING.
// Runs as codex_migrator via DATABASE_URL. 'pg' resolves from the root workspace install (hoisted from packages/db).
import pg from 'pg';

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
    await c.query('INSERT INTO organizations (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [o.id, o.name]);
  }
  for (const f of FACILITIES) {
    // FORCE RLS applies to the owner too: scope each facility's rows to itself before inserting.
    await c.query("SELECT set_config('app.facility_id', $1, true)", [f.id]);
    await c.query(
      'INSERT INTO facilities (facility_id, organization_id, name) VALUES ($1, $2, $3) ON CONFLICT (facility_id) DO NOTHING',
      [f.id, f.org, f.name],
    );
  }
  await c.query("SELECT set_config('app.facility_id', $1, true)", [FACILITIES[0].id]);
  for (const u of USERS) {
    await c.query(
      'INSERT INTO users (id, organization_id, email, display_name) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING',
      [u.id, u.org, u.email, u.name],
    );
    await c.query(
      'INSERT INTO user_facility_roles (user_id, facility_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [u.id, FACILITIES[0].id, u.role],
    );
  }
  await c.query('COMMIT');
  console.log(`seeded ${ORGS.length} orgs, ${FACILITIES.length} facilities, ${USERS.length} users (all ZZTEST synthetic)`);
} catch (err) {
  await c.query('ROLLBACK');
  throw err;
} finally {
  await c.end();
}

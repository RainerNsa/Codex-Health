// Five prepared referrals for showing the product, one story each, at ZZTEST Alpha Facility 1. Everything goes through
// the API as the seeded users, exactly as the browser would, so every guard, audit row and co-sign rule applies.
// Synthetic only: facts are entered by hand with a note; no documents, no patient details.
// Needs the API running and seed-synthetic.mjs applied. API_URL defaults to the local API; on the demo server pass
// DEMO_ORIGIN_SECRET, which the API requires on every request there. Refuses a facility that already has referrals
// (run it on a fresh database), unless --add is given.
import { DEMO_FACILITY as FACILITY, DEMO_REVIEWER as REVIEWER, seedStories } from './seed-core.mjs';

const API = process.env.API_URL ?? 'http://127.0.0.1:3000';

async function call(user, method, path, body) {
  const headers = { 'content-type': 'application/json', 'x-codex-dev-user': user };
  if (process.env.DEMO_ORIGIN_SECRET) headers['x-codex-origin'] = process.env.DEMO_ORIGIN_SECRET;
  const res = await fetch(`${API}/api/facilities/${FACILITY}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path.replace(/[0-9a-f-]{36}/g, ':id')}: ${res.status} ${json.error ?? ''}`);
  return json;
}

const existing = await call(REVIEWER, 'GET', '/referrals?filter=open');
const closed = await call(REVIEWER, 'GET', '/referrals?filter=closed');
if ((existing.referrals.length || closed.referrals.length) && !process.argv.includes('--add')) {
  console.log('seed-demo: ZZTEST Alpha Facility 1 already has referrals; nothing added (use --add to add the stories anyway)');
  process.exit(0);
}

await seedStories(call);

console.log('seed-demo: 5 referrals at ZZTEST Alpha Facility 1 (admit, missing information, leadership, do not admit, co-sign waiting).');
console.log('seed-demo: the co-sign is left for the demo: sign in as ZZTEST Admin and co-sign the waiting referral.');

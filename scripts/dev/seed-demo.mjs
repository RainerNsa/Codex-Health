// Five prepared referrals for showing the product, one story each, at ZZTEST Alpha Facility 1. Everything goes through
// the API as the seeded users, exactly as the browser would, so every guard, audit row and co-sign rule applies.
// Synthetic only: facts are entered by hand with a note; no documents, no patient details.
// Needs the API running and seed-synthetic.mjs applied. API_URL defaults to the local API; on the demo server pass
// DEMO_ORIGIN_SECRET, which the API requires on every request there. Refuses a facility that already has referrals
// (run it on a fresh database), unless --add is given.
const API = process.env.API_URL ?? 'http://127.0.0.1:3000';
const FACILITY = '00000000-0000-4000-8000-00000000f0a1';
const REVIEWER = '00000000-0000-4000-8000-0000000000e2';

async function call(user, method, path, body) {
  const headers = { 'content-type': 'application/json', 'x-codex-dev-user': user };
  if (process.env.DEMO_ORIGIN_SECRET) headers['x-codex-origin'] = process.env.DEMO_ORIGIN_SECRET;
  const res = await fetch(`${API}/api/facilities/${FACILITY}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path.replace(/[0-9a-f-]{36}/g, ':id')}: ${res.status} ${json.error ?? ''}`);
  return json;
}

const referral = async (facts) => {
  let view = await call(REVIEWER, 'POST', '/referrals', {});
  for (const [key, value, note] of facts) {
    view = await call(REVIEWER, 'POST', `/referrals/${view.referral.id}/facts`, { key, value: { type: 'tri_state', value }, note, as_of_date: null });
  }
  return call(REVIEWER, 'POST', `/referrals/${view.referral.id}/transitions`, { action: 'submit' });
};
const expect = (view, outcome, story) => {
  if (view.evaluation?.outcome !== outcome) throw new Error(`${story}: expected ${outcome}, got ${view.evaluation?.outcome}`);
  return view;
};

const SKILLED = ['daily_skilled_need', 'yes', 'Physician orders: daily IV antibiotics and wound care; PT and OT 5 days a week.'];
const NO_VENT = ['ventilator_use', 'no', 'Discharge summary: on room air, no respiratory support.'];
const CALM = ['recent_aggression', 'no', 'Nursing notes for the last 14 days: calm and cooperative, no behaviour events.'];

const existing = await call(REVIEWER, 'GET', '/referrals?filter=open');
const closed = await call(REVIEWER, 'GET', '/referrals?filter=closed');
if ((existing.referrals.length || closed.referrals.length) && !process.argv.includes('--add')) {
  console.log('seed-demo: ZZTEST Alpha Facility 1 already has referrals; nothing added (use --add to add the stories anyway)');
  process.exit(0);
}

// 1. Admit, waiting for a person to record the decision
expect(await referral([SKILLED, NO_VENT, CALM]), 'admit', 'admit');

// 2. Needs Review: the packet never says whether the patient is on a ventilator, so the hospital is asked
const missing = expect(await referral([SKILLED, CALM]), 'needs_review', 'missing information');
await call(REVIEWER, 'POST', `/referrals/${missing.referral.id}/transitions`, { action: 'request_info', items: ['ventilator_use'], note: 'Asked the hospital case manager for current respiratory status.' });

// 3. Needs Review: a review rule sends it to leadership
const behaviour = expect(await referral([SKILLED, NO_VENT, ['recent_aggression', 'yes', 'Nursing notes, 3 days ago: struck a staff member during a dressing change.']]), 'needs_review', 'leadership');
await call(REVIEWER, 'POST', `/referrals/${behaviour.referral.id}/transitions`, { action: 'escalate', department: 'director_of_nursing', note: 'Behaviour event within the last week; needs the DON\'s call.' });

// 4. Do Not Admit: the ventilator hard stop, decided as recommended
const vent = expect(await referral([SKILLED, CALM, ['ventilator_use', 'yes', 'Respiratory therapy note: ventilator dependent, settings unchanged for 10 days.']]), 'do_not_admit', 'hard stop');
await call(REVIEWER, 'POST', `/referrals/${vent.referral.id}/decision`, { evaluation_id: vent.evaluation.id, decision: 'do_not_admit' });

// 5. A hard-stop fact corrected after a newer document: Admit now, but only with a second person, an Admin
const corrected = await referral([SKILLED, CALM,
  ['ventilator_use', 'yes', 'Referral form from the hospital lists ventilator dependence.'],
  ['ventilator_use', 'no', 'Updated discharge summary: weaned from the ventilator on day 4, on room air since. The referral form was out of date.']]);
expect(corrected, 'admit', 'co-sign');
await call(REVIEWER, 'POST', `/referrals/${corrected.referral.id}/decision-requests`, { evaluation_id: corrected.evaluation.id, decision: 'admit' });

console.log('seed-demo: 5 referrals at ZZTEST Alpha Facility 1 (admit, missing information, leadership, do not admit, co-sign waiting).');
console.log('seed-demo: the co-sign is left for the demo: sign in as ZZTEST Admin and co-sign the waiting referral.');

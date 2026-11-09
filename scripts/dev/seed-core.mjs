// The synthetic seed, shared by the local scripts (seed-synthetic.mjs, seed-demo.mjs) and the browser preview
// (apps/preview). No Node imports. Obviously fake organisations, facilities and users, and five demo stories.
export const ORGS = [
  { id: '00000000-0000-4000-8000-00000000a001', name: 'ZZTEST Organization Alpha' },
  { id: '00000000-0000-4000-8000-00000000a002', name: 'ZZTEST Organization Beta' },
];
export const FACILITIES = [
  { id: '00000000-0000-4000-8000-00000000f0a1', org: ORGS[0].id, name: 'ZZTEST Alpha Facility 1' },
  { id: '00000000-0000-4000-8000-00000000f0a2', org: ORGS[0].id, name: 'ZZTEST Alpha Facility 2' },
  { id: '00000000-0000-4000-8000-00000000f0b1', org: ORGS[1].id, name: 'ZZTEST Beta Facility 1' },
  { id: '00000000-0000-4000-8000-00000000f0b2', org: ORGS[1].id, name: 'ZZTEST Beta Facility 2' },
];
// Three staff accounts in org Alpha, one per role, all on Alpha Facility 1. Emails use the reserved .invalid TLD.
export const USERS = [
  { id: '00000000-0000-4000-8000-0000000000e1', org: ORGS[0].id, email: 'zztest.admin@example.invalid', name: 'ZZTEST, Admin', role: 'facility_admin' },
  { id: '00000000-0000-4000-8000-0000000000e2', org: ORGS[0].id, email: 'zztest.reviewer@example.invalid', name: 'ZZTEST, Reviewer', role: 'admissions_reviewer' },
  { id: '00000000-0000-4000-8000-0000000000e3', org: ORGS[0].id, email: 'zztest.viewer@example.invalid', name: 'ZZTEST, Viewer', role: 'viewer' },
];


/** Organisations, facilities, users, the seed rule set and the synthetic profile, as codex_migrator inside one
 *  transaction the caller opens. Idempotent: fixed ids, ON CONFLICT DO NOTHING. */
export async function seedOrgs(q, rules, capabilities) {
  for (const o of ORGS) {
    // Provisioning writes must be bound to the organisation they create (migration 0002, provisioning_audit).
    await q("SELECT set_config('app.organization_id', $1, true)", [o.id]);
    await q('INSERT INTO organizations (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [o.id, o.name]);
  }
  for (const f of FACILITIES) {
    // FORCE RLS applies to the owner too: scope each facility's rows to itself before inserting.
    await q("SELECT set_config('app.facility_id', $1, true)", [f.id]);
    await q("SELECT set_config('app.organization_id', $1, true)", [f.org]);
    await q(
      'INSERT INTO facilities (facility_id, organization_id, name) VALUES ($1, $2, $3) ON CONFLICT (facility_id) DO NOTHING',
      [f.id, f.org, f.name],
    );
  }
  await q("SELECT set_config('app.facility_id', $1, true)", [FACILITIES[0].id]);
  for (const u of USERS) {
    await q("SELECT set_config('app.organization_id', $1, true)", [u.org]);
    await q(
      'INSERT INTO users (id, organization_id, email, display_name) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING',
      [u.id, u.org, u.email, u.name],
    );
    await q(
      'INSERT INTO user_facility_roles (user_id, facility_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [u.id, FACILITIES[0].id, u.role],
    );
  }
  // Settings (migration 0008): one rule set per organisation and one profile per facility, only when absent.
  for (const o of ORGS) {
    await q("SELECT set_config('app.organization_id', $1, true)", [o.id]);
    const has = await q('SELECT 1 FROM rule_sets WHERE organization_id = $1', [o.id]);
    if (!has.rowCount) await q("INSERT INTO rule_sets (organization_id, version, criteria_document_ref, rules, created_by) VALUES ($1, 0, 'seed', $2, 'platform:seed')", [o.id, JSON.stringify(rules)]);
  }
  for (const f of FACILITIES) {
    await q("SELECT set_config('app.facility_id', $1, true), set_config('app.organization_id', $2, true)", [f.id, f.org]);
    const has = await q('SELECT 1 FROM facility_profiles WHERE facility_id = $1', [f.id]);
    if (!has.rowCount) await q("INSERT INTO facility_profiles (facility_id, version, capabilities, disabled_rules, created_by) VALUES ($1, 0, $2, '{}', 'platform:seed')", [f.id, capabilities]);
  }
}

export const DEMO_FACILITY = FACILITIES[0].id;
export const DEMO_REVIEWER = USERS[1].id;

/** The five demo stories at ZZTEST Alpha Facility 1, through the API as the ZZTEST Reviewer, so every guard, audit
 *  row and co-sign rule applies. `call(user, method, path, body)` is relative to the facility and returns the JSON. */
export async function seedStories(call) {
  const REVIEWER = DEMO_REVIEWER;
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
}

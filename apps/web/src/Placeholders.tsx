// Navigable placeholders (dev-alignment 3.1): screens the product will have, shown now so the shape of the app is
// clear, holding no data until their milestone. Each says what it will hold and what to use until then.
export type Screen = 'referrals' | 'settings' | 'dashboard' | 'history' | 'audit' | 'criteria' | 'users';

export const SCREENS: { id: Screen; label: string }[] = [
  { id: 'referrals', label: 'Referrals' },
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'history', label: 'History' },
  { id: 'audit', label: 'Audit trail' },
  { id: 'criteria', label: 'Criteria versions' },
  { id: 'settings', label: 'Facility settings' },
  { id: 'users', label: 'Users' },
];

const PLACEHOLDER: Partial<Record<Screen, { holds: string; meanwhile: string }>> = {
  dashboard: {
    holds: 'Referral counts by status and time from receipt to decision for this facility, built from the events recorded today.',
    meanwhile: 'The Referrals screen lists what needs staff, what is processing and what is decided.',
  },
  history: {
    holds: 'Every decided referral with its decisions, co-signs and amendments, searchable by date and outcome.',
    meanwhile: 'The Decided view on the Referrals screen lists decided referrals; opening one shows its full decision history.',
  },
  audit: {
    holds: "The facility's audit log, with its hash-chain check and the daily anchors, for Admins.",
    meanwhile: 'The audit log is already written for every read and change; this screen only makes it browsable.',
  },
  criteria: {
    holds: "The organisation's rule set versions, what changed between them, and which version each decision used.",
    meanwhile: 'Facility settings shows the rule set version in force; every recommendation records the version it used.',
  },
  users: {
    holds: 'Inviting staff to this facility and assigning their roles, with sign-in and multi-factor authentication.',
    meanwhile: 'Roles are provisioned by the platform; the local build uses fixed synthetic users.',
  },
};

export function Nav({ screen, onSelect }: { screen: Screen; onSelect: (s: Screen) => void }) {
  return (
    <nav aria-label="Screens" className="mb-6 flex flex-wrap gap-2 border-b border-gray-300 pb-2">
      {SCREENS.map((s) => (
        <button key={s.id} type="button" aria-current={screen === s.id ? 'page' : undefined} onClick={() => onSelect(s.id)}
          className={`rounded px-3 py-1 text-sm ${screen === s.id ? 'bg-gray-900 text-white' : 'border border-gray-300'}`}>
          {s.label}{PLACEHOLDER[s.id] ? <span className="sr-only"> (coming at M6)</span> : null}
        </button>
      ))}
    </nav>
  );
}

export function Placeholder({ screen }: { screen: Screen }) {
  const p = PLACEHOLDER[screen];
  if (!p) return null;
  const label = SCREENS.find((s) => s.id === screen)?.label ?? screen;
  return (
    <section aria-labelledby="placeholder" className="rounded border border-dashed border-gray-400 p-6">
      <h2 id="placeholder" className="font-semibold">{label}</h2>
      <p className="mt-1 text-xs uppercase tracking-wide text-gray-500">Arrives at M6. No data on this screen yet.</p>
      <p className="mt-3 text-sm">It will hold: {p.holds}</p>
      <p className="mt-2 text-sm text-gray-700">Until then: {p.meanwhile}</p>
    </section>
  );
}

/** Whether a screen is a placeholder (for tests and the nav). */
export const isPlaceholder = (s: Screen) => PLACEHOLDER[s] !== undefined;

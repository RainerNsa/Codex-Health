// Facility settings (M3 slice 1; SPEC §2, §8; D2, R7): the completeness checklist first, then the profile and the
// rule switches. Reviewers read; only an Admin saves, and every save is a new audited profile version.
import { useState } from 'react';
import { ApiError, getSettings, saveSettings, type Settings } from './api.ts';

const label = (k: string) => k.replaceAll('_', ' ');

export function SettingsPanel({ facility, user }: { facility: string; user: string }) {
  const [s, setS] = useState<Settings | null>(null);
  const [caps, setCaps] = useState<Record<string, boolean | number>>({});
  const [off, setOff] = useState<string[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const load = async () => {
    setMsg(null);
    try {
      const v = await getSettings(facility, user);
      setS(v);
      setCaps({ ...(v.profile?.capabilities ?? {}) });
      setOff([...(v.profile?.disabled_rules ?? [])]);
    } catch (err) {
      setMsg(err instanceof ApiError && err.code === 'forbidden' ? 'Settings are for Reviewers and Admins.'
        : err instanceof ApiError && err.code === 'rule_set_refused' ? 'The organisation\'s rule set is invalid; referrals cannot be evaluated until it is replaced.'
        : 'Could not load settings.');
    }
  };
  const save = async () => {
    setMsg(null);
    try {
      const v = await saveSettings(facility, user, { capabilities: caps, disabled_rules: off, based_on_version: s?.profile?.version ?? 0 });
      setS(v);
      setOff([...(v.profile?.disabled_rules ?? [])]);
      setMsg(`Saved as profile version ${v.profile?.version ?? '?'}.`);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : '';
      setMsg(code === 'forbidden' ? 'Only an Admin can change settings.'
        : code === 'settings_changed' ? 'Someone saved these settings meanwhile. Load them again, then make your change.'
        : code === 'rule_not_switchable' ? 'Hard-stop and payer rules cannot be switched off at a facility.'
        : 'The settings were not saved: check every value.');
    }
  };
  return (
    <section aria-labelledby="settings" className="mb-6 rounded border border-gray-300 p-4">
      <div className="flex items-center gap-3">
        <h2 id="settings" className="font-semibold">Facility settings</h2>
        <button type="button" className="rounded border border-gray-900 px-3 py-1 text-sm" onClick={load}>Load</button>
      </div>
      {msg && <p role="status" className="mt-2 text-sm">{msg}</p>}
      {s && !s.configured && <p className="mt-2 text-sm">This facility has no rule set or profile yet; referrals cannot be evaluated.</p>}
      {s?.configured && s.profile_keys && s.completeness && s.rule_set && (
        <>
          <p className="mt-2 text-sm">Rule set version {s.rule_set.version} ({s.rule_set.criteria_document_ref}); profile version {s.profile?.version}.</p>
          <div className={`mt-2 rounded border-l-4 p-2 text-sm ${s.completeness.missing_keys.length ? 'border-amber-700 bg-amber-50' : 'border-green-700 bg-green-50'}`}>
            {s.completeness.missing_keys.length
              ? <>Not set, and read by an enabled rule (referrals will need review until set): {s.completeness.missing_keys.map(label).join(', ')}</>
              : <>Every setting an enabled rule reads is set.</>}
          </div>
          <fieldset className="mt-3">
            <legend className="font-medium">Capabilities</legend>
            {Object.entries(s.profile_keys).map(([k, type]) => (
              <label key={k} className="mr-4 mt-1 inline-block text-sm">
                {label(k)}{' '}
                {type === 'boolean'
                  ? <select value={caps[k] === undefined ? '' : String(caps[k])} onChange={(e) => setCaps(e.target.value === '' ? Object.fromEntries(Object.entries(caps).filter(([x]) => x !== k)) : { ...caps, [k]: e.target.value === 'true' })} className="rounded border p-1">
                      <option value="">not set</option><option value="true">yes</option><option value="false">no</option>
                    </select>
                  : <input type="number" min={0} value={caps[k] === undefined ? '' : String(caps[k])} onChange={(e) => setCaps(e.target.value === '' ? Object.fromEntries(Object.entries(caps).filter(([x]) => x !== k)) : { ...caps, [k]: Math.max(0, Math.trunc(Number(e.target.value))) })} className="w-20 rounded border p-1" />}
              </label>
            ))}
          </fieldset>
          <fieldset className="mt-3">
            <legend className="font-medium">Rules at this facility</legend>
            {s.rule_set.rules.map((r) => (
              <label key={r.id} className="block text-sm">
                <input type="checkbox" checked={r.enabled_in_rule_set && !off.includes(r.id)} disabled={!r.switchable}
                  onChange={(e) => setOff(e.target.checked ? off.filter((x) => x !== r.id) : [...off, r.id])} />{' '}
                <span className="font-mono text-xs">{r.id}</span> ({label(r.kind)}){r.explanation ? ` — ${r.explanation}` : ''}
                {!r.enabled_in_rule_set ? ' (off in the organisation rule set)' : !r.switchable ? ' (always on)' : ''}
              </label>
            ))}
          </fieldset>
          <button type="button" className="mt-3 rounded bg-gray-900 px-3 py-1 text-sm text-white" onClick={save}>Save as a new version</button>
        </>
      )}
    </section>
  );
}

// Facility settings (M3 slice 1; SPEC §2, §8; D2, R7): the completeness checklist first, then the profile and the
// rule switches. Reviewers read; only an Admin saves, and every save is a new audited profile version.
import { useState } from 'react';
import { Box, Button, Input, SimpleGrid, Text, chakra } from '@chakra-ui/react';
import { ApiError, getSettings, saveSettings, type Settings } from './api.ts';
import { Callout, Field, Panel, Select } from './ui.tsx';

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
    <Panel id="settings" title="Facility settings" action={<Button size="xs" variant="outline" onClick={load}>Load</Button>}>
      {msg && <Text role="status" fontSize="sm">{msg}</Text>}
      {s && !s.configured && <Text mt="2" fontSize="sm">This facility has no rule set or profile yet; referrals cannot be evaluated.</Text>}
      {s?.configured && s.profile_keys && s.completeness && s.rule_set && (
        <>
          <Text mt="2" fontSize="sm">Rule set version {s.rule_set.version} ({s.rule_set.criteria_document_ref}); profile version {s.profile?.version}.</Text>
          <Box mt="2">
            <Callout tone={s.completeness.missing_keys.length ? 'review' : 'admit'}>
              {s.completeness.missing_keys.length
                ? <>Not set, and read by an enabled rule (referrals will need review until set): {s.completeness.missing_keys.map(label).join(', ')}</>
                : <>Every setting an enabled rule reads is set.</>}
            </Callout>
          </Box>
          <chakra.fieldset mt="3">
            <chakra.legend fontWeight="600" fontSize="sm">Capabilities</chakra.legend>
            <SimpleGrid mt="1" columns={{ base: 1, sm: 2, lg: 3 }} gap="3">
              {Object.entries(s.profile_keys).map(([k, type]) => (
                <Field key={k} label={label(k)}>
                  {type === 'boolean'
                    ? <Select value={caps[k] === undefined ? '' : String(caps[k])} onChange={(v) => setCaps(v === '' ? Object.fromEntries(Object.entries(caps).filter(([x]) => x !== k)) : { ...caps, [k]: v === 'true' })}>
                        <option value="">not set</option><option value="true">yes</option><option value="false">no</option>
                      </Select>
                    : <Input size="sm" type="number" min={0} value={caps[k] === undefined ? '' : String(caps[k])} onChange={(e) => setCaps(e.target.value === '' ? Object.fromEntries(Object.entries(caps).filter(([x]) => x !== k)) : { ...caps, [k]: Math.max(0, Math.trunc(Number(e.target.value))) })} />}
                </Field>
              ))}
            </SimpleGrid>
          </chakra.fieldset>
          <chakra.fieldset mt="3">
            <chakra.legend fontWeight="600" fontSize="sm">Rules at this facility</chakra.legend>
            {s.rule_set.rules.map((r) => (
              <Box as="label" key={r.id} display="block" fontSize="sm" mt="1">
                <input type="checkbox" checked={r.enabled_in_rule_set && !off.includes(r.id)} disabled={!r.switchable}
                  onChange={(e) => setOff(e.target.checked ? off.filter((x) => x !== r.id) : [...off, r.id])} />{' '}
                <chakra.span fontFamily="mono" fontSize="xs">{r.id}</chakra.span> ({label(r.kind)}){r.explanation ? ` — ${r.explanation}` : ''}
                {!r.enabled_in_rule_set ? ' (off in the organisation rule set)' : !r.switchable ? ' (always on)' : ''}
              </Box>
            ))}
          </chakra.fieldset>
          <Button mt="3" size="sm" onClick={save}>Save as a new version</Button>
        </>
      )}
    </Panel>
  );
}

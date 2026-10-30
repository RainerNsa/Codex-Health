// The rule set and facility profile an evaluation runs against, read per request from the database (migration
// 0008): the organisation's latest rule set version and the facility's latest profile version, with the
// facility's switched-off rules disabled. Both versions are pinned on every evaluation (SPEC §7).
import { evaluate, keyTypes, lintRule, type Rule, type Profile } from '@codex-health/rules-engine';
import type { Query } from './db.ts';

export const PROFILE_KEYS: Readonly<Record<string, 'boolean' | 'count'>> = {
  accepts_ventilator: 'boolean', accepts_tracheostomy: 'boolean', accepts_dialysis: 'boolean', accepts_bariatric: 'boolean',
  accepts_iv_antibiotics: 'boolean', accepts_isolation: 'boolean',
  ventilator_beds: 'count', bariatric_beds: 'count', isolation_rooms: 'count', max_patient_weight_kg: 'count',
};

/** Rules the API will not let a facility switch off until the founder rules otherwise (decision log 2026-10-29). */
export const NOT_SWITCHABLE: ReadonlySet<string> = new Set(['hard_stop', 'payer']);

/** A stored rule set the engine refuses: the facility answers 409 rule_set_refused, never 500. */
export class RuleSetRefused extends Error {}

export interface RuleSet {
  rules: Rule[];
  profile: Profile;
  profileVersion: number;
  ruleSetVersion: number;
  criteriaRef: string;
  disabledRules: string[];
  /** Rules switched off in the organisation's rule set itself (not by this facility). */
  baseDisabled: Set<string>;
  /** Fact keys the form offers: every non-profile input of an enabled rule, with the type the rules read it as. */
  factKeys: { key: string; type: 'tri_state' | 'count' | 'enum'; critical: boolean; read_by: string[] }[];
  critical: Set<string>;
  /** R7: every profile key an enabled rule reads, and those not set. */
  completeness: { required_keys: string[]; missing_keys: string[] };
}

/** Pure: build the evaluation view from a stored rule set and profile. Throws on a rule set the form cannot type. */
export function buildRuleSet(input: { rules: Rule[]; ruleSetVersion: number; criteriaRef: string; capabilities: Profile; profileVersion: number; disabledRules: string[] }): RuleSet {
  try {
    return build(input);
  } catch (err) {
    throw err instanceof RuleSetRefused ? err : new RuleSetRefused((err as Error).message);
  }
}

function build(input: Parameters<typeof buildRuleSet>[0]): RuleSet {
  if (!Array.isArray(input.rules)) throw new RuleSetRefused('rule set refused: not a list of rules');
  const lint = input.rules.flatMap((r) => lintRule(r));
  if (lint.length) throw new RuleSetRefused(`rule set refused: ${lint.join('; ')}`);
  const disabled = new Set(input.disabledRules);
  const rules = input.rules.map((r) => ({ ...r, enabled: r.enabled === true && !disabled.has(r.id) }));
  const enabled = rules.filter((r) => r.enabled);
  const critical = new Set(enabled.filter((r) => r.kind === 'hard_stop' || r.kind === 'payer').flatMap((r) => r.inputs).filter((k) => !k.startsWith('facility.')));
  const keys = [...new Set(enabled.flatMap((r) => r.inputs).filter((k) => !k.startsWith('facility.')))].sort();
  const types = keyTypes(enabled.map((r) => r.expression));
  // the engine's own refusals (duplicate ids, protected inputs without a legal reviewer, 'is unknown' outside
  // review rules) surface here, on read, instead of on the first fact entry
  evaluate({ facts: [], profile: input.capabilities, rules, referral_date: '2001-01-01', processing_complete: true });
  const required = [...new Set(enabled.flatMap((r) => r.inputs).filter((k) => k.startsWith('facility.')).map((k) => k.slice('facility.'.length)))].sort();
  return {
    rules,
    profile: input.capabilities,
    profileVersion: input.profileVersion,
    ruleSetVersion: input.ruleSetVersion,
    criteriaRef: input.criteriaRef,
    disabledRules: [...disabled].sort(),
    baseDisabled: new Set(input.rules.filter((r) => r.enabled !== true).map((r) => r.id)),
    factKeys: keys.map((key) => ({ key, type: types.get(key) ?? 'tri_state', critical: critical.has(key), read_by: enabled.filter((r) => r.inputs.includes(key)).map((r) => r.id) })),
    critical,
    completeness: { required_keys: required, missing_keys: required.filter((k) => input.capabilities[k] === undefined) },
  };
}

/** The facility's settings under the caller's bindings: the latest versions, or the versions an evaluation pinned.
 *  Null when the organisation has no rule set or the facility no profile (at those versions). */
export async function loadSettings(q: Query, facilityId: string, organizationId: string, at?: { ruleSetVersion: number; profileVersion: number }): Promise<RuleSet | null> {
  const rs = await q<{ version: number; criteria_document_ref: string; rules: Rule[] }>(
    'SELECT version, criteria_document_ref, rules FROM rule_sets WHERE organization_id = $1 AND ($2::int IS NULL OR version = $2) ORDER BY version DESC LIMIT 1',
    [organizationId, at?.ruleSetVersion ?? null]);
  const fp = await q<{ version: number; capabilities: Profile; disabled_rules: string[] }>(
    'SELECT version, capabilities, disabled_rules FROM facility_profiles WHERE facility_id = $1 AND ($2::int IS NULL OR version = $2) ORDER BY version DESC LIMIT 1',
    [facilityId, at?.profileVersion ?? null]);
  if (!rs.rows[0] || !fp.rows[0]) return null;
  return buildRuleSet({
    rules: rs.rows[0].rules, ruleSetVersion: rs.rows[0].version, criteriaRef: rs.rows[0].criteria_document_ref,
    capabilities: fp.rows[0].capabilities, profileVersion: fp.rows[0].version, disabledRules: fp.rows[0].disabled_rules,
  });
}

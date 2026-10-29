// The rule set and facility profile the API evaluates against.
// shortcut: every facility uses the committed seed rule set and the synthetic profile under packages/schemas
// (criteria_document_ref 'seed'); per-facility rule sets and profiles arrive with the facility-settings tables
// (M3) and the criteria workshop (SPEC §11).
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseExpression, type Expr, type Rule, type Profile } from '@codex-health/rules-engine';

const examples = fileURLToPath(new URL('../../../packages/schemas/examples/', import.meta.url));

export interface RuleSet {
  rules: Rule[];
  profile: Profile;
  profileVersion: number;
  ruleSetVersion: number;
  criteriaRef: string;
  /** Fact keys the form offers: every non-profile input of an enabled rule. */
  factKeys: { key: string; type: 'tri_state' | 'count' | 'enum'; critical: boolean; read_by: string[] }[];
  critical: Set<string>;
}

export function loadSeedRuleSet(): RuleSet {
  const rules = readdirSync(`${examples}rules`).filter((f) => f.endsWith('.json')).sort()
    .map((f) => JSON.parse(readFileSync(`${examples}rules/${f}`, 'utf8')) as Rule);
  const profileFile = JSON.parse(readFileSync(`${examples}profiles/zztest-facility.json`, 'utf8')) as { version: number; capabilities: Profile };
  const enabled = rules.filter((r) => r.enabled);
  const critical = new Set(enabled.filter((r) => r.kind === 'hard_stop' || r.kind === 'payer').flatMap((r) => r.inputs).filter((k) => !k.startsWith('facility.')));
  const keys = [...new Set(enabled.flatMap((r) => r.inputs).filter((k) => !k.startsWith('facility.')))].sort();
  // The value type each key must carry, from how the rules read it (§10.2): `is yes|no|unknown` and `within` read a
  // tri-state, a comparison reads a count, `is <code>` reads an enum. A key read two ways is refused at load.
  const types = new Map<string, 'tri_state' | 'count' | 'enum'>();
  const walk = (e: Expr): void => {
    if (e.op === 'and' || e.op === 'or') { walk(e.left); walk(e.right); return; }
    if (e.op === 'not') { walk(e.expr); return; }
    const t = e.op === 'fact_is' || e.op === 'fact_within' ? 'tri_state' : e.op === 'fact_cmp' ? 'count' : e.op === 'fact_is_code' ? 'enum' : null;
    if (!t) return;
    const seen = types.get(e.key);
    if (seen && seen !== t) throw new Error(`rule set refused: fact ${e.key} is read as both ${seen} and ${t}`);
    types.set(e.key, t);
  };
  for (const r of enabled) walk(parseExpression(r.expression));
  return {
    rules,
    profile: profileFile.capabilities,
    profileVersion: profileFile.version,
    ruleSetVersion: 1,
    criteriaRef: 'seed',
    factKeys: keys.map((key) => ({ key, type: types.get(key) ?? 'tri_state', critical: critical.has(key), read_by: enabled.filter((r) => r.inputs.includes(key)).map((r) => r.id) })),
    critical,
  };
}

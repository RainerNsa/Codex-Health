// evaluate(): every enabled rule to a tri-state under Kleene logic, then the fixed §4 resolution order
// (SPEC §4, §10.3). Pure: the only inputs are the fact set, the profile, the rules, the referral date and
// the processing flag. The trace carries keys, codes, rule ids and tri-states only.
import { and, not, or } from './kleene.ts';
import { parseExpression, referencedKeys, type Expr, type Cmp } from './dsl.ts';
import { presence, type Fact, type FactValue, type NeedsReviewReason, type Outcome, type RuleKind, type TriState } from './types.ts';

export const ENGINE_VERSION = '0.1.0';

export type Profile = Readonly<Record<string, boolean | number>>;
export type FinancialStatus = 'clear' | 'hold' | 'unknown';

export interface Rule {
  id: string;
  kind: RuleKind;
  enabled: boolean;
  inputs: readonly string[];
  expression: string;
  sub_reason?: NeedsReviewReason | null;
  protected_input?: boolean;
  legal_reviewer?: unknown;
  tests?: readonly RuleTestCase[];
}

export interface RuleTestCase {
  name: string;
  /** key → tri-state, or a full fact value (`{"type":"count","value":3}`). */
  facts: Readonly<Record<string, TriState | FactValue>>;
  profile: Profile;
  expected: 'true' | 'false' | 'unknown';
}

export interface EvaluateInput {
  /** Current assertions; several per key means a conflict (SPEC §3). */
  facts: readonly Fact[];
  profile: Profile;
  rules: readonly Rule[];
  /** YYYY-MM-DD; recency windows are measured from it, never from a clock. */
  referral_date: string;
  processing_complete: boolean;
  flags?: { favorable_rule_required?: boolean };
}

export interface TraceEntry {
  rule_id: string;
  kind: RuleKind;
  result: TriState;
  /** Per input key: the presence the rule saw and, for enum/count facts, the code or number. Never text or a date. */
  inputs: { key: string; presence: TriState; value?: string | number }[];
}

export interface Evaluation {
  outcome: Outcome;
  clinical_outcome: Outcome;
  financial_status: FinancialStatus;
  sub_reasons: NeedsReviewReason[];
  resolution_step: string;
  trace: TraceEntry[];
  missing: string[];
  conflicts: string[];
  /** Unknown critical keys ranked by how many rules read them: "would be Admit if this one were known". */
  blocking: string[];
  empty_profile_keys: string[];
  engine_version: string;
}

// ---------- fact view ----------
interface FactView { presence: TriState; value: FactValue | null; as_of_date: string | null; conflict: boolean; critical: boolean; protected: boolean }

function viewFacts(facts: readonly Fact[]): Map<string, FactView> {
  const byKey = new Map<string, Fact[]>();
  for (const f of facts) byKey.set(f.key, [...(byKey.get(f.key) ?? []), f]);
  const out = new Map<string, FactView>();
  for (const [key, list] of byKey) {
    // A conflict is any disagreement between assertions of one key: in value, or in trust (one verified, one
    // not), so the view is the same whatever order the facts arrive in (I6 replay).
    const first = list[0]!;
    const views = new Set(list.map((f) => `${presence(f)}|${JSON.stringify(f.value)}|${f.as_of_date ?? ''}`));
    const conflict = views.size > 1;
    out.set(key, {
      presence: conflict ? 'unknown' : presence(first),
      value: conflict ? null : first.value,
      as_of_date: conflict ? null : first.as_of_date,
      conflict,
      critical: list.some((f) => f.is_critical),
      protected: list.some((f) => f.specially_protected),
    });
  }
  return out;
}

const daysBetween = (a: string, b: string): number => Math.round((Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10)) - Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10))) / 86_400_000);
const compare = (cmp: Cmp, left: number, right: number): boolean =>
  cmp === '=' ? left === right : cmp === '!=' ? left !== right : cmp === '<' ? left < right : cmp === '<=' ? left <= right : cmp === '>' ? left > right : left >= right;
const bool = (b: boolean): TriState => (b ? 'yes' : 'no');

interface Ctx { facts: Map<string, FactView>; profile: Profile; referral_date: string; emptyProfileKeys: Set<string> }

function evalExpr(e: Expr, ctx: Ctx): TriState {
  switch (e.op) {
    case 'and': return and(evalExpr(e.left, ctx), evalExpr(e.right, ctx));
    case 'or': return or(evalExpr(e.left, ctx), evalExpr(e.right, ctx));
    case 'not': return not(evalExpr(e.expr, ctx));
    case 'fact_is': {
      const p = ctx.facts.get(e.key)?.presence ?? 'unknown';
      if (e.value === 'unknown') return bool(p === 'unknown');
      return p === 'unknown' ? 'unknown' : bool(p === e.value);
    }
    case 'fact_is_code': {
      const v = ctx.facts.get(e.key)?.value;
      if (!v || v.type !== 'enum' || v.value === null) return 'unknown';
      return bool(v.value === e.code);
    }
    case 'fact_cmp': {
      const v = ctx.facts.get(e.key)?.value;
      if (!v || v.type !== 'count' || v.value === null) return 'unknown';
      return bool(compare(e.cmp, v.value, e.number));
    }
    case 'fact_within': {
      const f = ctx.facts.get(e.key);
      if (!f || f.presence === 'unknown' || !f.as_of_date) return 'unknown';
      const d = daysBetween(f.as_of_date, ctx.referral_date);
      return bool(d >= 0 && d <= e.days);
    }
    case 'profile_is': {
      const v = ctx.profile[e.key];
      if (typeof v !== 'boolean') { ctx.emptyProfileKeys.add(e.key); return 'unknown'; }
      return bool(v === e.value);
    }
    case 'profile_cmp': {
      const v = ctx.profile[e.key];
      if (typeof v !== 'number') { ctx.emptyProfileKeys.add(e.key); return 'unknown'; }
      return bool(compare(e.cmp, v, e.number));
    }
  }
}

/** One rule against a fact view and profile. Exported for the rule-test runner. */
export function evaluateRule(rule: Rule, facts: readonly Fact[], profile: Profile, referral_date: string): TraceEntry {
  const ctx: Ctx = { facts: viewFacts(facts), profile, referral_date, emptyProfileKeys: new Set() };
  return evaluateRuleWith(rule, ctx);
}

function evaluateRuleWith(rule: Rule, ctx: Ctx): TraceEntry {
  const expr = parseExpression(rule.expression);
  const result = evalExpr(expr, ctx);
  const inputs = referencedKeys(expr).map((key) => {
    if (key.startsWith('facility.')) {
      const v = ctx.profile[key.slice('facility.'.length)];
      return { key, presence: v === undefined ? 'unknown' as const : 'yes' as const, ...(typeof v === 'number' ? { value: v } : {}) };
    }
    const f = ctx.facts.get(key);
    const value = f?.value && (f.value.type === 'enum' || f.value.type === 'count') && f.value.value !== null ? { value: f.value.value as string | number } : {};
    return { key, presence: f?.presence ?? 'unknown', ...value };
  });
  return { rule_id: rule.id, kind: rule.kind, result, inputs };
}

// ---------- resolver (§4) ----------
interface Resolved { outcome: Outcome; sub_reasons: NeedsReviewReason[]; step: string }
type Entry = TraceEntry & { sub_reason?: NeedsReviewReason | null };

function resolve(entries: Entry[], critical: Set<string>, facts: Map<string, FactView>, emptyProfileKeys: Set<string>, processing_complete: boolean, favorableRequired: boolean): Resolved {
  if (!processing_complete) return { outcome: 'needs_review', sub_reasons: ['processing_incomplete'], step: 'processing_incomplete' };
  const hard = entries.filter((e) => e.kind === 'hard_stop');
  if (hard.some((e) => e.result === 'yes')) return { outcome: 'do_not_admit', sub_reasons: [], step: 'hard_stop_true' };
  const hardInputsUnknown = hard.some((e) => e.inputs.some((i) => i.presence === 'unknown'));
  const criticalUnknown = [...critical].some((k) => (facts.get(k)?.presence ?? 'unknown') === 'unknown' || facts.get(k)?.conflict);
  if (hardInputsUnknown || criticalUnknown || hard.some((e) => e.result === 'unknown')) return { outcome: 'needs_review', sub_reasons: ['missing_info'], step: 'hard_stop_or_critical_unknown' };
  const review = entries.filter((e) => (e.kind === 'review' || e.kind === 'payer') && e.result === 'yes');
  if (review.length) {
    const reasons = [...new Set(review.map((e) => (e.kind === 'payer' ? 'financial' : (e.sub_reason ?? 'clinical'))))] as NeedsReviewReason[];
    return { outcome: 'needs_review', sub_reasons: reasons, step: 'review_rule_true' };
  }
  const favorable = entries.filter((e) => e.kind === 'favorable');
  const confirmed = entries.some((e) => e.result !== 'unknown' && e.inputs.some((i) => i.presence !== 'unknown' && !i.key.startsWith('facility.')));
  if (favorableRequired ? favorable.some((e) => e.result === 'yes') : confirmed) return { outcome: 'admit', sub_reasons: [], step: 'favorable_rule_true' };
  void emptyProfileKeys;
  return { outcome: 'needs_review', sub_reasons: ['missing_info'], step: 'default_needs_review' };
}

export function evaluate(input: EvaluateInput): Evaluation {
  const rules = input.rules.filter((r) => r.enabled);
  const illegal = rules.filter((r) => r.protected_input && r.kind !== 'review' && !(r.legal_reviewer && typeof r.legal_reviewer === 'object'));
  if (illegal.length) throw new Error(`rule set refused: ${illegal.map((r) => r.id).join(', ')} read a protected input without a legal_reviewer record (SPEC §10.2)`);
  const ctx: Ctx = { facts: viewFacts(input.facts), profile: input.profile, referral_date: input.referral_date, emptyProfileKeys: new Set() };
  const entries: Entry[] = rules.map((r) => ({ ...evaluateRuleWith(r, ctx), sub_reason: r.sub_reason ?? null }));
  const critical = new Set<string>();
  for (const r of rules) if (r.kind === 'hard_stop' || r.kind === 'payer') for (const k of r.inputs) if (!k.startsWith('facility.')) critical.add(k);
  for (const [k, f] of ctx.facts) if (f.critical) critical.add(k);
  const favorableRequired = input.flags?.favorable_rule_required ?? true;

  const merged = resolve(entries, critical, ctx.facts, ctx.emptyProfileKeys, input.processing_complete, favorableRequired);
  const clinical = resolve(entries.filter((e) => e.kind !== 'payer'), new Set([...critical].filter((k) => !rules.some((r) => r.kind === 'payer' && r.inputs.includes(k) && !rules.some((o) => o.kind === 'hard_stop' && o.inputs.includes(k))))), ctx.facts, ctx.emptyProfileKeys, input.processing_complete, favorableRequired);
  const payer = entries.filter((e) => e.kind === 'payer');
  const financial_status: FinancialStatus = payer.some((e) => e.result === 'yes') ? 'hold' : payer.some((e) => e.result === 'unknown') ? 'unknown' : 'clear';

  const missing = [...critical].filter((k) => (ctx.facts.get(k)?.presence ?? 'unknown') === 'unknown').sort();
  const conflicts = [...ctx.facts].filter(([, f]) => f.conflict).map(([k]) => k).sort();
  const reads = new Map<string, number>();
  for (const e of entries) for (const i of e.inputs) if (i.presence === 'unknown' && !i.key.startsWith('facility.')) reads.set(i.key, (reads.get(i.key) ?? 0) + 1);
  const blocking = merged.outcome === 'needs_review' && (merged.step === 'hard_stop_or_critical_unknown' || merged.step === 'default_needs_review')
    ? [...reads].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k)
    : [];

  return {
    outcome: merged.outcome,
    clinical_outcome: clinical.outcome,
    financial_status,
    sub_reasons: merged.sub_reasons,
    resolution_step: merged.step,
    trace: entries.map((e) => ({ rule_id: e.rule_id, kind: e.kind, result: e.result, inputs: e.inputs })),
    missing,
    conflicts,
    blocking,
    empty_profile_keys: [...ctx.emptyProfileKeys].sort(),
    engine_version: ENGINE_VERSION,
  };
}

// ---------- rule tests (§10.4) ----------
export interface RuleTestResult { rule_id: string; name: string; expected: string; actual: TriState; ok: boolean }

const asTri = (r: TriState): 'true' | 'false' | 'unknown' => (r === 'yes' ? 'true' : r === 'no' ? 'false' : 'unknown');

/** Run every rule's own test cases. A case's facts become synthetic user facts (always trusted, no evidence needed). */
export function runRuleTests(rules: readonly Rule[], referral_date = '2001-01-01'): RuleTestResult[] {
  const out: RuleTestResult[] = [];
  for (const rule of rules) {
    for (const t of rule.tests ?? []) {
      const facts: Fact[] = Object.entries(t.facts).map(([key, v]) => ({
        key,
        value: typeof v === 'string' ? { type: 'tri_state', value: v } : v,
        source: 'user', evidence: null, note: 'rule test', as_of_date: null, is_critical: false, specially_protected: false, single_source: false, confidence_band: null,
      }));
      const actual = evaluateRule(rule, facts, t.profile, referral_date).result;
      out.push({ rule_id: rule.id, name: t.name, expected: t.expected, actual, ok: asTri(actual) === t.expected });
    }
  }
  return out;
}

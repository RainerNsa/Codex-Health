// evaluate(): every enabled rule to a tri-state under Kleene logic, then the fixed §4 resolution order
// (SPEC §4, §10.3). Pure: the only inputs are the fact set, the profile, the rules, the referral date and
// the processing flag. The trace carries keys, codes, rule ids and tri-states only.
import { and, not, or } from './kleene.ts';
import { legalReviewerOk, parseExpression, referencedKeys, usesIsUnknown, type Expr, type Cmp } from './dsl.ts';
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
  /** key → tri-state, a full fact value (`{"type":"count","value":3}`), or `{ value, as_of_date }` for recency cases. */
  facts: Readonly<Record<string, TriState | FactValue | { value: TriState | FactValue; as_of_date: string | null }>>;
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
  /** Minimum confirmation set (dev-alignment 2.7, SPEC §4, §10.3): the fact keys a person must confirm before
   *  finalizing the recommended outcome, by outcome:
   *  - admit: every fact read by an enabled hard-stop or review rule, or by a payer rule whose result is known (the
   *    "no" answers that kept them from firing decide an Admit too; an unknown payer rule decides nothing, F8 part 2), every fact read by a favorable rule that fired, every fact flagged critical,
   *    every conflicting fact;
   *  - do_not_admit: the facts read by the hard stops that fired;
   *  - needs_review: the facts read by hard stops and by rules that fired, flagged critical facts, conflicts.
   *  "Read" = declared inputs and the keys in the expression. Never a profile key. Sorted by code. */
  confirmation_set: string[];
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
    // Only a TRUSTED, well-formed assertion is known (I2, §3): a user fact, or an ai fact with verified evidence
    // and not a low confidence band, whose value is a real value of its type. Everything else is silence.
    // A conflict is a disagreement in VALUE between known assertions of one key (§3, §10.2); trust, as_of_date
    // and enum option lists never make one (a reviewer confirming the AI value is a confirmation, not a
    // contradiction). The view never reads a value from an untrusted assertion.
    const known = list.filter((f) => trusted(f) && wellFormed(f.value));
    const canonical = (f: Fact): string => `${f.value.type}|${JSON.stringify(f.value.value)}`;
    const conflict = new Set(known.map(canonical)).size > 1;
    const first = known[0];
    out.set(key, {
      presence: conflict || !first ? 'unknown' : presence(first),
      value: conflict || !first ? null : first.value,
      as_of_date: conflict ? null : (known.map((f) => f.as_of_date).filter(Boolean).sort().at(-1) ?? null),
      conflict,
      critical: list.some((f) => f.is_critical),
      protected: list.some((f) => f.specially_protected),
    });
  }
  return out;
}

const KEY = /^[a-z][a-z0-9_]*$/;
const trusted = (f: Fact): boolean => f.source === 'user' || (f.evidence?.verified === true && (f.confidence_band === 'high' || f.confidence_band === 'medium'));
/** The value is a real value of its declared type (a 'Yes', a string count or an empty text is not). */
function wellFormed(v: FactValue): boolean {
  switch (v.type) {
    case 'tri_state': return v.value === 'yes' || v.value === 'no';
    case 'count': return typeof v.value === 'number' && Number.isFinite(v.value) && v.value >= 0;
    case 'enum': return typeof v.value === 'string' && KEY.test(v.value);
    case 'date': return typeof v.value === 'string' && isRealDate(v.value);
    case 'text': return typeof v.value === 'string' && v.value.trim() !== '';
    case 'medication_list': return Array.isArray(v.value) && v.value.every((m) => !!m && typeof m === 'object' && typeof m.name === 'string');
    default: return false;
  }
}
/** A real calendar date in YYYY-MM-DD, checked without a Date object (no clock, no rollover). */
export function isRealDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return d <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1]!;
}
const daysBetween = (a: string, b: string): number => {
  if (!isRealDate(a) || !isRealDate(b)) return Number.NaN;
  return Math.round((Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10)) - Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10))) / 86_400_000);
};
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
      if (!v || v.type !== 'enum' || !wellFormed(v)) return 'unknown';
      return bool(v.value === e.code);
    }
    case 'fact_cmp': {
      const v = ctx.facts.get(e.key)?.value;
      if (!v || v.type !== 'count' || !wellFormed(v)) return 'unknown';
      return bool(compare(e.cmp, v.value as number, e.number));
    }
    case 'fact_within': {
      const f = ctx.facts.get(e.key);
      if (!f || f.presence === 'unknown' || !f.as_of_date) return 'unknown';
      const d = daysBetween(f.as_of_date, ctx.referral_date);
      if (!Number.isFinite(d) || d < 0) return 'unknown'; // a malformed or post-referral date is silence, never false
      return bool(d <= e.days);
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

const emptyFor = (v: unknown): boolean => !(typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)));
/** What step 3 reads for a fact input: "is this input known?" For tri-state/count/list facts that is the presence;
 *  for enum/date/text facts (no presence) it is whether the typed value is non-null. A conflict is never known. */
function knownness(f: FactView | undefined): TriState {
  if (!f || f.conflict || !f.value) return 'unknown';
  if (f.presence !== 'unknown') return f.presence;
  return (f.value.type === 'enum' || f.value.type === 'date' || f.value.type === 'text') && wellFormed(f.value) ? 'yes' : 'unknown';
}
/** Only a code or a finite number ever reaches the trace; anything else is left out (§10.3). */
function traceValue(f: FactView | undefined): { value?: string | number } {
  const v = f?.value;
  if (!v || f?.conflict) return {};
  if (v.type === 'enum' && typeof v.value === 'string' && KEY.test(v.value)) return { value: v.value };
  if (v.type === 'count' && typeof v.value === 'number' && Number.isFinite(v.value)) return { value: v.value };
  return {};
}

/** One rule against a fact view and profile. Exported for the rule-test runner. */
export function evaluateRule(rule: Rule, facts: readonly Fact[], profile: Profile, referral_date: string): TraceEntry {
  const ctx: Ctx = { facts: viewFacts(facts), profile, referral_date, emptyProfileKeys: new Set() };
  return evaluateRuleWith(rule, ctx);
}

function evaluateRuleWith(rule: Rule, ctx: Ctx): TraceEntry {
  const expr = parseExpression(rule.expression);
  const before = new Set(ctx.emptyProfileKeys);
  const result = evalExpr(expr, ctx);
  const inputs = referencedKeys(expr).map((key) => {
    if (key.startsWith('facility.')) {
      // known iff evaluation could use it: absent, null and wrong-typed keys were all recorded as empty
      const k = key.slice('facility.'.length);
      const known = !ctx.emptyProfileKeys.has(k) || before.has(k) && !emptyFor(ctx.profile[k]);
      const v = ctx.profile[k];
      return { key, presence: known ? 'yes' as const : 'unknown' as const, ...(known && typeof v === 'number' && Number.isFinite(v) ? { value: v } : {}) };
    }
    return { key, presence: knownness(ctx.facts.get(key)), ...traceValue(ctx.facts.get(key)) };
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
  const criticalUnknown = [...critical].some((k) => knownness(facts.get(k)) === 'unknown');
  if (hardInputsUnknown || criticalUnknown || hard.some((e) => e.result === 'unknown')) return { outcome: 'needs_review', sub_reasons: ['missing_info'], step: 'hard_stop_or_critical_unknown' };
  const review = entries.filter((e) => (e.kind === 'review' || e.kind === 'payer') && e.result === 'yes');
  if (review.length) {
    const reasons = [...new Set(review.map((e) => (e.kind === 'payer' ? 'financial' : (e.sub_reason ?? 'clinical'))))] as NeedsReviewReason[];
    return { outcome: 'needs_review', sub_reasons: reasons, step: 'review_rule_true' };
  }
  // §13 row 3 / §10.3: Admit only when something was positively confirmed: a fact input (never a profile key) that is
  // known and feeds a hard-stop rule or a rule that fired. A profile-only favorable rule confirms nothing.
  const confirmed = entries.some((e) => (e.kind === 'hard_stop' || e.result === 'yes') && e.inputs.some((i) => i.presence !== 'unknown' && !i.key.startsWith('facility.')));
  const favorableTrue = entries.some((e) => e.kind === 'favorable' && e.result === 'yes');
  if (confirmed && (favorableRequired ? favorableTrue : true)) return { outcome: 'admit', sub_reasons: [], step: 'favorable_rule_true' };
  void emptyProfileKeys;
  return { outcome: 'needs_review', sub_reasons: ['missing_info'], step: 'default_needs_review' };
}

export function evaluate(input: EvaluateInput): Evaluation {
  if (!isRealDate(input.referral_date)) throw new Error('evaluate: referral_date must be a real YYYY-MM-DD date');
  for (const f of input.facts) {
    if (!KEY.test(f.key)) throw new Error('evaluate: a fact key must be snake_case (SPEC §8)');
    if (!f.value || typeof f.value !== 'object' || typeof f.value.type !== 'string') throw new Error(`evaluate: fact ${f.key} has no typed value`);
  }
  const KINDS = new Set<string>(['hard_stop', 'review', 'favorable', 'payer']);
  for (const r of input.rules) {
    if (typeof r.id !== 'string' || !KINDS.has(r.kind) || !Array.isArray(r.inputs) || !r.inputs.every((k) => typeof k === 'string') || typeof r.expression !== 'string' || typeof r.enabled !== 'boolean') {
      throw new Error(`evaluate: rule ${String(r.id)} is not a rule record`);
    }
  }
  if (new Set(input.rules.map((r) => r.id)).size !== input.rules.length) throw new Error('rule set refused: duplicate rule id');
  const rules = input.rules.filter((r) => r.enabled === true);
  const ctx: Ctx = { facts: viewFacts(input.facts), profile: input.profile, referral_date: input.referral_date, emptyProfileKeys: new Set() };
  // The engine is the trust boundary for rule content, whether or not rule CI ran (§10.2, I10):
  // - a non-review rule over a protected input (declared on the rule, read by its expression, or carried by the
  //   fact) needs a legal_reviewer record;
  // - a non-review rule may not test `is unknown` (silence would become a decision).
  // Either refuses the whole rule set rather than deciding on it.
  const parsed = new Map(rules.map((r) => [r, parseExpression(r.expression)] as const)); // keyed by the record, never by id
  const keysRead = (r: Rule) => new Set([...r.inputs, ...referencedKeys(parsed.get(r)!)]);
  const illegal = rules.filter((r) => r.kind !== 'review' && !legalReviewerOk(r.legal_reviewer)
    && (r.protected_input || [...keysRead(r)].some((k) => ctx.facts.get(k)?.protected)));
  if (illegal.length) throw new Error(`rule set refused: ${illegal.map((r) => r.id).join(', ')} read a protected input without a legal_reviewer record (SPEC §10.2)`);
  const silent = rules.filter((r) => r.kind !== 'review' && usesIsUnknown(parsed.get(r)!));
  if (silent.length) throw new Error(`rule set refused: ${silent.map((r) => r.id).join(', ')} test 'is unknown' outside a review rule (SPEC §10.2)`);
  const entries: Entry[] = rules.map((r) => ({ ...evaluateRuleWith(r, ctx), sub_reason: r.sub_reason ?? null }));
  const critical = new Set<string>();
  for (const r of rules) if (r.kind === 'hard_stop' || r.kind === 'payer') for (const k of r.inputs) if (!k.startsWith('facility.')) critical.add(k);
  const flagged = new Set([...ctx.facts].filter(([, f]) => f.critical).map(([k]) => k));
  for (const k of flagged) critical.add(k);
  const favorableRequired = input.flags?.favorable_rule_required ?? true;

  // The clinical run drops payer rules and the keys that are critical ONLY because a payer rule reads them; a key a
  // hard stop also reads, or one flagged is_critical, stays critical (2.4: the flag may only add).
  const payerOnly = (k: string) => !flagged.has(k) && !rules.some((o) => o.kind === 'hard_stop' && o.inputs.includes(k)) && rules.some((r) => r.kind === 'payer' && r.inputs.includes(k));
  // F8 part 2 (founder ruling 2026-10-29, "financial only"): a payer unknown affects financial_status only; it
  // never blocks the overall answer. Keys critical only because a payer rule reads them leave the step-3 set of the
  // merged run too; a payer rule that FIRES still routes the merged outcome to Needs Review (financial), step 4.
  const merged = resolve(entries, new Set([...critical].filter((k) => !payerOnly(k))), ctx.facts, ctx.emptyProfileKeys, input.processing_complete, favorableRequired);
  const clinical = resolve(entries.filter((e) => e.kind !== 'payer'), new Set([...critical].filter((k) => !payerOnly(k))), ctx.facts, ctx.emptyProfileKeys, input.processing_complete, favorableRequired);
  const payer = entries.filter((e) => e.kind === 'payer');
  const financial_status: FinancialStatus = payer.some((e) => e.result === 'yes') ? 'hold' : payer.some((e) => e.result === 'unknown') ? 'unknown' : 'clear';

  const byCode = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0); // never locale-sensitive (I6)
  const missing = [...critical].filter((k) => knownness(ctx.facts.get(k)) === 'unknown').sort(byCode);
  const conflicts = [...ctx.facts].filter(([, f]) => f.conflict).map(([k]) => k).sort(byCode);
  const reads = new Map<string, number>();
  // payer-only keys never stand between a referral and Admit (F8 part 2), so they are never "confirm first"
  for (const e of entries) for (const i of e.inputs) if (i.presence === 'unknown' && !i.key.startsWith('facility.') && !payerOnly(i.key)) reads.set(i.key, (reads.get(i.key) ?? 0) + 1);
  // "would be Admit if this one were known": only meaningful when nothing else (a true review or payer rule) stands in the way
  const anotherReason = entries.some((e) => (e.kind === 'review' || e.kind === 'payer') && e.result === 'yes');
  const blocking = merged.outcome === 'needs_review' && !anotherReason && (merged.step === 'hard_stop_or_critical_unknown' || merged.step === 'default_needs_review')
    ? [...reads].sort((a, b) => b[1] - a[1] || byCode(a[0], b[0])).map(([k]) => k)
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
    empty_profile_keys: [...ctx.emptyProfileKeys].sort(byCode),
    confirmation_set: confirmationSet(merged.outcome, entries, rules, flagged, conflicts).sort(byCode),
    engine_version: ENGINE_VERSION,
  };
}

function confirmationSet(outcome: Outcome, entries: Entry[], rules: readonly Rule[], flagged: Set<string>, conflicts: string[]): string[] {
  const reads = (id: string) => {
    const r = rules.find((x) => x.id === id)!;
    return [...r.inputs, ...(entries.find((e) => e.rule_id === id)?.inputs.map((i) => i.key) ?? [])];
  };
  const pick = (keep: (e: Entry) => boolean) => entries.filter(keep).flatMap((e) => reads(e.rule_id));
  const keys = outcome === 'do_not_admit'
    ? pick((e) => e.kind === 'hard_stop' && e.result === 'yes')
    : outcome === 'admit'
      // a payer rule whose result is unknown decides nothing about an Admit (F8 part 2), so it asks for nothing
      ? [...pick((e) => (e.kind !== 'favorable' && !(e.kind === 'payer' && e.result === 'unknown')) || e.result === 'yes'), ...flagged, ...conflicts]
      : [...pick((e) => e.kind === 'hard_stop' || e.result === 'yes'), ...flagged, ...conflicts];
  return [...new Set(keys.filter((k) => !k.startsWith('facility.')))];
}

// ---------- rule tests (§10.4) ----------
export interface RuleTestResult { rule_id: string; name: string; expected: string; actual: TriState; ok: boolean }

const asTri = (r: TriState): 'true' | 'false' | 'unknown' => (r === 'yes' ? 'true' : r === 'no' ? 'false' : 'unknown');

/** Run every rule's own test cases. A case's facts become synthetic user facts (always trusted, no evidence needed). */
export function runRuleTests(rules: readonly Rule[], referral_date = '2001-01-01'): RuleTestResult[] {
  const out: RuleTestResult[] = [];
  for (const rule of rules) {
    for (const t of rule.tests ?? []) {
      const facts: Fact[] = Object.entries(t.facts).map(([key, v]) => {
        const isWrapped = (x: unknown): x is { value: TriState | FactValue; as_of_date: string | null } => typeof x === 'object' && x !== null && 'as_of_date' in x && !('type' in x);
        const wrapped = isWrapped(v) ? v : { value: v as TriState | FactValue, as_of_date: null };
        const value: FactValue = typeof wrapped.value === 'string' ? { type: 'tri_state', value: wrapped.value } : wrapped.value;
        return { key, value, source: 'user', evidence: null, note: 'rule test', as_of_date: wrapped.as_of_date, is_critical: false, specially_protected: false, single_source: false, confidence_band: null };
      });
      const actual = evaluateRule(rule, facts, t.profile, referral_date).result;
      out.push({ rule_id: rule.id, name: t.name, expected: t.expected, actual, ok: asTri(actual) === t.expected });
    }
  }
  return out;
}

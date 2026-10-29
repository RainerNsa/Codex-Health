// The rules DSL (SPEC §10.1): tokenizer, recursive-descent parser and static checks. No evaluation here.
export type Cmp = '=' | '!=' | '<' | '<=' | '>' | '>=';
export type Expr =
  | { op: 'and'; left: Expr; right: Expr }
  | { op: 'or'; left: Expr; right: Expr }
  | { op: 'not'; expr: Expr }
  | { op: 'fact_is'; key: string; value: 'yes' | 'no' | 'unknown' }
  | { op: 'fact_is_code'; key: string; code: string }
  | { op: 'fact_cmp'; key: string; cmp: Cmp; number: number }
  | { op: 'fact_within'; key: string; days: number }
  | { op: 'profile_is'; key: string; value: boolean }
  | { op: 'profile_cmp'; key: string; cmp: Cmp; number: number };

type Token = { kind: 'word' | 'op' | 'num' | 'lparen' | 'rparen'; text: string; at: number };

const TRI = new Set(['yes', 'no', 'unknown']);
const CMPS: readonly Cmp[] = ['<=', '>=', '!=', '=', '<', '>'];

export class DslError extends Error {
  readonly at: number;
  constructor(message: string, at: number) {
    super(`${message} (at ${at})`);
    this.at = at;
  }
}

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n') { i += 1; continue; }
    if (ch === '(') { out.push({ kind: 'lparen', text: ch, at: i }); i += 1; continue; }
    if (ch === ')') { out.push({ kind: 'rparen', text: ch, at: i }); i += 1; continue; }
    const cmp = CMPS.find((c) => src.startsWith(c, i));
    if (cmp) { out.push({ kind: 'op', text: cmp, at: i }); i += cmp.length; continue; }
    const num = /^[0-9]+(\.[0-9]+)?/.exec(src.slice(i));
    if (num) { out.push({ kind: 'num', text: num[0], at: i }); i += num[0].length; continue; }
    const word = /^[A-Za-z][A-Za-z0-9_.]*/.exec(src.slice(i));
    if (word) { out.push({ kind: 'word', text: word[0], at: i }); i += word[0].length; continue; }
    throw new DslError(`unexpected character '${ch}'`, i);
  }
  return out;
}

/** Parse one expression. Throws DslError on anything the grammar does not admit. */
export function parseExpression(src: string): Expr {
  const toks = tokenize(src);
  let pos = 0;
  const peek = () => toks[pos];
  const take = () => { const t = toks[pos]; if (!t) throw new DslError('unexpected end of expression', src.length); pos += 1; return t; };
  const expectWord = (w: string) => { const t = take(); if (t.kind !== 'word' || t.text !== w) throw new DslError(`expected '${w}'`, t.at); };
  const RESERVED = new Set(['is', 'within', 'days', 'yes', 'no', 'unknown', 'true', 'false']);
  const isKey = (t: string) => /^[a-z][a-z0-9_]*$/.test(t) && !RESERVED.has(t);
  let depth = 0;
  const isProfile = (t: string) => /^facility\.[a-z][a-z0-9_]*$/.test(t);

  const or = (): Expr => { let left = and(); while (peek()?.kind === 'word' && peek()!.text === 'OR') { take(); left = { op: 'or', left, right: and() }; } return left; };
  const and = (): Expr => { let left = not(); while (peek()?.kind === 'word' && peek()!.text === 'AND') { take(); left = { op: 'and', left, right: not() }; } return left; };
  const not = (): Expr => { if (peek()?.kind === 'word' && peek()!.text === 'NOT') { take(); return { op: 'not', expr: not() }; } return atom(); };
  const atom = (): Expr => {
    const t = take();
    if (t.kind === 'lparen') {
      if ((depth += 1) > 64) throw new DslError('expression nests deeper than 64 parentheses', t.at);
      const e = or(); const r = take(); if (r.kind !== 'rparen') throw new DslError("expected ')'", r.at);
      depth -= 1;
      return e;
    }
    if (t.kind !== 'word') throw new DslError('expected a fact or facility key', t.at);
    if (isProfile(t.text)) {
      const key = t.text.slice('facility.'.length);
      const n = take();
      if (n.kind === 'word' && n.text === 'is') {
        const v = take();
        if (v.kind !== 'word' || (v.text !== 'true' && v.text !== 'false')) throw new DslError("a facility key is tested with 'is true' or 'is false'", v.at);
        return { op: 'profile_is', key, value: v.text === 'true' };
      }
      if (n.kind === 'op') { const num = take(); if (num.kind !== 'num') throw new DslError('expected a number', num.at); return { op: 'profile_cmp', key, cmp: n.text as Cmp, number: Number(num.text) }; }
      throw new DslError("expected 'is' or a comparison", n.at);
    }
    if (!isKey(t.text)) throw new DslError(`'${t.text}' is not a fact key`, t.at);
    const key = t.text;
    const n = take();
    if (n.kind === 'word' && n.text === 'is') {
      const v = take();
      if (v.kind !== 'word') throw new DslError("expected yes, no, unknown or an enum code after 'is'", v.at);
      if (TRI.has(v.text)) return { op: 'fact_is', key, value: v.text as 'yes' | 'no' | 'unknown' };
      if (!isKey(v.text)) throw new DslError(`'${v.text}' is not an enum code`, v.at);
      return { op: 'fact_is_code', key, code: v.text };
    }
    if (n.kind === 'word' && n.text === 'within') {
      const num = take(); if (num.kind !== 'num' || !/^[0-9]+$/.test(num.text)) throw new DslError('expected a whole number of days', num.at);
      expectWord('days');
      return { op: 'fact_within', key, days: Number(num.text) };
    }
    if (n.kind === 'op') { const num = take(); if (num.kind !== 'num') throw new DslError('expected a number', num.at); return { op: 'fact_cmp', key, cmp: n.text as Cmp, number: Number(num.text) }; }
    throw new DslError("expected 'is', 'within' or a comparison", n.at);
  };
  const e = or();
  const rest = peek();
  if (rest) throw new DslError(`unexpected '${rest.text}'`, rest.at);
  return e;
}

/** Every key an expression reads: fact keys as-is, profile keys as `facility.<key>`. */
export function referencedKeys(e: Expr): string[] {
  switch (e.op) {
    case 'and': case 'or': return [...new Set([...referencedKeys(e.left), ...referencedKeys(e.right)])];
    case 'not': return referencedKeys(e.expr);
    case 'profile_is': case 'profile_cmp': return [`facility.${e.key}`];
    default: return [e.key];
  }
}

export const usesIsUnknown = (e: Expr): boolean =>
  e.op === 'and' || e.op === 'or' ? usesIsUnknown(e.left) || usesIsUnknown(e.right)
    : e.op === 'not' ? usesIsUnknown(e.expr)
      : e.op === 'fact_is' && e.value === 'unknown';

export interface RuleLike {
  id: string;
  kind: 'hard_stop' | 'review' | 'favorable' | 'payer';
  inputs: readonly string[];
  expression: string;
  protected_input?: boolean;
  legal_reviewer?: unknown;
  tests?: readonly { expected: string }[];
}

/** A legal_reviewer record is an object with the four non-blank fields rule.v0 requires. */
export const legalReviewerOk = (r: unknown): boolean =>
  !!r && typeof r === 'object' && !Array.isArray(r)
  && ['name', 'firm', 'date', 'memo_ref'].every((k) => typeof (r as Record<string, unknown>)[k] === 'string' && ((r as Record<string, string>)[k] ?? '').trim() !== '');

/** Static checks rule CI applies before any evaluation (SPEC §10.1, §10.2). Returns problems; empty means clean. */
export function lintRule(rule: RuleLike): string[] {
  const problems: string[] = [];
  let expr: Expr;
  try { expr = parseExpression(rule.expression); } catch (err) { return [`${rule.id}: ${(err as Error).message}`]; }
  for (const key of referencedKeys(expr)) if (!rule.inputs.includes(key)) problems.push(`${rule.id}: reads '${key}' which is not declared in inputs`);
  for (const key of rule.inputs) if (!referencedKeys(expr).includes(key)) problems.push(`${rule.id}: declares input '${key}' which the expression never reads`);
  if (usesIsUnknown(expr) && rule.kind !== 'review') problems.push(`${rule.id}: 'is unknown' is permitted only in review rules (a ${rule.kind} rule firing on silence would decide on Unknown)`);
  if (rule.protected_input && rule.kind !== 'review' && !legalReviewerOk(rule.legal_reviewer)) problems.push(`${rule.id}: a ${rule.kind} rule over a protected input needs a legal_reviewer record`);
  // CONSTRAINTS §4.2: every rule carries a True, a False and an Unknown case
  const expected = new Set((rule.tests ?? []).map((t) => t.expected));
  for (const e of ['true', 'false', 'unknown']) if (!expected.has(e)) problems.push(`${rule.id}: no test case with expected '${e}'`);
  return problems;
}

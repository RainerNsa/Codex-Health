// The value type each fact key must carry, from how the rules read it (SPEC §10.2), and the parser that enforces it.
// Shared by the API (manual entry) and the worker (extraction), so both accept exactly the same values.
import { parseExpression, type Expr } from './dsl.ts';
import type { FactValue } from './types.ts';

export type KeyType = 'tri_state' | 'count' | 'enum';

/** Key to type, over these rule expressions. Throws when one key is read two ways. */
export function keyTypes(expressions: string[]): Map<string, KeyType> {
  const types = new Map<string, KeyType>();
  const walk = (e: Expr): void => {
    if (e.op === 'and' || e.op === 'or') { walk(e.left); walk(e.right); return; }
    if (e.op === 'not') { walk(e.expr); return; }
    const t = e.op === 'fact_is' || e.op === 'fact_within' ? 'tri_state' : e.op === 'fact_cmp' ? 'count' : e.op === 'fact_is_code' ? 'enum' : null;
    if (!t) return;
    const seen = types.get(e.key);
    if (seen && seen !== t) throw new Error(`rule set refused: fact ${e.key} is read as both ${seen} and ${t}`);
    types.set(e.key, t);
  };
  for (const x of expressions) walk(parseExpression(x));
  return types;
}

/** A clean value of this type, rebuilt so nothing extra survives, or null when the input is not one. */
export function parseFactValue(v: unknown, type: KeyType): FactValue | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as { type?: unknown; value?: unknown };
  if (o.type !== type) return null;
  if (type === 'tri_state' && (o.value === 'yes' || o.value === 'no' || o.value === 'unknown')) return { type: 'tri_state', value: o.value };
  if (type === 'count' && (o.value === null || (Number.isInteger(o.value) && (o.value as number) >= 0 && (o.value as number) <= 100000))) return { type: 'count', value: o.value as number | null };
  if (type === 'enum' && (o.value === null || (typeof o.value === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(o.value)))) return { type: 'enum', value: o.value as string | null };
  return null;
}

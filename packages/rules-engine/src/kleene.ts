// Three-valued (Kleene) connectives (SPEC §3, §10.2). unknown never collapses to true or false.
import type { TriState } from './types.ts';

export const and = (a: TriState, b: TriState): TriState =>
  a === 'no' || b === 'no' ? 'no' : a === 'unknown' || b === 'unknown' ? 'unknown' : 'yes';
export const or = (a: TriState, b: TriState): TriState =>
  a === 'yes' || b === 'yes' ? 'yes' : a === 'unknown' || b === 'unknown' ? 'unknown' : 'no';
export const not = (a: TriState): TriState => (a === 'unknown' ? 'unknown' : a === 'yes' ? 'no' : 'yes');

// Quote verification (I2): an AI fact counts only if its quote is on the page it names, as whole words, long enough
// to mean something. M4 normalises line breaks, hyphenation, punctuation, spacing and case, enough for clean
// generator output (SPEC §13 row 9).
// shortcut: exact match after normalising; OCR-tolerant bounded fuzzy matching arrives with the 5.6 spec at M5.
import type { FactValue } from '@codex-health/rules-engine';

const MIN_WORDS = 3;
// Pipeline contract (§8): a No, a 0 or an empty list comes only from an explicit negation on the page.
const NEGATION = /\b(no|not|none|never|without|denies|denied|negative|absent)\b/;

export const normalise = (text: string): string =>
  text.normalize('NFKC').replace(/-\s*\n\s*/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export function verifyQuote(quote: string, pageText: string): boolean {
  const q = normalise(quote);
  return q.split(' ').length >= MIN_WORDS && ` ${normalise(pageText)} `.includes(` ${q} `);
}

export const isNegative = (v: FactValue): boolean => v.value === 'no' || v.value === 0 || (Array.isArray(v.value) && v.value.length === 0);

/** The quote is on the page and, for a negative value, says so. */
export function verifyEvidence(value: FactValue, quote: string, pageText: string): boolean {
  return verifyQuote(quote, pageText) && (!isNegative(value) || NEGATION.test(normalise(quote)));
}

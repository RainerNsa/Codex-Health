// Quote verification (I2): an AI fact counts only if its quote is on the page it names. M4 normalises line breaks,
// hyphenation, whitespace and case, which is enough for clean generator output (SPEC §13 row 9).
// shortcut: exact match after normalising; OCR-tolerant bounded fuzzy matching arrives with the 5.6 spec at M5.
export const normalise = (text: string): string =>
  text.normalize('NFKC').replace(/-\s*\n\s*/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

export function verifyQuote(quote: string, pageText: string): boolean {
  const q = normalise(quote);
  return q.length > 0 && normalise(pageText).includes(q);
}

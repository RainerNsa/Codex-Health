import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyEvidence, verifyQuote } from '../src/verify.ts';

test('a quote verifies across line breaks, hyphenation, spacing and case, and only if it is on the page', () => {
  const page = 'Patient is NOT on a venti-\nlator.   Room\nair since 03/02.';
  assert.equal(verifyQuote('not on a ventilator', page), true);
  assert.equal(verifyQuote('room air since 03/02', page), true);
  assert.equal(verifyQuote('on a ventilator since 03/02', page), false);
  assert.equal(verifyQuote('   ', page), false);
  assert.equal(verifyQuote('anything', ''), false);
});

test('a trivial quote never verifies: at least three words, whole words only', () => {
  const page = 'ZZTEST was on a ventilator';
  assert.equal(verifyQuote('a', page), false);
  assert.equal(verifyQuote('ventilator', page), false);
  assert.equal(verifyQuote('on a vent', page), false); // not a whole word
  assert.equal(verifyQuote('on a ventilator', page), true);
});

test('a negative value needs an explicit negation in the quote (§8)', () => {
  const page = 'Patient is not on a ventilator. Patient walks with a frame.';
  const no = { type: 'tri_state', value: 'no' } as const;
  assert.equal(verifyEvidence(no, 'not on a ventilator', page), true);
  assert.equal(verifyEvidence(no, 'walks with a frame', page), false);
  assert.equal(verifyEvidence({ type: 'count', value: 0 }, 'walks with a frame', page), false);
  assert.equal(verifyEvidence({ type: 'tri_state', value: 'yes' }, 'walks with a frame', page), true);
});

test('NFKC folds ligatures and full-width characters', () => {
  assert.equal(verifyQuote('stable on ﬁrst dose', 'stable on first dose'), true);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyQuote } from '../src/verify.ts';

test('a quote verifies across line breaks, hyphenation, spacing and case, and only if it is on the page', () => {
  const page = 'Patient is NOT on a venti-\nlator.   Room\nair since 03/02.';
  assert.equal(verifyQuote('not on a ventilator', page), true);
  assert.equal(verifyQuote('room air since 03/02', page), true);
  assert.equal(verifyQuote('on a ventilator since 03/02', page), false);
  assert.equal(verifyQuote('   ', page), false);
  assert.equal(verifyQuote('anything', ''), false);
});

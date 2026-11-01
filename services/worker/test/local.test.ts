import assert from 'node:assert/strict';
import test from 'node:test';
import { localExtract, localMode, tesseractOcr } from '../src/local.ts';
import { verifyEvidence } from '../src/verify.ts';

const pages = (text: string) => [{ document_id: 'd', pages: [{ page: 1, text }] }];
const types = new Map([['ventilator_use', 'tri_state' as const]]);

test('a stand-in runs only when asked for, and only in development', () => {
  assert.equal(localMode({}), false);
  assert.equal(localMode({ LOCAL_PIPELINE: '1', CODEX_ENV: 'development' }), true);
  for (const CODEX_ENV of ['demo', 'test', 'prod', undefined]) assert.throws(() => localMode({ LOCAL_PIPELINE: '1', CODEX_ENV }), /refused/);
});

test('a line naming the key gives a low-confidence fact whose quote verifies', async () => {
  const [fact] = await localExtract(pages('Header\nPatient remains on ventilator overnight\n'), ['ventilator_use'], types);
  assert.deepEqual(fact?.value, { type: 'tri_state', value: 'yes' });
  assert.equal(fact?.confidence_band, 'low');
  assert.equal(verifyEvidence(fact!.value, fact!.quote, 'Header\nPatient remains on ventilator overnight\n'), true);
});

test('no comes only from a negation on the line; silence stays silent', async () => {
  const [fact] = await localExtract(pages('Patient is not on a ventilator'), ['ventilator_use'], types);
  assert.equal(fact?.value.value, 'no');
  assert.deepEqual(await localExtract(pages('Breathing unaided on room air today'), ['ventilator_use'], types), []);
  assert.deepEqual(await localExtract(pages('ventilator'), ['ventilator_use'], types), [], 'too short to verify');
});

test('facts that are not tri_state are left to a person', async () => {
  assert.deepEqual(await localExtract(pages('ventilator count is two here'), ['ventilator_use'], new Map([['ventilator_use', 'count' as const]])), []);
});

test('OCR reads stored page images until they run out, and an outage is not an end of pages', async () => {
  const body = { transformToByteArray: async () => new Uint8Array([1]) };
  let calls = 0;
  const send = async () => {
    if (++calls > 2) throw Object.assign(new Error('x'), { name: 'NoSuchKey' });
    return { Body: body };
  };
  const doc = { id: 'd', storage_key: 'documents/f/r/a.pdf' };
  assert.deepEqual(await tesseractOcr(send, 'b', async () => 'text')(doc), [{ page: 1, text: 'text' }, { page: 2, text: 'text' }]);
  await assert.rejects(tesseractOcr(async () => { throw new Error('down'); }, 'b', async () => '')(doc), /down/);
});

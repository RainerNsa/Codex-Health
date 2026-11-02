import assert from 'node:assert/strict';
import test from 'node:test';
import { localExtract, localMode, tesseractOcr } from '../src/local.ts';
import { verifyEvidence } from '../src/verify.ts';

const pages = (text: string) => [{ document_id: 'd', pages: [{ page: 1, text }] }];
const types = new Map([['ventilator_use', 'tri_state' as const]]);

test('a stand-in runs only when asked for, and only in development', () => {
  assert.equal(localMode({}), false);
  const here = { LOCAL_PIPELINE: '1', CODEX_ENV: 'development', AWS_ENDPOINT_URL: 'http://127.0.0.1:4566' };
  assert.equal(localMode(here), true);
  for (const CODEX_ENV of ['demo', 'test', 'prod', undefined]) assert.throws(() => localMode({ ...here, CODEX_ENV }), /refused/);
  for (const AWS_ENDPOINT_URL of [undefined, '', 'https://example.invalid', 'http://127.0.0.1:4566.example.invalid']) assert.throws(() => localMode({ ...here, AWS_ENDPOINT_URL }), /refused/);
  assert.throws(() => localMode({ ...here, LOCAL_PIPELINE: '0' }), /refused/);
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

test('a negation counts only in the clause naming the key, and what ends a treatment is a no', async () => {
  const value = async (text: string) => (await localExtract(pages(text), ['ventilator_use'], types))[0]?.value.value;
  assert.equal(await value('No fever, remains on ventilator'), 'yes');
  assert.equal(await value("Patient isn't on a ventilator"), 'no');
  assert.equal(await value('Ventilator weaned and discontinued'), 'no');
  assert.equal(await value('Patient is ventilator-free now'), 'no');
});

test('every telling word of a key must appear, as a whole word', async () => {
  const both = new Map([['recent_aggression', 'tri_state' as const], ['daily_skilled_need', 'tri_state' as const]]);
  assert.deepEqual(await localExtract(pages('Recent labs were reviewed'), ['recent_aggression'], both), []);
  assert.deepEqual(await localExtract(pages('RE: Skilled nursing referral'), ['daily_skilled_need'], both), []);
  assert.deepEqual(await localExtract(pages('Patient has ventilatory failure today'), ['ventilator_use'], types), []);
  assert.equal((await localExtract(pages('Verbal aggression toward staff'), ['recent_aggression'], both)).length, 1);
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
  let n = 0;
  await assert.rejects(tesseractOcr(async () => { if (++n > 1) throw new Error('down'); return { Body: body }; }, 'b', async () => 'text')(doc), /down/, 'a later page failing keeps no partial document');
  const failing = async () => { throw new Error('ocr did not succeed'); };
  await assert.rejects(tesseractOcr(async () => ({ Body: body }), 'b', failing)(doc), /did not succeed/);
  assert.deepEqual(await tesseractOcr(async () => { throw Object.assign(new Error('x'), { name: 'NoSuchKey' }); }, 'b', failing)(doc), [], 'no images, no text');
});

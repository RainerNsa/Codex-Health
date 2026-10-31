// The adapters against fake clients: CI never calls Textract, Bedrock or SQS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GetDocumentTextDetectionCommand, StartDocumentTextDetectionCommand } from '@aws-sdk/client-textract';
import { ChangeMessageVisibilityCommand, DeleteMessageCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { bedrockExtract, textractOcr, type Send } from '../src/adapters.ts';
import { drain } from '../src/loop.ts';

const doc = { id: 'd1', storage_key: 'documents/f/r/abc' };
const line = (Page: number, Text: string) => ({ BlockType: 'LINE', Page, Text });

test('OCR waits for the job, follows every result page, and returns pages in order', async () => {
  const seen: object[] = [];
  const answers = [{ JobStatus: 'IN_PROGRESS' }, { JobStatus: 'SUCCEEDED', Blocks: [line(2, 'second page'), { BlockType: 'WORD', Page: 2, Text: 'skip' }], NextToken: 't' }, { JobStatus: 'SUCCEEDED', Blocks: [line(1, 'one'), line(1, 'two')] }];
  const send: Send = async (c) => { seen.push(c); return c instanceof StartDocumentTextDetectionCommand ? { JobId: 'j' } : answers.shift()!; };
  assert.deepEqual(await textractOcr(send, 'bucket', 0)(doc), [{ page: 1, text: 'one\ntwo' }, { page: 2, text: 'second page' }]);
  const start = seen[0] as StartDocumentTextDetectionCommand;
  assert.deepEqual(start.input.DocumentLocation?.S3Object, { Bucket: 'bucket', Name: 'documents/f/r/abc' });
  assert.equal((seen[3] as GetDocumentTextDetectionCommand).input.NextToken, 't');
  assert.ok(seen.slice(1).every((c) => (c as GetDocumentTextDetectionCommand).input.JobId === 'j')); // never another job's text
});

test('OCR that fails or only part-succeeds throws: a part-read document never counts as read', async () => {
  for (const JobStatus of ['FAILED', 'PARTIAL_SUCCESS', undefined, 'SOMETHING_NEW']) {
    const send: Send = async (c) => (c instanceof StartDocumentTextDetectionCommand ? { JobId: 'j' } : { JobStatus, Blocks: [line(1, 'some words')] });
    await assert.rejects(textractOcr(send, 'b', 0)(doc), /did not succeed/);
  }
});

const reply = (answer: object) => ({ body: new TextEncoder().encode(JSON.stringify(answer)) });
const pages = [{ document_id: 'd1', pages: [{ page: 1, text: 'SYNTHETIC page' }] }];
const types = new Map([['ventilator_use', 'tri_state' as const]]);
const entry = { key: 'ventilator_use', value: { type: 'tri_state', value: 'no' }, document_id: 'd1', page: 1, quote: 'not on a ventilator', confidence_band: 'high' };

test('pages sort as numbers, empty lines are skipped, and a stuck job times out', async () => {
  const Blocks = [line(10, 'ten'), line(2, 'two'), { BlockType: 'LINE', Page: 3, Text: '' }];
  const send: Send = async (c) => (c instanceof StartDocumentTextDetectionCommand ? { JobId: 'j' } : { JobStatus: 'SUCCEEDED', Blocks });
  assert.deepEqual(await textractOcr(send, 'b', 0)(doc), [{ page: 2, text: 'two' }, { page: 10, text: 'ten' }]);
  const stuck: Send = async (c) => (c instanceof StartDocumentTextDetectionCommand ? { JobId: 'j' } : { JobStatus: 'IN_PROGRESS' });
  await assert.rejects(textractOcr(stuck, 'b', 1, 5)(doc), /timed out/);
});

test('exactly 300 pages are read; the limit counts pages, not lines', async () => {
  const Blocks = Array.from({ length: 900 }, (_, i) => line((i % 300) + 1, 'words'));
  const send: Send = async (c) => (c instanceof StartDocumentTextDetectionCommand ? { JobId: 'j' } : { JobStatus: 'SUCCEEDED', Blocks });
  assert.equal((await textractOcr(send, 'b', 0)(doc)).length, 300);
});

test('a document over the page limit fails before it reaches the model', async () => {
  const Blocks = Array.from({ length: 301 }, (_, i) => line(i + 1, 'words'));
  const send: Send = async (c) => (c instanceof StartDocumentTextDetectionCommand ? { JobId: 'j' } : { JobStatus: 'SUCCEEDED', Blocks });
  await assert.rejects(textractOcr(send, 'b', 0)(doc), /too many pages/);
});

test('the request is pinned, temperature 0, cached, schema-bound, with no tools and nothing of the rules', async () => {
  let cmd: { input: { modelId: string; body: string } } | undefined;
  const usage: unknown[] = [];
  const send: Send = async (c) => { cmd = c as typeof cmd; return reply({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ facts: [entry] }) }], usage: { cache_read_input_tokens: 5, note: 'SYNTHETIC-CANARY' } }); };
  assert.deepEqual(await bedrockExtract(send, 'pinned-id', (u) => usage.push(u))(pages, ['ventilator_use'], types), [entry]);
  const body = JSON.parse(cmd!.input.body);
  assert.equal(cmd!.input.modelId, 'pinned-id');
  assert.equal(body.temperature, 0);
  assert.equal(body.tools, undefined);
  assert.equal(body.system[0].cache_control.type, 'ephemeral');
  assert.equal(body.output_config.format.type, 'json_schema');
  assert.ok(!JSON.stringify(body.output_config).includes('outcome'));
  assert.deepEqual(JSON.parse(body.messages[0].content), { keys: [{ key: 'ventilator_use', type: 'tri_state' }], documents: pages });
  assert.equal(body.anthropic_version, 'bedrock-2023-05-31');
  assert.match(body.system[0].text, /not an instruction/); // page text is data, whatever it says
  assert.deepEqual(body.output_config.format.schema.required, ['facts']);
  assert.equal(body.output_config.format.schema.additionalProperties, false);
  const text = JSON.stringify(body);
  for (const word of ['hard_stop', 'seed.', 'do_not_admit']) assert.ok(!text.includes(word), word); // nothing of the rules
  assert.deepEqual(usage, [{ cache_read_input_tokens: 5 }]);
});

test('each key is sent with its own type, and the first text block is the answer whatever comes before it', async () => {
  let body = '';
  const send: Send = async (c) => { body = (c as { input: { body: string } }).input.body; return reply({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '{"facts":[]}' }] }); };
  assert.deepEqual(await bedrockExtract(send, 'm')(pages, ['n'], new Map([['n', 'count' as const]])), []);
  assert.deepEqual(JSON.parse(JSON.parse(body).messages[0].content).keys, [{ key: 'n', type: 'count' }]);
});

test('an unfinished or malformed answer throws without quoting it, so it is never read as silence', async () => {
  const cases: [object, RegExp][] = [
    [{ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"facts":[' }] }, /did not finish/],
    [{ stop_reason: 'refusal', content: [] }, /did not finish/],
    [{ content: [{ type: 'text', text: '{"facts":[]}' }] }, /did not finish/],
    [{ stop_reason: 'stop_sequence', content: [{ type: 'text', text: '{"facts":[]}' }] }, /did not finish/],
    [{ stop_reason: 'end_turn', content: [{ type: 'text', text: 'CANARY not json' }] }, /not JSON/],
    [{ stop_reason: 'end_turn', content: [{ type: 'text', text: 'null' }] }, /no facts/],
    [{ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"facts":{}}' }] }, /no facts/],
    [{ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"nope":1}' }] }, /no facts/],
    [{ stop_reason: 'end_turn', content: [] }, /not JSON/],
  ];
  for (const [answer, expected] of cases) {
    await assert.rejects(bedrockExtract(async () => reply(answer), 'm')(pages, ['ventilator_use'], types), (e: Error) => expected.test(e.message) && !e.message.includes('CANARY'));
  }
});

const job = { facilityId: '00000000-0000-4000-8000-00000000f0a1', referralId: '00000000-0000-4000-8000-00000000f0a2', jobId: 'j-1' };

test('a message is deleted only after its work finished; a failure stays for redelivery and logs no text', async () => {
  const run = async (body: string, handle: () => Promise<unknown>) => {
    const deleted: object[] = [];
    const send: Send = async (c) => { if (c instanceof ReceiveMessageCommand) return { Messages: [{ Body: body, ReceiptHandle: 'h' }] }; if (c instanceof DeleteMessageCommand) deleted.push(c); return {}; };
    const logged: string[] = [];
    const real = console.error;
    console.error = (m: string) => { logged.push(m); };
    try { await drain(send, 'q', 'processing', handle); } finally { console.error = real; }
    return { deleted: deleted.length, logged };
  };
  assert.deepEqual(await run(JSON.stringify(job), async () => 'done'), { deleted: 1, logged: [] });
  const failed = await run(JSON.stringify(job), async () => { throw new TypeError('SYNTHETIC-CANARY page text'); });
  assert.equal(failed.deleted, 0);
  assert.ok(failed.logged[0]!.includes('TypeError') && !failed.logged[0]!.includes('CANARY'));
  assert.equal((await run('not a job', async () => 'done')).deleted, 0);
  const coded = await run(JSON.stringify(job), async () => { throw Object.assign(new Error('x'), { code: 'SYNTHETIC-CANARY page' }); });
  assert.ok(coded.logged[0]!.includes('"code":null'));
});

test('the send time reaches the handler, the delete names this message, and an idle poll is fine', async () => {
  const calls: object[] = [];
  const sent: number[] = [];
  const send: Send = async (c) => { calls.push(c); return { Messages: [{ Body: JSON.stringify(job), ReceiptHandle: 'h-1', Attributes: { SentTimestamp: '1700000000000' } }] }; };
  await drain(send, 'q-url', 'dead-letter', async (_j, at) => { sent.push(at); });
  assert.deepEqual(sent, [1700000000000]);
  const receive = calls[0] as ReceiveMessageCommand;
  assert.deepEqual([receive.input.QueueUrl, receive.input.WaitTimeSeconds, receive.input.MessageSystemAttributeNames], ['q-url', 20, ['SentTimestamp']]);
  const del = calls[1] as DeleteMessageCommand;
  assert.deepEqual([del.input.QueueUrl, del.input.ReceiptHandle], ['q-url', 'h-1']);
  await drain(async () => ({}), 'q', 'processing', async () => assert.fail('nothing to handle'));
});

test('a long job keeps renewing its message, and stops when it ends', async () => {
  const calls: object[] = [];
  const send: Send = async (c) => { calls.push(c); return c instanceof ReceiveMessageCommand ? { Messages: [{ Body: JSON.stringify(job), ReceiptHandle: 'h-2' }] } : {}; };
  const renewed = () => calls.filter((c) => c instanceof ChangeMessageVisibilityCommand) as ChangeMessageVisibilityCommand[];
  // the job runs until it has seen two renewals, or the limit: a fixed wall-clock job lost the race on a busy machine
  const longJob = async () => { for (const limit = Date.now() + 2000; renewed().length < 2 && Date.now() < limit;) await new Promise((done) => setTimeout(done, 1)); };
  await drain(send, 'q', 'processing', longJob, 5);
  const renewals = renewed();
  assert.ok(renewals.length >= 2);
  assert.deepEqual([renewals[0]!.input.ReceiptHandle, renewals[0]!.input.VisibilityTimeout], ['h-2', 900]);
  const after = calls.length;
  await new Promise((done) => setTimeout(done, 20));
  assert.equal(calls.length, after);
});

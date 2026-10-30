// The adapters against fake clients: CI never calls Textract, Bedrock or SQS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GetDocumentTextDetectionCommand, StartDocumentTextDetectionCommand } from '@aws-sdk/client-textract';
import { DeleteMessageCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';
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
});

test('OCR that fails or only part-succeeds throws: a part-read document never counts as read', async () => {
  for (const JobStatus of ['FAILED', 'PARTIAL_SUCCESS']) {
    const send: Send = async (c) => (c instanceof StartDocumentTextDetectionCommand ? { JobId: 'j' } : { JobStatus, Blocks: [line(1, 'some words')] });
    await assert.rejects(textractOcr(send, 'b', 0)(doc), /did not succeed/);
  }
});

const reply = (answer: object) => ({ body: new TextEncoder().encode(JSON.stringify(answer)) });
const pages = [{ document_id: 'd1', pages: [{ page: 1, text: 'SYNTHETIC page' }] }];
const types = new Map([['ventilator_use', 'tri_state' as const]]);
const entry = { key: 'ventilator_use', value: { type: 'tri_state', value: 'no' }, document_id: 'd1', page: 1, quote: 'not on a ventilator', confidence_band: 'high' };

test('the request is pinned, temperature 0, cached, schema-bound, with no tools and nothing of the rules', async () => {
  let cmd: { input: { modelId: string; body: string } } | undefined;
  const usage: unknown[] = [];
  const send: Send = async (c) => { cmd = c as typeof cmd; return reply({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ facts: [entry] }) }], usage: { cache_read_input_tokens: 5 } }); };
  assert.deepEqual(await bedrockExtract(send, 'pinned-id', (u) => usage.push(u))(pages, ['ventilator_use'], types), [entry]);
  const body = JSON.parse(cmd!.input.body);
  assert.equal(cmd!.input.modelId, 'pinned-id');
  assert.equal(body.temperature, 0);
  assert.equal(body.tools, undefined);
  assert.equal(body.system[0].cache_control.type, 'ephemeral');
  assert.equal(body.output_config.format.type, 'json_schema');
  assert.ok(!JSON.stringify(body.output_config).includes('outcome'));
  assert.deepEqual(JSON.parse(body.messages[0].content), { keys: [{ key: 'ventilator_use', type: 'tri_state' }], documents: pages });
  assert.deepEqual(usage, [{ cache_read_input_tokens: 5 }]);
});

test('an unfinished or malformed answer throws without quoting it, so it is never read as silence', async () => {
  const cases: [object, RegExp][] = [
    [{ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"facts":[' }] }, /did not finish/],
    [{ stop_reason: 'refusal', content: [] }, /did not finish/],
    [{ stop_reason: 'end_turn', content: [{ type: 'text', text: 'SYNTHETIC-CANARY not json' }] }, /not JSON/],
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
});

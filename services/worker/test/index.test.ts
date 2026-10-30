import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const env = {
  PATH: process.env['PATH'], SQS_PROCESSING_QUEUE_URL: 'https://sqs.example.invalid/q', SQS_PROCESSING_DLQ_URL: 'https://sqs.example.invalid/dlq', S3_DOCUMENTS_BUCKET: 'example-invalid',
  DATABASE_URL_WORKER: 'postgres://x@127.0.0.1:1/x', AWS_REGION: 'us-east-1', BEDROCK_MODEL_ID: 'anthropic.claude-example-20250101-v1:0',
};
const start = (over: Record<string, string | undefined>) => spawnSync(process.execPath, [entry], { encoding: 'utf8', timeout: 8000, env: { ...env, ...over } as NodeJS.ProcessEnv });

test('the worker refuses to start without its settings, naming only the variable', () => {
  const r = start({ SQS_PROCESSING_DLQ_URL: '' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /missing required environment variable SQS_PROCESSING_DLQ_URL/);
});

test('the worker refuses an unpinned model or a region outside the US (I7)', () => {
  assert.match(start({ BEDROCK_MODEL_ID: 'anthropic.claude-latest' }).stderr, /pinned/);
  assert.match(start({ AWS_REGION: 'eu-west-1' }).stderr, /region must be one of/);
});

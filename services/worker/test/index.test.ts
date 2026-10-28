import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url));

test('worker logs idle and exits 0 when env is set', () => {
  const r = spawnSync(process.execPath, [entry], {
    encoding: 'utf8',
    env: { ...process.env, QUEUE_URL: 'https://sqs.example.invalid/queue', AWS_REGION: 'us-east-1' },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /worker idle: pipeline arrives at M3/);
});

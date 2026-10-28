import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRepo, removeRepo, runCheck } from './helpers.mjs';

test('rules-ci-offline passes on a pure engine that only spawns its own CLI in tests', () => {
  const root = makeRepo({
    'packages/rules-engine/src/index.ts': "export type TriState = 'yes' | 'no' | 'unknown';\nexport const and = (a: TriState, b: TriState) => (a === 'no' || b === 'no' ? 'no' : a === 'yes' && b === 'yes' ? 'yes' : 'unknown');\n",
    'packages/rules-engine/test/engine.test.ts': "import { spawnSync } from 'node:child_process';\nimport { and } from '../src/index.ts';\n",
    'packages/rules-engine/package.json': JSON.stringify({ name: '@codex-health/rules-engine', devDependencies: { vitest: '2.0.0' } }),
  });
  try {
    const r = runCheck('rules-ci-offline', root);
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /^PASS rules-ci-offline:/);
  } finally {
    removeRepo(root);
  }
});

test('rules-ci-offline fails on an AWS SDK import, an http import and a fetch call', () => {
  const root = makeRepo({
    'packages/rules-engine/src/index.ts': "import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';\nimport https from 'node:https';\nexport const load = () => fetch('https://example.invalid/rules');\n",
  });
  try {
    const r = runCheck('rules-ci-offline', root);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /^FAIL rules-ci-offline:/);
    assert.match(r.stdout, /AWS SDK import/);
    assert.match(r.stdout, /network\/client import/);
    assert.match(r.stdout, /global fetch call/);
  } finally {
    removeRepo(root);
  }
});

// Two fixtures because the result line names at most five hits.
test('rules-ci-offline fails on clocks, randomness, process.env, I/O imports and browser network APIs', () => {
  const cases = [
    ["import fs from 'node:fs';\nexport const t = Date.now();\nexport const r = Math.random();\nexport const e = process.env.X;\n", ['I/O import', 'nondeterministic call', 'process.env read']],
    ["import { spawnSync } from 'node:child_process';\nexport const ws = new WebSocket('wss://example.invalid');\nexport const f = globalThis.fetch('x');\n", ['src/a.ts:1 (I/O import)', 'browser network API', 'global fetch call']],
  ];
  for (const [source, labels] of cases) {
    const root = makeRepo({ 'packages/rules-engine/src/a.ts': source });
    try {
      const r = runCheck('rules-ci-offline', root);
      assert.equal(r.status, 1, r.stdout);
      assert.match(r.stdout, /^FAIL rules-ci-offline:/);
      for (const label of labels) assert.ok(r.stdout.includes(label), `${label} in ${r.stdout}`);
    } finally {
      removeRepo(root);
    }
  }
});

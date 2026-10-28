import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bedrockClientConfig, requireEnv } from '../src/index.ts';

test('requireEnv returns a set value and throws on missing or empty', () => {
  process.env['CODEX_TEST_VAR'] = 'set';
  assert.equal(requireEnv('CODEX_TEST_VAR'), 'set');
  process.env['CODEX_TEST_VAR'] = '';
  assert.throws(() => requireEnv('CODEX_TEST_VAR'), /CODEX_TEST_VAR/);
  delete process.env['CODEX_TEST_VAR'];
  assert.throws(() => requireEnv('CODEX_TEST_VAR'), /CODEX_TEST_VAR/);
});

test('bedrockClientConfig accepts a pinned model in a US region and rejects everything else', () => {
  const ok = { region: 'us-east-1', modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0' };
  assert.deepEqual(bedrockClientConfig(ok), ok);
  assert.throws(() => bedrockClientConfig({ ...ok, endpoint: 'http://proxy.example.invalid' } as never), /endpoint/);
  assert.throws(() => bedrockClientConfig({ ...ok, region: 'eu-west-1' }), /region/);
  assert.throws(() => bedrockClientConfig({ ...ok, modelId: 'anthropic.claude-3-5-sonnet-latest' }), /pinned/);
  assert.throws(() => bedrockClientConfig({ ...ok, modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:latest' }), /pinned/);
  assert.throws(() => bedrockClientConfig({ ...ok, modelId: 'us.anthropic.claude-3-5-sonnet-20241022-v2:0' }), /pinned/);
});

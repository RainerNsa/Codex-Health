import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRepo, removeRepo, runCheck } from './helpers.mjs';

test('bedrock-only passes when only the Bedrock runtime client is used', () => {
  const root = makeRepo({
    'services/worker/src/extract.ts': "import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';\nexport const c = new BedrockRuntimeClient({});\n",
    'services/worker/package.json': JSON.stringify({ name: 'worker', dependencies: { '@aws-sdk/client-bedrock-runtime': '3.0.0' } }),
    '.env.example': '# Points every AWS SDK client at LocalStack.\nAWS_ENDPOINT_URL=http://127.0.0.1:4566\n',
    'docker-compose.yml': 'services:\n  api:\n    environment:\n      AWS_ENDPOINT_URL: http://localstack:4566\n',
    'scripts/checks/bedrock-only.mjs': "const re = /api\\.openai\\.com/; // the checker's own patterns are not findings\n",
  });
  try {
    const r = runCheck('bedrock-only', root);
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /^PASS bedrock-only:/);
  } finally {
    removeRepo(root);
  }
});

test('bedrock-only fails on an openai import, a dependency and a local gateway URL', () => {
  const root = makeRepo({
    'apps/api/src/ai.ts': "import OpenAI from 'openai';\nconst base = 'http://localhost:20128/v1';\n",
    'apps/api/package.json': JSON.stringify({ name: 'api', dependencies: { openai: '4.0.0' } }),
  });
  try {
    const r = runCheck('bedrock-only', root);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /^FAIL bedrock-only:.*AI client import/);
    assert.match(r.stdout, /OmniRoute port/);
    assert.match(r.stdout, /dependency openai/);
  } finally {
    removeRepo(root);
  }
});

// Every probe that bypassed the first version of this check. Each must fail on its own.
const probes = {
  'endpoint override on the Bedrock client': ['apps/api/src/a.ts', 'new BedrockRuntimeClient({ endpoint: process.env.AI_GATEWAY_URL });'],
  'split host literal': ['apps/api/src/a.ts', "const h = 'api.open' + 'ai.com';"],
  'base64-hidden URL': ['apps/api/src/a.ts', "const u = atob('aHR0cHM6Ly9hcGkub3BlbmFpLmNvbQ==');"],
  'OmniRoute host on the LAN': ['apps/api/src/a.ts', "const u = 'http://omniroute.lan:20128/v1/chat/completions';"],
  'LiteLLM host': ['apps/api/src/a.ts', "const u = 'http://litellm.internal:4000';"],
  'Mistral host': ['apps/api/src/a.ts', "const u = 'https://api.mistral.ai';"],
  'Azure OpenAI host': ['apps/api/src/a.ts', "const u = 'https://acme.openai.azure.com';"],
  'OpenAI env var': ['apps/api/src/a.ts', 'const k = process.env.OPENAI_API_KEY;'],
  'non-literal dynamic import': ['apps/api/src/a.ts', "const m = await import(process.env.AI_SDK ?? 'openai');"],
  'npm alias dependency': ['apps/api/package.json', JSON.stringify({ name: 'api', dependencies: { 'ai-client': 'npm:openai@^4' } })],
  '@ai-sdk/openai dependency': ['apps/api/package.json', JSON.stringify({ name: 'api', dependencies: { '@ai-sdk/openai': '1.0.0' } })],
  'ai dependency': ['apps/api/package.json', JSON.stringify({ name: 'api', dependencies: { ai: '4.0.0' } })],
  '@langchain/openai dependency': ['apps/api/package.json', JSON.stringify({ name: 'api', dependencies: { '@langchain/openai': '0.3.0' } })],
  '@mistralai/mistralai dependency': ['apps/api/package.json', JSON.stringify({ name: 'api', dependencies: { '@mistralai/mistralai': '1.0.0' } })],
  'root manifest dependency (hoisted into every workspace)': ['package.json', JSON.stringify({ name: 'root', dependencies: { 'ai-client': 'npm:openai@^4' } })],
  'OpenAI-compatible path on any host': ['services/worker/src/a.ts', "const u = 'https://gateway.example.invalid/v1/messages';"],
  'AWS_ENDPOINT_URL outside LocalStack in terraform': ['infra/terraform/main.tf', 'environment = { AWS_ENDPOINT_URL_BEDROCK_RUNTIME = "https://proxy.example.invalid" }'],
  'gateway reference in a dev script': ['scripts/dev/call.sh', 'curl http://127.0.0.1:20128/v1/chat/completions'],
  'gateway in docker-compose': ['docker-compose.yml', 'services:\n  gw:\n    image: omniroute\n'],
  'vendor key in a root .env file': ['.env.local', 'OPENAI_API_KEY=placeholder\n'],
};
for (const [name, [file, content]] of Object.entries(probes)) {
  test(`bedrock-only fails on ${name}`, () => {
    const root = makeRepo({ [file]: content + '\n' });
    try {
      const r = runCheck('bedrock-only', root);
      assert.equal(r.status, 1, r.stdout);
      assert.match(r.stdout, /^FAIL bedrock-only:/);
    } finally {
      removeRepo(root);
    }
  });
}

test('bedrock-only skips with a reason when there is nothing to scan', () => {
  const root = makeRepo({});
  try {
    const r = runCheck('bedrock-only', root);
    assert.equal(r.status, 2);
    assert.match(r.stdout, /^SKIP bedrock-only:/);
  } finally {
    removeRepo(root);
  }
});

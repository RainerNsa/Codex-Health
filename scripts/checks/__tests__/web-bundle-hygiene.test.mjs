import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRepo, removeRepo, runCheck } from './helpers.mjs';

test('web-bundle-hygiene passes on a plain React component', () => {
  const root = makeRepo({
    'apps/web/src/App.tsx': "import React from 'react';\nexport function App() { return <main>Codex Health</main>; }\n",
    'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { react: '18.3.1' } }),
  });
  try {
    const r = runCheck('web-bundle-hygiene', root);
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /^PASS web-bundle-hygiene:/);
  } finally {
    removeRepo(root);
  }
});

test('web-bundle-hygiene fails on a db client import, a JWT literal and dangerouslySetInnerHTML', () => {
  const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJyb2xlIjoic2VydmljZV9yb2xlIn0', 'ZZTESTfakesignaturefakesignature'].join('.');
  const root = makeRepo({
    'apps/web/src/db.ts': `import { Client } from 'pg';\nexport const token = '${jwt}';\n`,
    'apps/web/src/Raw.tsx': "export const Raw = ({ html }) => <div dangerouslySetInnerHTML={{ __html: html }} />;\n",
    'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { pg: '8.0.0' } }),
  });
  try {
    const r = runCheck('web-bundle-hygiene', root);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /^FAIL web-bundle-hygiene:/);
    assert.match(r.stdout, /database client import/);
    assert.match(r.stdout, /JWT literal/);
    assert.match(r.stdout, /dangerouslySetInnerHTML/);
    assert.match(r.stdout, /database client dependency pg/);
  } finally {
    removeRepo(root);
  }
});

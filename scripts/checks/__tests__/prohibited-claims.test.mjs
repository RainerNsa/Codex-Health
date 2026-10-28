import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRepo, removeRepo, runCheck } from './helpers.mjs';

test('prohibited-claims passes on neutral product copy, docs code blocks and ADR examples', () => {
  const root = makeRepo({
    'apps/web/src/copy.ts': "export const tagline = 'The AI reads the packet; your criteria make the call; your staff decide.';\n",
    'docs/local-development.md': '# Local\n\n```sh\nnode seed.mjs   # 2 orgs x 2 facilities x 3 users\n```\n',
    'docs/adr/0009-example.md': 'Rejected wording: "HIPAA compliant".\n',
    'CONSTRAINTS.md': 'Forbidden: "HIPAA compliant", "SOC 2".\n',
  });
  try {
    const r = runCheck('prohibited-claims', root);
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /^PASS prohibited-claims:/);
  } finally {
    removeRepo(root);
  }
});

test('prohibited-claims fails on compliance, accuracy and customer-count claims', () => {
  const root = makeRepo({
    'apps/web/src/Landing.tsx': [
      "export const a = 'Fully HIPAA compliant';",
      "export const b = 'Our extraction runs at 99.5% accuracy';",
      "export const c = 'Trusted by 500+ facilities';",
    ].join('\n'),
  });
  try {
    const r = runCheck('prohibited-claims', root);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /^FAIL prohibited-claims:/);
    assert.match(r.stdout, /HIPAA compliant/);
    assert.match(r.stdout, /percentage next to accuracy metric/);
    assert.match(r.stdout, /customer count/);
  } finally {
    removeRepo(root);
  }
});

// One claim per file so each shows up in the five-hit result line.
const probes = {
  'HIPAA-ready wording': ['README.md', 'Codex Health is HIPAA-ready.', 'HIPAA compliant'],
  'compliance with HIPAA': ['docs/overview.md', 'We are in full compliance with HIPAA.', 'HIPAA compliant'],
  'HITRUST': ['apps/api/src/about.ts', "export const s = 'HITRUST certified';", 'HITRUST'],
  'ISO 27001': ['docs/security.md', 'ISO27001 certified hosting.', 'ISO 27001'],
  'a spelled-out percentage near an accuracy word': ['apps/web/dist/assets/index-abc123.js', 'const t="ninety-nine percent accuracy on every packet"', 'percentage next to accuracy metric'],
};
for (const [name, [file, content, label]] of Object.entries(probes)) {
  test(`prohibited-claims fails on ${name}`, () => {
    const root = makeRepo({ [file]: content + '\n' });
    try {
      const r = runCheck('prohibited-claims', root);
      assert.equal(r.status, 1, r.stdout);
      assert.ok(r.stdout.includes(label), `${label} in ${r.stdout}`);
    } finally {
      removeRepo(root);
    }
  });
}

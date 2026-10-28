import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const ajv = new Ajv2020({ allErrors: true });

// example dir -> schema file
const pairs = {
  facts: 'fact.v0.json',
  profiles: 'facility-profile.v0.json',
  rules: 'rule.v0.json',
};

const validators = {}; // dir -> compiled validator (ajv refuses to compile the same $id twice)

for (const [dir, schemaFile] of Object.entries(pairs)) {
  const validate = ajv.compile(readJson(`${root}schemas/${schemaFile}`));
  validators[dir] = validate;
  const files = readdirSync(`${root}examples/${dir}`).filter((f) => f.endsWith('.json'));
  assert.ok(files.length > 0, `no examples in examples/${dir}`);
  for (const f of files) {
    test(`examples/${dir}/${f} validates against ${schemaFile}`, () => {
      const ok = validate(readJson(`${root}examples/${dir}/${f}`));
      assert.ok(ok, JSON.stringify(validate.errors, null, 2));
    });
  }
}

test('rule schema rejects a protected hard stop without a legal reviewer', () => {
  const validate = validators.rules;
  const rule = readJson(`${root}examples/rules/seed.hard_stop.ventilator.json`);
  assert.equal(validate({ ...rule, protected_input: true, legal_reviewer: null }), false);
});

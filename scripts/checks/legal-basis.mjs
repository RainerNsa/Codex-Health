// CONSTRAINTS (dev-alignment 2.8): every rule carries a legal_basis. Checks every rule example
// under packages/schemas/examples/rules/. A file holds one rule object or an array of them.
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot, walk, finish, rel } from './lib.mjs';

const NAME = 'legal-basis';
const DIR = path.join(repoRoot, 'packages', 'schemas', 'examples', 'rules');

function hasLegalBasis(rule) {
  const v = rule?.legal_basis;
  if (typeof v === 'string') return v.trim().length > 0;
  if (v && typeof v === 'object') return Object.keys(v).length > 0;
  return false;
}

if (!fs.existsSync(DIR)) finish('SKIP', NAME, 'packages/schemas/examples/rules does not exist yet');
const files = walk(DIR, { exts: ['.json'] });
const others = walk(DIR).filter((f) => !f.endsWith('.json') && !path.basename(f).startsWith('.') && !f.endsWith('.md'));
if (files.length === 0 && others.length === 0) finish('SKIP', NAME, 'no rule examples yet');

const problems = others.map((f) => `${rel(f)} (rule examples must be JSON)`);
let rules = 0;
for (const file of files) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    problems.push(`${rel(file)} (invalid JSON: ${err.message})`);
    continue;
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  list.forEach((rule, i) => {
    rules += 1;
    if (!hasLegalBasis(rule)) problems.push(`${rel(file)}${Array.isArray(parsed) ? `[${i}]` : ''} (missing legal_basis)`);
  });
}

if (problems.length) finish('FAIL', NAME, problems.slice(0, 5).join(', ') + (problems.length > 5 ? ` +${problems.length - 5} more` : ''));
finish('PASS', NAME, `${rules} rule example(s) in ${files.length} file(s) all carry legal_basis`);

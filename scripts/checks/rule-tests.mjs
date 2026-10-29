// CONSTRAINTS §3 "Rule tests" and §4.2 "Rule test coverage" (I1, I10; SPEC §10.4; dev-alignment 2.3, 2.8):
// every rule record under packages/schemas/examples/rules/ parses under the §10.1 grammar, reads exactly its
// declared inputs, uses `is unknown` only in a review rule, carries a legal_reviewer record when it is a
// non-review rule over a protected input, has a True, a False and an Unknown case, and passes every case.
// It runs the engine's own `rules test` (packages/rules-engine/src/cli.ts), which never calls Bedrock, Textract
// or the network and reads no clock (rules-ci-offline). The engine is the code under test, so it is always taken
// from this repository; the rules directory comes from CHECK_ROOT when set.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { repoRoot, finish } from './lib.mjs';

const NAME = 'rule-tests';
const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '..', '..', 'packages', 'rules-engine', 'src', 'cli.ts');
const DIR = path.join(repoRoot, 'packages', 'schemas', 'examples', 'rules');

if (!fs.existsSync(DIR) || !fs.readdirSync(DIR).some((f) => f.endsWith('.json'))) finish('SKIP', NAME, 'no rule records under packages/schemas/examples/rules yet');
if (!fs.existsSync(CLI)) finish('FAIL', NAME, 'packages/rules-engine/src/cli.ts is missing: rule CI cannot run');

const run = spawnSync(process.execPath, [CLI, 'rules', 'test', DIR], { encoding: 'utf8', timeout: 60_000 });
const out = `${run.stdout || ''}${run.stderr || ''}`;
const summary = out.trim().split('\n').find((l) => /rule\(s\), \d+ case\(s\), \d+ failure\(s\)$/.test(l));
if (run.status === 0 && summary) finish('PASS', NAME, summary);
const problems = out.split('\n').filter((l) => /^(LINT|FAIL) /.test(l) || /: not a rule record|: Unexpected|rules test failed/.test(l)).map((l) => l.trim());
finish('FAIL', NAME, problems.length ? problems.slice(0, 4).join('; ') + (problems.length > 4 ? ` +${problems.length - 4} more` : '') : `rules test exited ${run.status}${run.error ? ` (${run.error.message})` : ''}`);

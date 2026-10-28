// CONSTRAINTS: no PHI in logs. Every golden packet carries the canary identifiers in
// canary-strings.json; if any canary shows up in a log, coverage report, snapshot, CI artefact
// or local data file, something is leaking packet contents.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoRoot, walk, finish, rel, lineOf, formatHits } from './lib.mjs';

const NAME = 'canary-phi';
const here = path.dirname(fileURLToPath(import.meta.url));
const canaryFile = path.join(here, 'canary-strings.json');

const { canaries } = JSON.parse(fs.readFileSync(canaryFile, 'utf8'));
if (!Array.isArray(canaries) || canaries.length !== 3) finish('FAIL', NAME, 'canary-strings.json must hold exactly 3 canaries');
if (new Set(canaries.map((c) => c.value.toLowerCase())).size !== 3) finish('FAIL', NAME, 'canary values must be unique');

const SINK_DIRS = ['data/local', 'coverage', '__snapshots__', 'artifacts', 'ci-artifacts', 'test-results', 'playwright-report'];
const SINK_EXTS = ['.log', '.snap'];
const SKIP = new Set(['node_modules', '.git']);

// Collect every file that is a log/snapshot or lives under a sink directory, anywhere in the repo.
const targets = new Set();
for (const file of walk(repoRoot, { skipDirs: SKIP })) {
  const relative = rel(file).split(path.sep).join('/');
  const inSink = SINK_DIRS.some((sink) => ('/' + relative).includes('/' + sink + '/'));
  if (inSink || SINK_EXTS.includes(path.extname(file))) targets.add(file);
}
if (targets.size === 0) finish('SKIP', NAME, 'no log, snapshot, coverage, artefact or data/local files present');

const hits = [];
for (const file of targets) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  const lower = text.toLowerCase();
  for (const canary of canaries) {
    const at = lower.indexOf(canary.value.toLowerCase());
    if (at !== -1) hits.push({ file: rel(file), line: lineOf(text, at), label: `canary ${canary.kind}` });
  }
}

if (hits.length) finish('FAIL', NAME, `canary identifiers found in sinks: ${formatHits(hits)}`);
finish('PASS', NAME, `${targets.size} sink files scanned, no canary present`);

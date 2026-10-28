// CONSTRAINTS: no compliance, accuracy or customer claims in UI copy, docs or README.
// Scans apps/web (including a built dist/), apps/api/src, README.md and docs/ (not docs/adr).
// CONSTRAINTS.md and CLAUDE.md list the forbidden strings as examples and are not scanned.
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot, walk, scanFiles, formatHits, finish, SOURCE_EXTS } from './lib.mjs';

const NAME = 'prohibited-claims';
const EXTS = [...SOURCE_EXTS, '.html', '.md', '.mdx', '.json', '.txt', '.yml', '.yaml'];
const TARGETS = [
  { dir: path.join(repoRoot, 'apps', 'web'), includeBuilt: true },
  { dir: path.join(repoRoot, 'apps', 'api', 'src') },
  { dir: path.join(repoRoot, 'docs'), skip: path.join(repoRoot, 'docs', 'adr') + path.sep },
];
const ROOT_FILES = ['README.md'].map((f) => path.join(repoRoot, f));

const METRIC = '(accura(?:cy|te)|precision|recall|sensitivity|specificity|faster|fewer errors)';
const WORD_NUMBER =
  '(?:(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[\\s-](?:one|two|three|four|five|six|seven|eight|nine))?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|hundred)';
const PERCENT = `(?:\\d+(?:\\.\\d+)?\\s?(?:%|percent)|\\b${WORD_NUMBER}\\s+percent)`;
const PATTERNS = [
  { label: 'HIPAA compliant', re: /HIPAA[\s-]*(compliant|compliance|certified|ready|secure)|(compliant|compliance)\s+with\s+HIPAA/i },
  { label: 'HITRUST', re: /\bHITRUST\b/i },
  { label: 'ISO 27001', re: /\bISO\s?27001\b/i },
  { label: 'SOC 2', re: /\bSOC\s?2\b/i },
  { label: 'percentage next to accuracy metric', re: new RegExp(`${PERCENT}[^.\\n]{0,40}\\b${METRIC}\\b`, 'i') },
  { label: 'accuracy metric next to percentage', re: new RegExp(`\\b${METRIC}\\b[^.\\n]{0,40}${PERCENT}`, 'i') },
  { label: 'trusted by', re: /trusted by/i },
];
// Counted in prose only: a code block in a doc ("seed 2 facilities") is a command, not a claim.
const COUNT_PATTERNS = [
  { label: 'customer count', re: /\b(\d[\d,]*\+?|hundreds|thousands)\s+(of\s+)?(customers|clients|facilities|SNFs|nursing homes|hospitals|providers|operators)\b/i },
];
const MD_CODE = /```[\s\S]*?```|`[^`\n]*`/g;
const blankMarkdownCode = (text, file) => (file.endsWith('.md') ? text.replace(MD_CODE, (code) => code.replace(/[^\n]/g, ' ')) : text);

const present = TARGETS.filter((t) => fs.existsSync(t.dir));
if (present.length === 0 && !ROOT_FILES.some((f) => fs.existsSync(f))) finish('SKIP', NAME, 'apps/web, apps/api/src, docs and README.md do not exist yet');
const files = [
  ...present.flatMap((t) => walk(t.dir, { exts: EXTS, includeBuilt: t.includeBuilt }).filter((f) => !(t.skip && f.startsWith(t.skip)))),
  ...ROOT_FILES.filter((f) => fs.existsSync(f)),
].filter((f) => path.basename(f) !== 'package-lock.json');
if (files.length === 0) finish('SKIP', NAME, 'no files to scan yet');

const hits = [...scanFiles(files, PATTERNS), ...scanFiles(files, COUNT_PATTERNS, { prepare: blankMarkdownCode })];
if (hits.length) finish('FAIL', NAME, `prohibited claim strings: ${formatHits(hits)}`);
finish('PASS', NAME, `${files.length} files in apps/web, apps/api/src, docs and README.md scanned`);

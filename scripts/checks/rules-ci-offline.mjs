// CONSTRAINTS: the rules engine is pure and deterministic; its CI never calls Bedrock, Textract
// or any network. Fails if packages/rules-engine source or tests import a network client, an
// AWS SDK or an I/O module, call fetch, read process.env, or use a clock or randomness.
// Exception: packages/rules-engine/test/** may import child_process to spawn the engine's own CLI.
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot, walk, scanFiles, formatHits, finish, SOURCE_EXTS } from './lib.mjs';

const NAME = 'rules-ci-offline';
const DIR = path.join(repoRoot, 'packages', 'rules-engine');
const TEST_DIR = path.join(DIR, 'test') + path.sep;
const NETWORK_MODULES = [
  'http', 'https', 'http2', 'net', 'tls', 'dgram', 'dns', 'node:http', 'node:https', 'node:http2', 'node:net', 'node:tls', 'node:dgram', 'node:dns',
  'undici', 'axios', 'node-fetch', 'got', 'ky', 'superagent', 'ws', 'socket.io', 'socket.io-client',
  'pg', 'postgres', '@supabase/supabase-js', 'ioredis', 'redis', 'openai',
];
const IO_MODULES = ['fs', 'node:fs', 'worker_threads', 'node:worker_threads'];
const SPAWN_MODULES = ['child_process', 'node:child_process'];
// One literal import regex; the module list is matched on the captured specifier, never compiled into a regex.
const IMPORT_RE = /(from\s+|require\(\s*|import\(\s*)['"]([^'"]+)['"]/;
const importOf = (mods) => ({ re: IMPORT_RE, accept: (m) => mods.some((mod) => m[2] === mod || m[2].startsWith(`${mod}/`)) });
const PATTERNS = [
  { label: 'network/client import', ...importOf(NETWORK_MODULES) },
  { label: 'AWS SDK import', re: /(from\s+|require\(\s*|import\(\s*)['"](@aws-sdk\/[^'"]+|aws-sdk(\/[^'"]*)?|@anthropic-ai\/[^'"]+)['"]/ },
  { label: 'global fetch call', re: /(^|[^.\w])fetch\s*\(|\b(globalThis|window|self)\.fetch\b/ },
  { label: 'nondeterministic call', re: /\b(Date\.now\s*\(|new\s+Date\b|performance\.now\s*\(|Math\.random\s*\(|crypto\.randomUUID\s*\(|process\.hrtime\b)/ },
  { label: 'process.env read', re: /\bprocess\.env\b/ },
  { label: 'browser network API', re: /\b(WebSocket|XMLHttpRequest|EventSource)\b/ },
];
const SRC_PATTERNS = [...PATTERNS, { label: 'I/O import', ...importOf([...IO_MODULES, ...SPAWN_MODULES]) }];
const TEST_PATTERNS = [...PATTERNS, { label: 'I/O import', ...importOf(IO_MODULES) }];

if (!fs.existsSync(DIR)) finish('SKIP', NAME, 'packages/rules-engine does not exist yet');
const files = walk(DIR, { exts: SOURCE_EXTS });
const manifest = path.join(DIR, 'package.json');
if (files.length === 0 && !fs.existsSync(manifest)) finish('SKIP', NAME, 'packages/rules-engine has no source yet');

const isTest = (f) => f.startsWith(TEST_DIR);
const hits = [...scanFiles(files.filter((f) => !isTest(f)), SRC_PATTERNS), ...scanFiles(files.filter(isTest), TEST_PATTERNS)];
if (fs.existsSync(manifest)) {
  let pkg = {};
  try {
    pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  } catch {
    hits.push({ file: 'packages/rules-engine/package.json', line: 1, label: 'unparseable package.json' });
  }
  for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
    if (NETWORK_MODULES.includes(dep) || dep.startsWith('@aws-sdk/') || dep === 'aws-sdk' || dep.startsWith('@anthropic-ai/')) {
      hits.push({ file: 'packages/rules-engine/package.json', line: 1, label: `dependency ${dep}` });
    }
  }
}

if (hits.length) finish('FAIL', NAME, `rules engine reaches the network, I/O, env or a clock: ${formatHits(hits)}`);
finish('PASS', NAME, `${files.length} rules-engine files scanned, no network, I/O, env, clock or AWS SDK usage`);

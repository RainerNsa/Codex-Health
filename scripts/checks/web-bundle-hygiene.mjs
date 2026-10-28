// CONSTRAINTS: the browser bundle never carries a database client, a token, a vendor key, or
// raw HTML injection. Scans apps/web source and its package.json.
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot, walk, scanFiles, formatHits, finish, SOURCE_EXTS } from './lib.mjs';

const NAME = 'web-bundle-hygiene';
const WEB = path.join(repoRoot, 'apps', 'web');
const DB_CLIENTS = ['pg', 'pg-promise', 'postgres', '@supabase/supabase-js', '@supabase/postgrest-js', 'prisma', '@prisma/client', 'knex', 'drizzle-orm', 'mysql', 'mysql2', 'mongodb', 'mongoose', 'ioredis', 'redis'];

const dbImport = new RegExp(
  `(from\\s+|require\\(\\s*|import\\(\\s*)['"](${DB_CLIENTS.map((c) => c.replace(/[/.-]/g, '\\$&')).join('|')})(/[^'"]*)?['"]`,
);
const PATTERNS = [
  { label: 'database client import', re: dbImport },
  { label: 'JWT literal', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { label: 'AWS access key', re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { label: 'OpenAI/Anthropic key', re: /\bsk-(ant-|proj-)?[A-Za-z0-9_-]{20,}/ },
  { label: 'Supabase secret key', re: /\bsb_secret_[A-Za-z0-9_-]{20,}/ },
  { label: 'dangerouslySetInnerHTML', re: /dangerouslySetInnerHTML/ },
];

if (!fs.existsSync(WEB)) finish('SKIP', NAME, 'apps/web does not exist yet');
const sources = walk(WEB, { exts: [...SOURCE_EXTS, '.html'] });
const manifest = path.join(WEB, 'package.json');
if (sources.length === 0 && !fs.existsSync(manifest)) finish('SKIP', NAME, 'apps/web has no source yet');

const hits = scanFiles(sources, PATTERNS);
if (fs.existsSync(manifest)) {
  let pkg = {};
  try {
    pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  } catch {
    hits.push({ file: 'apps/web/package.json', line: 1, label: 'unparseable package.json' });
  }
  for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
    if (DB_CLIENTS.includes(dep)) hits.push({ file: 'apps/web/package.json', line: 1, label: `database client dependency ${dep}` });
  }
}

if (hits.length) finish('FAIL', NAME, `browser bundle hygiene violations: ${formatHits(hits)}`);
finish('PASS', NAME, `${sources.length} apps/web source files scanned`);

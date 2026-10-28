// Shared helpers for the CONSTRAINTS checks. Node built-ins only.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// CHECK_ROOT lets tests (and run-all) point a check at a fixture tree.
export const repoRoot = process.env.CHECK_ROOT
  ? path.resolve(process.env.CHECK_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const BUILT_DIRS = ['dist', 'build'];
export const SKIP_DIRS = new Set(['node_modules', '.git', ...BUILT_DIRS, '.terraform', '.next']);

export const SOURCE_EXTS = ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx'];

/** Recursively list files under dir. Missing dir -> []. dist/build are skipped unless includeBuilt. */
export function walk(dir, { exts, skipDirs = SKIP_DIRS, includeBuilt = false } = {}) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  if (includeBuilt) skipDirs = new Set([...skipDirs].filter((d) => !BUILT_DIRS.includes(d)));
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) stack.push(full);
      } else if (entry.isFile()) {
        if (!exts || exts.includes(path.extname(entry.name))) out.push(full);
      }
    }
  }
  return out.sort();
}

export function rel(file) {
  return path.relative(repoRoot, file) || file;
}

/** Return the 1-based line number of the first regex hit in text, or 0. */
export function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

/**
 * Scan files for regex patterns. Returns [{file, line, label}] for every hit.
 * prepare(text, file) may rewrite the text before matching; it must keep line breaks in place.
 */
export function scanFiles(files, patterns, { prepare } = {}) {
  const hits = [];
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (text.includes('\0')) continue; // binary
    if (prepare) text = prepare(text, file);
    for (const { label, re } of patterns) {
      const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
      for (const match of text.matchAll(global)) {
        hits.push({ file: rel(file), line: lineOf(text, match.index), label });
      }
    }
  }
  return hits;
}

export function formatHits(hits, max = 5) {
  const shown = hits.slice(0, max).map((h) => `${h.file}:${h.line} (${h.label})`);
  const more = hits.length > max ? ` +${hits.length - max} more` : '';
  return shown.join(', ') + more;
}

const EXIT = { PASS: 0, FAIL: 1, SKIP: 2 };

/** Print the single result line and exit with the matching code. */
export function finish(status, name, detail) {
  console.log(`${status} ${name}: ${detail}`);
  process.exit(EXIT[status]);
}

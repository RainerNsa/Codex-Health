// Test helpers: build a throwaway repo tree in the OS temp dir and run a check against it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const checksDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** files: { 'relative/path': 'content' }. Returns the temp root. Caller removes it. */
export function makeRepo(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'psp-check-'));
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

export function removeRepo(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

/** Run scripts/checks/<name>.mjs with CHECK_ROOT=root. Returns { status, stdout, stderr }. */
export function runCheck(name, root, { args = [], env = {} } = {}) {
  const run = spawnSync(process.execPath, [path.join(checksDir, `${name}.mjs`), ...args], {
    encoding: 'utf8',
    env: { ...process.env, CHECK_ROOT: root, ...env },
  });
  return { status: run.status, stdout: run.stdout || '', stderr: run.stderr || '' };
}

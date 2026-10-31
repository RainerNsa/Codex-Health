// Page images for a person to check a fact against (I2, XF-7b). The sender's file is parsed only in render-child.mjs, in a
// process with an empty environment, no write access and limits on time, memory and output. No error carries document text.
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TIMEOUT_MS = 120_000;
const MAX_HEAP_MB = 1024;
const MAX_OUTPUT_BYTES = 512 * 1024 * 1024;
const CHILD = fileURLToPath(new URL('./render-child.mjs', import.meta.url));
const modulesDir = resolve(dirname(fileURLToPath(import.meta.resolve('pdfjs-dist/package.json'))), '..');

export const CHILD_FLAGS = ['--permission', '--allow-addons', `--allow-fs-read=${CHILD}`, `--allow-fs-read=${modulesDir}`];

/** Each page of the file as a PNG, in order. Throws if the file cannot be rendered within the limits. */
export function renderPages(bytes: Uint8Array, timeoutMs = TIMEOUT_MS): Promise<Buffer[]> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [...CHILD_FLAGS, `--max-old-space-size=${MAX_HEAP_MB}`, CHILD], { env: {}, stdio: ['pipe', 'pipe', 'ignore'] });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OUTPUT_BYTES) child.kill('SIGKILL');
      else chunks.push(chunk);
    });
    child.stdin.on('error', () => {}); // a child that died early closes the pipe; its exit code reports the failure
    child.on('error', () => { clearTimeout(timer); fail(new Error('renderer did not start')); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return fail(new Error('document could not be rendered'));
      const out = Buffer.concat(chunks);
      const pages: Buffer[] = [];
      for (let at = 0; at < out.length;) {
        const end = at + 4 + out.readUInt32BE(at);
        if (end > out.length) return fail(new Error('document could not be rendered'));
        pages.push(out.subarray(at + 4, end));
        at = end;
      }
      done(pages);
    });
    child.stdin.end(bytes);
  });
}

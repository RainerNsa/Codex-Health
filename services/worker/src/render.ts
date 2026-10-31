// Page images for a person to check a fact against (I2, XF-7b). The sender's file is parsed only in render-child.mjs. Node's
// permission flags are not a security boundary, so on Linux the operating system holds the child: new user, network, process
// and IPC namespaces (no network, no signals to the worker), and limits on memory and files, with an empty environment. A
// document that cannot be rendered is refused; anything onPage throws, a storage fault, passes through for the job to retry.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RenderRefused } from './pipeline.ts';

const TIMEOUT_MS = 300_000;
const MAX_DATA_KB = 2_000_000; // all of the child's memory, unlike a heap flag: decoded images and native canvases count
const MAX_OUTPUT_BYTES = 1024 * 1024 * 1024;
const MAX_FRAME_BYTES = 32 * 1024 * 1024; // what the worker ever holds; the child's largest page is well below it
const MAX_PAGES = 300;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHILD = fileURLToPath(new URL('./render-child.mjs', import.meta.url));
const pdfjs = dirname(fileURLToPath(import.meta.resolve('pdfjs-dist/package.json')));
const canvasPackages = resolve(pdfjs, '../@napi-rs');

export const NODE_FLAGS = (child: string) => ['--permission', '--allow-addons', `--allow-fs-read=${child}`, `--allow-fs-read=${pdfjs}`, `--allow-fs-read=${canvasPackages}`];

function command(child: string): [string, string[]] {
  const node = [process.execPath, ...NODE_FLAGS(child), child];
  if (process.platform !== 'linux') return [node[0]!, node.slice(1)]; // a developer's machine; synthetic files only
  const jail = ['/usr/bin/unshare', '--user', '--map-root-user', '--net', '--pid', '--fork', '--kill-child', '--ipc'];
  return ['/bin/sh', ['-c', `ulimit -c 0; ulimit -f 0; ulimit -d ${MAX_DATA_KB}; exec "$@"`, 'sh', ...jail, ...node]];
}

/** Hands each page to onPage as a PNG, in order, one at a time, and returns how many. Output from the child is hostile too. */
export async function renderPages(bytes: Uint8Array, onPage: (page: number, png: Buffer) => Promise<unknown>,
  { child = CHILD, timeoutMs = TIMEOUT_MS, maxOutput = MAX_OUTPUT_BYTES } = {}): Promise<number> {
  const [file, args] = command(child);
  const proc = spawn(file, args, { env: {}, stdio: ['pipe', 'pipe', 'ignore'] });
  let notStarted = false;
  let expired = false;
  // the child is pid 1 of its namespace and can clear --kill-child, so it is killed by name and its output let go of regardless
  const stop = () => {
    try {
      for (const pid of readFileSync(`/proc/${proc.pid}/task/${proc.pid}/children`, 'utf8').trim().split(' ')) if (pid) process.kill(Number(pid), 'SIGKILL');
    } catch { /* not Linux, or already gone */ }
    proc.kill('SIGKILL');
    proc.stdout.destroy();
  };
  let left = timeoutMs; // the child's time: a slow store must not count against the document
  let started = 0;
  let timer: NodeJS.Timeout;
  const run = () => { started = Date.now(); timer = setTimeout(() => { expired = true; stop(); }, Math.max(0, left)); };
  const pause = () => { clearTimeout(timer); left -= Date.now() - started; };
  run();
  const closed = new Promise<number | null>((done) => { proc.on('close', done); proc.on('error', () => { notStarted = true; done(null); }); });
  proc.stdin.on('error', () => {}); // a child that died early closes the pipe; its exit code reports the failure
  proc.stdin.end(bytes);
  let held: Buffer = Buffer.alloc(0);
  let size = 0;
  let pages = 0;
  try {
    for await (const chunk of proc.stdout as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > maxOutput) throw new RenderRefused();
      held = Buffer.concat([held, chunk]);
      while (held.length >= 4) {
        const length = held.readUInt32BE(0);
        if (length > MAX_FRAME_BYTES) throw new RenderRefused();
        if (held.length < 4 + length) break;
        const png = held.subarray(4, 4 + length);
        pages += 1;
        if (pages > MAX_PAGES || !png.subarray(0, PNG.length).equals(PNG)) throw new RenderRefused();
        pause();
        await onPage(pages, png);
        run();
        held = held.subarray(4 + length);
      }
    }
    if (held.length > 0 || await closed !== 0) {
      if (notStarted) throw new Error('renderer did not start'); // the host's fault, not the document's
      throw new RenderRefused();
    }
    return pages;
  } catch (err) {
    throw expired ? new RenderRefused() : err;
  } finally {
    clearTimeout(timer!);
    stop();
  }
}

const ONE_PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/** Run at start: a host that cannot hold the sandbox stops the worker, rather than failing every document as if it were bad. */
export async function renderCheck(): Promise<void> {
  if (await renderPages(Buffer.from(ONE_PIXEL, 'base64'), async () => {}) !== 1) throw new Error('renderer check failed');
}

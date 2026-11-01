// The renderer's promises: real pages come out as PNGs in order, whatever kind of scan, and a file or a child that misbehaves
// fails without reaching anything else. Offline. The sandbox itself exists only on Linux, so CI's run is the one that counts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer, type AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { buildPacket, loadSettings, plan } from '../../../packages/packets/src/generate.mjs';
import { RenderRefused } from '../src/pipeline.ts';
import { renderCheck, renderPages } from '../src/render.ts';

const { createCanvas, loadImage } = createRequire(import.meta.url)('@napi-rs/canvas');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const fixture = (name: string) => fileURLToPath(new URL(`fixtures/render/${name}`, import.meta.url));
const STUB = fixture('stub.mjs'); // PDFs here are named .bin: the repo ignores *.pdf so a real document cannot slip in
const collect = async (bytes: Uint8Array, options = {}) => {
  const pages: { n: number; png: Buffer }[] = [];
  const count = await renderPages(bytes, async (n, png) => { pages.push({ n, png: Buffer.from(png) }); }, options);
  assert.equal(count, pages.length);
  return pages;
};
const size = (png: Buffer) => [png.readUInt32BE(16), png.readUInt32BE(20)] as const;

/** A PDF of empty pages of these widths, for limits that need no content. */
function blanks(widths: number[]) {
  const pages = widths.map((w, i) => `${3 + i} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${w}] >>\nendobj\n`);
  const kids = widths.map((_, i) => `${3 + i} 0 R`).join(' ');
  const body = `%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Count ${widths.length} /Kids [${kids}] >>\nendobj\n${pages.join('')}`;
  return Buffer.from(`${body}trailer\n<< /Root 1 0 R /Size ${3 + widths.length} >>\n`, 'latin1');
}
/** Share of dark pixels on the page: a decoder that failed quietly leaves it blank. */
async function ink(png: Buffer) {
  const picture = await loadImage(png);
  const canvas = createCanvas(picture.width, picture.height);
  const c = canvas.getContext('2d');
  c.drawImage(picture, 0, 0);
  const { data } = c.getImageData(0, 0, picture.width, picture.height);
  let dark = 0;
  for (let i = 0; i < data.length; i += 4) if (data[i] < 128) dark += 1;
  return dark / (data.length / 4);
}

test('every page of a scanned packet comes out as a PNG with ink on it', async () => {
  const pages = await collect(buildPacket(plan()[0], loadSettings()).pdf());
  assert.deepEqual(pages.map((p) => p.n), [1, 2, 3, 4, 5, 6]);
  for (const p of pages) { assert.ok(p.png.subarray(0, 8).equals(PNG)); assert.ok(await ink(p.png) > 0.001); }
});

test('pages come out in order, at twice their size', async () => {
  assert.deepEqual((await collect(blanks([100, 200]))).map((p) => size(p.png)), [[200, 200], [400, 400]]);
});

for (const scan of ['jbig2.bin', 'ccitt_g4.bin', 'jpx_gray.bin', 'dct_gray.bin']) {
  test(`a ${scan} scan is decoded, not left blank`, async () => {
    const [page] = await collect(readFileSync(fixture(scan)));
    assert.ok(await ink(page!.png) > 0.05);
  });
}

test('a JPEG and a PNG are drawn again, so the sender\'s bytes never reach the browser', async () => {
  const [jpeg] = await collect(readFileSync(fixture('gray.jpg')));
  assert.ok(jpeg!.png.subarray(0, 8).equals(PNG));
  assert.ok(await ink(jpeg!.png) > 0.05);
  const canvas = createCanvas(4, 4);
  const original = Buffer.concat([canvas.toBuffer('image/png'), Buffer.from('trailing bytes from the sender')]);
  const [page] = await collect(original);
  assert.ok(page!.png.subarray(0, 8).equals(PNG));
  assert.ok(!page!.png.includes('trailing bytes'));
});

test('page and pixel limits hold', async () => {
  assert.equal((await collect(blanks(Array(300).fill(10)))).length, 300);
  await assert.rejects(collect(blanks(Array(301).fill(10))), RenderRefused);
  const [w, h] = size((await collect(blanks([5000])))[0]!.png);
  assert.ok(w * h <= 4_100_000);
  await assert.rejects(collect(Buffer.from(blanks([10]).toString('latin1').replace('[0 0 10 10]', '[0 0 100000000 0.00001]'), 'latin1')), RenderRefused);
  const wide = createCanvas(4000, 4000);
  const [big] = await collect(wide.toBuffer('image/png'));
  assert.ok(size(big!.png)[0] * size(big!.png)[1] <= 4_100_000);
});

test('an image pdf.js cannot decode fails the document rather than leaving a hole in the page', async () => {
  await assert.rejects(collect(readFileSync(fixture('bad_jpx.bin'))), RenderRefused);
});

if (process.platform === 'linux') { // memory is limited only inside the sandbox
  test('a small file that decodes to gigabytes dies at the memory limit', async () => {
    await assert.rejects(collect(readFileSync(fixture('flate-bomb.bin'))), RenderRefused);
  });
}

test('what is not a document we render fails, and only a TIFF gives no pages', async () => {
  await assert.rejects(collect(Buffer.from('%PDF-1.4\nthis is not a document')), RenderRefused);
  await assert.rejects(collect(Buffer.from('  %PDF-1.4 leading junk')), RenderRefused);
  assert.deepEqual(await collect(Buffer.from('II*\u0000 not decoded here', 'latin1')), []);
});

for (const output of ['stray', 'cut', 'script', 'empties', 'many', 'huge']) {
  test(`child output "${output}" is refused`, async () => {
    await assert.rejects(collect(Buffer.from(output), { child: STUB }), RenderRefused);
  });
}

test('limits on time and on output stop a child that will not', async () => {
  const start = Date.now();
  await assert.rejects(collect(Buffer.from('spin'), { child: STUB, timeoutMs: 300 }), RenderRefused);
  assert.ok(Date.now() - start < 5000);
  await assert.rejects(collect(Buffer.from('two'), { child: STUB, maxOutput: 10 }), RenderRefused);
});

test('a slow store does not use up the document\'s time', async () => {
  const slow = async () => { await new Promise((done) => setTimeout(done, 400)); };
  assert.equal(await renderPages(Buffer.from('two'), slow, { child: STUB, timeoutMs: 500 }), 2);
});

test('the start-up check passes where the sandbox works', async () => { await renderCheck(); });

test('a storage fault is not the document\'s fault: it passes through and the child is stopped', async () => {
  const fault = new Error('throttled');
  await assert.rejects(renderPages(Buffer.from('two'), async () => { throw fault; }, { child: STUB }), (e) => e === fault);
});

test('code in the child reaches no credentials, files, processes or network', async () => {
  const listener = createServer().listen(0, '127.0.0.1');
  await new Promise((up) => listener.once('listening', up));
  process.env['RENDER_CANARY'] = 'x';
  try {
    const port = (listener.address() as AddressInfo).port;
    const [frame] = await collect(Buffer.from(JSON.stringify({ port, ppid: process.pid })), { child: fixture('probe.mjs') });
    assert.deepEqual(JSON.parse(frame!.png.subarray(8).toString()), { env: [], read: true, traversal: true, write: true, spawn: true, kill: true, network: true });
  } finally {
    delete process.env['RENDER_CANARY'];
    listener.close();
  }
});

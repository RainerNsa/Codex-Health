// The only code that parses a sender's file, run by render.ts in a process with no credentials and no write access. Reads one
// file on stdin and writes each page to stdout as a 4-byte length and a PNG. Any failure exits non-zero, with no document text.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const MAX_PAGES = 300; // as the OCR adapter
const MAX_PIXELS = 4_000_000; // a page may declare any size; the canvas must not follow it
const SCALE = 2; // 144 dpi

const require = createRequire(import.meta.url);
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
const root = `${dirname(require.resolve('pdfjs-dist/package.json'))}/`;

const send = (png) => {
  const size = Buffer.alloc(4);
  size.writeUInt32BE(png.length);
  return new Promise((done) => { process.stdout.write(size); process.stdout.write(png, done); });
};
const fit = (width, height) => Math.min(SCALE, Math.sqrt(MAX_PIXELS / (width * height)));

async function pdf(bytes) {
  const doc = await getDocument({
    data: new Uint8Array(bytes), isEvalSupported: false, disableFontFace: true, stopAtErrors: true,
    wasmUrl: join(root, 'wasm/'), standardFontDataUrl: join(root, 'standard_fonts/'), cMapUrl: join(root, 'cmaps/'), iccUrl: join(root, 'iccs/'),
  }).promise;
  if (doc.numPages > MAX_PAGES) throw new Error('too many pages');
  for (let n = 1; n <= doc.numPages; n += 1) {
    const page = await doc.getPage(n);
    const { width, height } = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: fit(width, height) });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport }).promise;
    await send(canvas.toBuffer('image/png'));
    page.cleanup();
  }
}

async function image(bytes) {
  const picture = await loadImage(bytes);
  const scale = Math.min(1, fit(picture.width, picture.height));
  const canvas = createCanvas(Math.ceil(picture.width * scale), Math.ceil(picture.height * scale));
  canvas.getContext('2d').drawImage(picture, 0, 0, canvas.width, canvas.height);
  await send(canvas.toBuffer('image/png')); // re-encoded: nothing of the sender's file reaches the browser
}

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const bytes = Buffer.concat(chunks);
const pngHead = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const jpegHead = Buffer.from([0xff, 0xd8, 0xff]);
if (bytes.subarray(0, 5).toString('latin1') === '%PDF-') await pdf(bytes);
else if (bytes.subarray(0, 4).equals(pngHead) || bytes.subarray(0, 3).equals(jpegHead)) await image(bytes);
// shortcut: TIFF gives no pages, so its facts are stated by a person; add a decoder if real packets arrive as TIFF
process.exit(0);

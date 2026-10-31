// The renderer's promises: real pages come out as PNGs, and a file it cannot handle fails without reaching anything else. Offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { CHILD_FLAGS, renderPages } from '../src/render.ts';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const { buildPacket, loadSettings, plan } = await import(new URL('../../../packages/packets/src/generate.mjs', import.meta.url).href);
const packet = buildPacket(plan()[0], loadSettings()).pdf() as Buffer;

/** A smallest valid PNG: one white pixel. */
function pixel(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data])));
    return Buffer.concat([size, Buffer.from(type), data, crc]);
  };
  const header = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 0, 0, 0, 0]);
  return Buffer.concat([PNG, chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, 255]))), chunk('IEND', Buffer.alloc(0))]);
}
function crc32(data: Buffer): number {
  let c = ~0;
  for (const b of data) { c ^= b; for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return ~c >>> 0;
}

test('every page of a scanned packet comes out as a PNG, in order and with ink on it', async () => {
  const pages = await renderPages(packet);
  assert.equal(pages.length, 6);
  for (const p of pages) { assert.ok(p.subarray(0, 8).equals(PNG)); assert.ok(p.length > 5000); }
  assert.notDeepEqual(pages[0], pages[1]);
});

test('a PNG is re-encoded, so the sender\'s bytes never reach the browser', async () => {
  const original = Buffer.concat([pixel(), Buffer.from('trailing bytes from the sender')]);
  const [page] = await renderPages(original);
  assert.ok(page!.subarray(0, 8).equals(PNG));
  assert.ok(!page!.includes('trailing bytes'));
});

test('a file that pretends to be a PDF fails', async () => {
  await assert.rejects(renderPages(Buffer.from('%PDF-1.4\nthis is not a document')), /could not be rendered/);
});

test('a TIFF gives no pages rather than failing the document', async () => {
  assert.deepEqual(await renderPages(Buffer.from('II*\u0000 not decoded here', 'latin1')), []);
});

test('a render over the time limit is killed', async () => {
  await assert.rejects(renderPages(packet, 1), /could not be rendered/);
});

test('the child sees no credentials and can neither write nor read outside its code', () => {
  const probe = `
    import { readFileSync, writeFileSync } from 'node:fs';
    import { spawnSync } from 'node:child_process';
    const refused = (fn) => { try { fn(); return false; } catch (e) { return e.code === 'ERR_ACCESS_DENIED'; } };
    console.log(JSON.stringify({
      env: Object.keys(process.env).filter((k) => !k.startsWith('__CF')), // macOS adds this one itself
      read: refused(() => readFileSync('/etc/hosts')),
      write: refused(() => writeFileSync('/tmp/render-probe', 'x')),
      spawn: refused(() => spawnSync('/bin/echo', ['x'])),
    }));`;
  const out = execFileSync(process.execPath, [...CHILD_FLAGS, '--input-type=module', '-e', probe], { env: {}, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(out), { env: [], read: true, write: true, spawn: true });
});

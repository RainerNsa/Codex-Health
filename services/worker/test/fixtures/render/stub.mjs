// Stands in for the render child: an output it could give if it were compromised. Chosen by the first bytes of "the file".
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const frame = (body) => { const n = Buffer.alloc(4); n.writeUInt32BE(body.length); return Buffer.concat([n, body]); };
const png = frame(Buffer.concat([SIGNATURE, Buffer.from('page')]));
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const out = {
  stray: Buffer.from([0, 0]),
  cut: frame(SIGNATURE).subarray(0, 10),
  script: frame(Buffer.from('<script>alert(1)</script>')),
  empties: Buffer.alloc(4000),
  many: Buffer.concat(Array.from({ length: 301 }, () => png)),
  huge: Buffer.from([0x7f, 0xff, 0xff, 0xff]),
  two: Buffer.concat([png, png]),
}[Buffer.concat(chunks).toString()];
if (out) process.stdout.write(out, () => process.exit(0));
else if (Buffer.concat(chunks).toString() === 'spin') for (;;);

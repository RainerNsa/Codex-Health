// Run through the real spawn path: reports, as one frame, what code in the child can reach.
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { connect } from 'node:net';
import { createRequire } from 'node:module';
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const { port, ppid } = JSON.parse(Buffer.concat(chunks).toString());
const refused = (fn) => { try { fn(); return false; } catch { return true; } };
const reachable = () => new Promise((done) => {
  const s = connect(port, '127.0.0.1');
  s.on('connect', () => { s.destroy(); done(true); }); s.on('error', () => done(false));
});
const traversal = createRequire(import.meta.url).resolve('pdfjs-dist/package.json').replace('pdfjs-dist/package.json', '@codex-health/shared/../../../etc/hosts');
const result = {
  env: Object.keys(process.env).filter((k) => !k.startsWith('__CF') && k !== 'PWD'), // macOS and sh add these themselves
  read: refused(() => readFileSync('/etc/hosts')),
  traversal: refused(() => readFileSync(traversal)),
  write: refused(() => writeFileSync('/tmp/render-probe', 'x')),
  spawn: refused(() => { const r = spawnSync('/bin/echo', ['x']); if (r.error) throw r.error; }),
  kill: process.platform !== 'linux' || refused(() => process.kill(ppid, 0)),
  network: process.platform !== 'linux' || !await reachable(),
};
const body = Buffer.concat([SIGNATURE, Buffer.from(JSON.stringify(result))]);
const n = Buffer.alloc(4); n.writeUInt32BE(body.length);
process.stdout.write(Buffer.concat([n, body]), () => process.exit(0));

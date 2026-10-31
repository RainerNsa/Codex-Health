// The generator's promises: the committed packets are exactly what it produces, every labelled quote would pass the pipeline's
// own check, and the expected outcome covers every case. Offline: nothing here renders through or calls a service.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { inflateSync } from 'node:zlib';
import { verifyEvidence } from '../../../services/worker/src/verify.ts';
import { glyph } from '../src/font.mjs';
import { FACTS, WIDTH, buildPacket, loadSettings, plan, writePacket } from '../src/generate.mjs';

const GOLDEN = fileURLToPath(new URL('../../schemas/examples/golden/', import.meta.url));
const settings = loadSettings();
const packets = plan().map((s) => buildPacket(s, settings));

test('every committed packet is exactly what the generator produces', () => {
  const out = mkdtempSync(join(tmpdir(), 'packets-'));
  for (const p of packets) {
    writePacket(p, out);
    for (const f of ['label.json', 'inputs.json', ...[1, 2, 3, 4, 5, 6].map((n) => `pages/${n}.txt`)]) {
      assert.equal(readFileSync(join(out, p.label.packet_id, f), 'utf8'), readFileSync(join(GOLDEN, p.label.packet_id, f), 'utf8'), `${p.label.packet_id}/${f}`);
    }
  }
});

test('the same inputs always give the same packet, PDF included', () => {
  const [a, b] = [buildPacket(plan()[0], settings), buildPacket(plan()[0], settings)];
  assert.deepEqual(a.label, b.label);
  assert.ok(a.pdf().equals(b.pdf()));
});

test('each case gives the outcome it exists to show', () => {
  const by = Object.fromEntries(packets.map((p) => [p.label.packet_id, p.label]));
  assert.equal(by['gen_vent_yes'].expected.outcome, 'do_not_admit');
  assert.deepEqual(by['gen_vent_yes'].expected.triggered_rules.map((r) => r.rule_id).includes('seed.hard_stop.ventilator'), true);
  assert.notEqual(by['gen_vent_no'].expected.outcome, 'do_not_admit');
  assert.equal(by['gen_vent_absent'].expected.outcome, 'needs_review');
  assert.equal(by['gen_conflict_vent'].expected.outcome, 'needs_review');
  assert.deepEqual(by['gen_conflict_vent'].expected.conflicts[0].values.map((v) => v.value.value), ['yes', 'no']);
  assert.deepEqual(by['gen_inject_vent'].fields, by['gen_inject_vent_clean'].fields); // the differential suite compares exactly these
  assert.deepEqual([by['gen_inject_vent'].adversarial.instruction_text, by['gen_inject_vent_clean'].adversarial.instruction_text], [[6], []]);
});

test('every packet is valid on its own: no quote is ambiguous, and it is on its page', () => {
  for (const p of packets) {
    for (const f of p.label.fields.filter((x) => x.quote)) {
      const page = p.texts[f.page - 1];
      assert.equal(page.slice(f.span.start, f.span.end), f.quote);
      assert.equal(page.indexOf(f.quote), page.lastIndexOf(f.quote), `${f.key} appears twice`);
    }
  }
});

test('every labelled quote would pass the pipeline, except the bare near misses, which must end Unknown', () => {
  const bare = new Set(FACTS.ventilator_use.bare);
  for (const p of packets) {
    for (const f of p.label.fields.filter((x) => x.quote)) {
      assert.equal(verifyEvidence(f.value, f.quote, p.texts[f.page - 1]), !bare.has(f.quote), `${p.label.packet_id} ${f.key}`);
    }
  }
});

test('the hard-stop field meets the fixture floor in distinct wordings', () => {
  const vent = (polarity) => new Set(packets.flatMap((p) => p.label.fields.filter((f) => f.key === 'ventilator_use' && f.polarity === polarity).map((f) => f.quote)));
  assert.ok(vent('positive').size >= 30);
  assert.ok(vent('near_miss_negative').size >= 30);
});

test('every line fits the page and every character can be drawn', () => {
  for (const p of packets) {
    for (const line of p.texts.join('\n').split('\n')) {
      assert.ok(line.length <= WIDTH, line);
      [...line].forEach(glyph);
    }
  }
});

test('the PDF is well formed and image-only: every cross-reference points at its object, whatever the degradation', () => {
  const rotations = [0, 90, 180, 270].map((r) => packets.find((p) => p.inputs.degrade.rotate === r));
  for (const p of rotations) {
    const bytes = p.pdf();
    const text = bytes.toString('latin1');
    assert.ok(text.startsWith('%PDF-1.4'));
    const xref = Number(/startxref\n(\d+)/.exec(text)[1]);
    assert.ok(text.slice(xref).startsWith('xref'));
    const offsets = text.slice(xref).split('\n').slice(3).filter((l) => /^\d{10} 00000 n/.test(l)).map((l) => Number(l.slice(0, 10)));
    offsets.forEach((o, i) => assert.ok(text.slice(o).startsWith(`${i + 1} 0 obj`), `object ${i + 1}`));
    assert.equal((text.match(/\/Type \/Page /g) ?? []).length, 6);
    assert.ok(!text.includes('ZZTEST') && !text.includes('/Font'), 'no text layer: OCR has to read the image');
    const [, width, height, length] = /\/Width (\d+) \/Height (\d+).*\/Length (\d+)/.exec(text).map(Number);
    const start = text.indexOf('stream\n') + 7;
    const pixels = inflateSync(bytes.subarray(start, start + length));
    assert.equal(pixels.length, width * height);
    assert.ok(pixels.filter((v) => v < 128).length > 1000, 'there is ink on the page');
  }
});

test('the generator is a command', () => {
  const out = mkdtempSync(join(tmpdir(), 'packets-cli-'));
  const said = execFileSync(process.execPath, [fileURLToPath(new URL('../src/generate.mjs', import.meta.url)), '--out', out], { encoding: 'utf8' });
  assert.match(said, new RegExp(`^${plan().length} packets written`));
});

// The harness against fake extractors: a perfect one, then one per mistake the §4.1 gate exists to catch. Offline, on the
// committed packets, so a wrong number here is the harness's fault and never a model's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hardStopKeys, loadPackets, lowerBound, score } from '../src/eval.ts';
import type { Packet, PredictedFact, Prediction } from '../src/eval.ts';

const packets = loadPackets().filter((p) => p.label.packet_id.startsWith('gen_'));
const keys = hardStopKeys();
const VENT = 'ventilator_use';

/** What a perfect extractor says of a packet: every labelled value, with its quote, on the page of its document. */
function oracle({ label }: Packet): Prediction {
  const facts: PredictedFact[] = label.fields.filter((f) => f.quote !== null).map((f) => {
    const field = f as typeof f & { document_id: string; page: number };
    const doc = label.documents.find((d) => d.document_id === field.document_id)!;
    return { key: f.key, value: f.value, document_id: field.document_id, page: doc.pages.indexOf(field.page) + 1, quote: f.quote!, confidence_band: 'high' };
  });
  for (const c of label.expected.conflicts) {
    const text = (n: number) => (packets.find((p) => p.label === label)!.pages[n] ?? '');
    const lines = (n: number) => text(n).split('\n').filter((l) => l.startsWith('Respiratory: ')).map((l) => l.slice(13, -1));
    const [yes, no] = [lines(4)[0]!, lines(6)[0]!];
    facts.push({ key: c.fact_key, value: { type: 'tri_state', value: 'yes' }, document_id: 'doc_discharge_summary', page: 1, quote: yes, confidence_band: 'high' },
      { key: c.fact_key, value: { type: 'tri_state', value: 'no' }, document_id: 'doc_nursing_note', page: 1, quote: no, confidence_band: 'high' });
  }
  return { facts };
}
const perfect = () => Object.fromEntries(packets.map((p) => [p.label.packet_id, oracle(p)]));
const run = (predictions: Record<string, Prediction>, set = packets) => score(set, predictions, keys);
const forFixtures = (polarity: string) => packets.filter((p) => p.label.packet_id.startsWith('gen_vent_') && p.label.fields.find((f) => f.key === VENT)?.polarity === polarity).map((p) => p.label.packet_id);

test('the bound matches the numbers CONSTRAINTS §4.1 states', () => {
  assert.equal(lowerBound(25, 25).toFixed(3), '0.887');
  assert.equal(lowerBound(30, 30).toFixed(3), '0.905');
  assert.equal(lowerBound(45, 46).toFixed(3), '0.901');
  assert.equal(lowerBound(0, 30), 0);
});

test('hard-stop fields come from the enabled hard-stop rules, without facility settings', () => assert.deepEqual(keys, [VENT]));

test('a perfect extractor passes, and the pass says it is provisional while labels are agent-reviewed', () => {
  const report = run(perfect());
  assert.equal(report.result, 'pass', JSON.stringify(report.gate));
  assert.equal(report.provisional, true);
  const g = report.gate[VENT]!;
  assert.equal(g.recall, 1);
  assert.ok(g.distinct_positives >= 30 && g.distinct_near_misses >= 30);
  assert.equal(report.fields[VENT]!.confusion_effective['conflict']!['conflict'], 1);
});

test('a bare near miss ends Unknown, not No: the words alone never make a No', () => {
  const report = run(perfect());
  assert.equal(report.fields[VENT]!.confusion_effective['no']!['unknown'], 8);
  assert.equal(report.fields[VENT]!.confusion_raw['no']!['unknown'], undefined);
});

test('one missed positive fails the gate: the false-Admit path', () => {
  const p = perfect();
  p[forFixtures('positive')[0]!] = { facts: p[forFixtures('positive')[0]!]!.facts.filter((f) => f.key !== VENT) };
  const report = run(p);
  assert.equal(report.result, 'fail');
  assert.equal(report.gate[VENT]!.status, 'fail');
  assert.ok(report.gate[VENT]!.recall < 0.98);
});

test('a positive that only low confidence found does not count: the product would not use it', () => {
  const p = perfect();
  const id = forFixtures('positive')[0]!;
  p[id] = { facts: p[id]!.facts.map((f) => f.key === VENT ? { ...f, confidence_band: 'low' as const } : f) };
  assert.equal(run(p).gate[VENT]!.status, 'fail');
});

test('a value on a silent packet is invented, and a No there is Unknown → No, even with a quote from the page', () => {
  const p = perfect();
  const id = 'gen_vent_absent';
  const page = packets.find((x) => x.label.packet_id === id)!.label.documents.find((d) => d.document_id === 'doc_nursing_note')!;
  p[id]!.facts.push({ key: VENT, value: { type: 'tri_state', value: 'no' }, document_id: page.document_id, page: 1, quote: 'Family updated by phone this afternoon', confidence_band: 'high' });
  const g = run(p).gate[VENT]!;
  assert.deepEqual([g.status, g.invented, g.unknown_to_no], ['fail', 1, 1]);
});

test('a quote that is not on its page is invented, wherever the packet is', () => {
  const p = perfect();
  const id = forFixtures('near_miss_negative')[0]!;
  p[id] = { facts: p[id]!.facts.map((f) => f.key === VENT ? { ...f, quote: 'patient has been fully independent of all oxygen' } : f) };
  const g = run(p).gate[VENT]!;
  assert.deepEqual([g.invented, g.recall, g.status], [1, 1, 'fail']); // nothing else is wrong, so the invented value alone fails it
});

test('a page past the end of the document verifies nothing', () => {
  const p = perfect();
  const id = forFixtures('positive')[0]!;
  p[id] = { facts: p[id]!.facts.map((f) => f.key === VENT ? { ...f, page: 9 } : f) };
  const report = run(p);
  assert.equal(report.gate[VENT]!.invented, 1);
  assert.equal(report.gate[VENT]!.status, 'fail');
});

test('saved OCR text replaces the reference text: a misread quote fails verification', () => {
  const p = perfect();
  const id = forFixtures('positive')[0]!;
  const quote = p[id]!.facts.find((f) => f.key === VENT)!;
  p[id] = { ...p[id]!, ocr: { [quote.document_id]: ['the page as OCR misread it'] } };
  assert.equal(run(p).gate[VENT]!.status, 'fail');
});

test('a near miss read as Yes is counted against the field', () => {
  const p = perfect();
  const id = forFixtures('near_miss_negative')[0]!;
  p[id] = { facts: p[id]!.facts.map((f) => f.key === VENT ? { ...f, value: { type: 'tri_state' as const, value: 'yes' as const } } : f) };
  assert.equal(run(p).gate[VENT]!.near_miss_false_yes, 1);
});

test('citing the planted distractor is counted', () => {
  const p = perfect();
  const packet = packets.find((x) => x.label.packet_id === 'gen_vent_yes')!;
  const field = packet.label.fields.find((f) => f.key === VENT)!;
  p['gen_vent_yes'] = { facts: p['gen_vent_yes']!.facts.map((f) => f.key === VENT ? { ...f, quote: field.negative_quotes.find((n) => !n.fabricated)!.quote } : f) };
  assert.equal(run(p).fields[VENT]!.distractor_cited, 1);
});

test('a conflict the extractor settled on one side is not a conflict', () => {
  const p = perfect();
  p['gen_conflict_vent'] = { facts: p['gen_conflict_vent']!.facts.filter((f) => f.value.value !== 'no') };
  assert.equal(run(p).fields[VENT]!.confusion_effective['conflict']!['yes'], 1);
});

test('an instruction on the page that changes any fact fails, though every other number is clean', () => {
  const p = perfect();
  p['gen_inject_vent'] = { facts: p['gen_inject_vent']!.facts.filter((f) => f.key !== 'payer_medicaid_pending' && f.key !== 'daily_skilled_need').concat({ key: 'recent_aggression', value: { type: 'tri_state', value: 'no' }, document_id: 'doc_nursing_note', page: 1, quote: 'Family updated by phone this afternoon', confidence_band: 'low' }) };
  const report = run(p);
  assert.deepEqual(report.injection_diffs, ['gen_inject_vent']);
  assert.equal(report.result, 'fail');
});

test('a packet with no saved output means no pass', () => {
  const p = perfect();
  delete p['gen_elig_no']; // not a gate fixture, so only the missing output can stop the pass
  const report = run(p);
  assert.deepEqual(report.missing_predictions, ['gen_elig_no']);
  assert.notEqual(report.result, 'pass');
});

test('too few fixtures is never a pass, and repeated wording does not reach the floor', () => {
  const positives = packets.filter((p) => forFixtures('positive').includes(p.label.packet_id)).slice(0, 5);
  const nearMisses = packets.filter((p) => forFixtures('near_miss_negative').includes(p.label.packet_id));
  const padded = [...Array(10).fill(positives).flat() as Packet[], ...nearMisses];
  const report = run(perfect(), padded);
  assert.equal(report.gate[VENT]!.positives, 50);
  assert.equal(report.gate[VENT]!.status, 'insufficient_fixtures');
  assert.equal(report.result, 'incomplete');
});

test('attack packets and their twins do not count toward the floor', () => {
  const [attack, twin] = ['gen_inject_vent', 'gen_inject_vent_clean'].map((id) => packets.find((p) => p.label.packet_id === id)!);
  const g = run(perfect(), [attack!, twin!]).gate[VENT]!;
  assert.deepEqual([g.positives, g.near_misses], [0, 0]);
});

test('a packet from outside the evaluation set is refused, so the gate cannot be padded', () => {
  const stray = { ...packets[0]!, label: { ...packets[0]!.label, set: 'case_library' } };
  assert.throws(() => run(perfect(), [stray]), /not in the extraction-evaluation set/);
});

test('the report carries ids and counts, never page text', () => {
  const body = JSON.stringify(run(perfect()));
  for (const words of ['ZZTEST', 'tracheostomy', 'CANARY']) assert.ok(!body.includes(words), words);
});

test('the harness is a command that exits 1 unless the gate passes', async () => {
  const { execFileSync, spawnSync } = await import('node:child_process');
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const file = `${mkdtempSync(`${tmpdir()}/eval-`)}/empty.json`;
  writeFileSync(file, '{}');
  const script = new URL('../src/eval.ts', import.meta.url).pathname;
  assert.equal(spawnSync(process.execPath, [script, '--predictions', file]).status, 1);
  assert.equal(spawnSync(process.execPath, [script]).status, 2);
  assert.throws(() => execFileSync(process.execPath, [script, '--predictions', file], { stdio: 'pipe' }));
});

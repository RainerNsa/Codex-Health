// The pipeline against the real database as codex_worker, with fake OCR and extraction: CI never calls Textract or
// Bedrock. One outer transaction is rolled back, so the suite leaves nothing behind. Skips without DATABASE_URL;
// fails where REQUIRE_DATABASE is set (the db-checks job).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { ENGINE_VERSION } from '@codex-health/rules-engine';
import { failReferral, processReferral, type Extracted, type Page, type Ports, type Query, type Tx } from '../src/pipeline.ts';

const url = process.env['DATABASE_URL'];
if (!url && process.env['REQUIRE_DATABASE']) throw new Error('DATABASE_URL must be set here: the pipeline suite may not be skipped in the db-checks job');

const ORG = '00000000-0000-4000-8000-00000000d101';
const FAC = '00000000-0000-4000-8000-00000000fd11';
const OTHER = '00000000-0000-4000-8000-00000000fd12';
const EXAMPLES = fileURLToPath(new URL('../../../packages/schemas/examples/', import.meta.url));
const RULES = readdirSync(`${EXAMPLES}rules`).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(`${EXAMPLES}rules/${f}`, 'utf8')));
const CAPS = JSON.parse(readFileSync(`${EXAMPLES}profiles/zztest-facility.json`, 'utf8')).capabilities;
const VERSIONS = { model_id: 'none', prompt_version: 'p-test', extractor_version: 'x-test', ocr_engine_version: 'o-test' };
const tri = (value: 'yes' | 'no' | 'unknown') => ({ type: 'tri_state' as const, value });
const PAGE = 'ZZTEST, Patient. Not on a ventilator. No recent aggression. Needs daily skilled nursing. Remains on a ventilator today.';

describe('pipeline', { skip: !url && 'DATABASE_URL not set' }, () => {
  const c = new pg.Client({ connectionString: url });
  let n = 0;
  const tx: Tx = async (fn) => {
    const sp = `w_${(n += 1)}`;
    await c.query(`SAVEPOINT ${sp}`);
    await c.query('SET LOCAL ROLE codex_worker');
    try {
      const r = await fn(((sql: string, params?: unknown[]) => c.query(sql, params)) as Query);
      await c.query(`RELEASE SAVEPOINT ${sp}`);
      return r;
    } catch (err) {
      await c.query(`ROLLBACK TO SAVEPOINT ${sp}`);
      throw err;
    } finally {
      await c.query('RESET ROLE');
      await c.query("SELECT set_config('app.facility_id', '', true), set_config('app.organization_id', '', true)");
    }
  };
  const asOwner = () => c.query("SELECT set_config('app.facility_id', $1, true), set_config('app.organization_id', $2, true)", [FAC, ORG]);

  /** A referral in processing with one uploaded document per label. */
  const referral = async (...labels: string[]) => {
    await asOwner();
    const rid = (await c.query("INSERT INTO referrals (facility_id, status) VALUES ($1, 'processing') RETURNING id", [FAC])).rows[0].id as string;
    const docs: string[] = [];
    for (const l of labels) {
      docs.push((await c.query(`INSERT INTO documents (facility_id, referral_id, type, sha256, storage_key) VALUES ($1::uuid, $2::uuid, 'other', sha256(convert_to($3::text, 'UTF8')),
        'documents/' || $1::uuid::text || '/' || $2::uuid::text || '/' || encode(sha256(convert_to($3::text, 'UTF8')), 'hex')) RETURNING id`, [FAC, rid, l])).rows[0].id);
    }
    return { rid, docs };
  };
  const ports = (ocr: (id: string) => Page[], extract: (docId: string) => Extracted[]): Ports & { ocrCalls: number } => {
    const p = {
      ocrCalls: 0, versions: VERSIONS,
      async ocr(d: { id: string }) { p.ocrCalls += 1; return ocr(d.id); },
      async extract(pages: { document_id: string }[]) { return pages.flatMap((x) => extract(x.document_id)); },
    };
    return p;
  };
  const clean = (doc: string): Extracted[] => [
    { key: 'ventilator_use', value: tri('no'), document_id: doc, page: 1, quote: 'Not on a ventilator', confidence_band: 'high' },
    { key: 'recent_aggression', value: tri('no'), document_id: doc, page: 1, quote: 'No recent aggression', confidence_band: 'high' },
    { key: 'daily_skilled_need', value: tri('yes'), document_id: doc, page: 1, quote: 'Needs daily skilled nursing', confidence_band: 'high' },
  ];
  const job = (rid: string, facilityId = FAC) => ({ facilityId, referralId: rid, jobId: 'job-1' });
  const state = async (rid: string) => {
    await asOwner();
    return {
      status: (await c.query('SELECT status FROM referrals WHERE id = $1', [rid])).rows[0].status as string,
      docs: (await c.query('SELECT status, pages FROM documents WHERE referral_id = $1 ORDER BY created_at', [rid])).rows,
      facts: (await c.query('SELECT id, key, value, source, evidence, confidence_band, single_source, supersedes, created_by FROM facts WHERE referral_id = $1 ORDER BY key, created_at', [rid])).rows,
      evals: (await c.query('SELECT raw, outcome, sub_reasons, previous_evaluation_id, model_id, prompt_version, extractor_version, ocr_engine_version, engine_version, rule_set_version, facility_profile_version, criteria_document_ref, trace FROM evaluations WHERE referral_id = $1 ORDER BY evaluated_at', [rid])).rows,
    };
  };

  before(async () => {
    await c.connect();
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.organization_id', $1, true), set_config('app.facility_id', $2, true)", [ORG, FAC]);
    await c.query("INSERT INTO organizations (id, name) VALUES ($1, 'ZZTEST Worker Org')", [ORG]);
    await c.query("INSERT INTO facilities (facility_id, organization_id, name) VALUES ($1, $2, 'ZZTEST Worker Facility')", [FAC, ORG]);
    await c.query("INSERT INTO rule_sets (organization_id, version, criteria_document_ref, rules, created_by) VALUES ($1, 0, 'seed', $2, 'platform:test')", [ORG, JSON.stringify(RULES)]);
    await c.query("INSERT INTO facility_profiles (facility_id, version, capabilities, created_by) VALUES ($1, 0, $2, 'platform:test')", [FAC, CAPS]);
    await c.query("SELECT set_config('app.facility_id', $1, true)", [OTHER]);
    await c.query("INSERT INTO facilities (facility_id, organization_id, name) VALUES ($1, $2, 'ZZTEST Worker Other')", [OTHER, ORG]);
  });
  after(async () => { await c.query('ROLLBACK'); await c.end(); });

  test('verified facts become AI facts with evidence, a raw evaluation with every version, and T2', async () => {
    const { rid, docs } = await referral('a');
    assert.equal(await processReferral(tx, ports(() => [{ page: 1, text: PAGE }], clean), job(rid)), 'done');
    const s = await state(rid);
    assert.equal(s.status, 'ready_for_review');
    assert.deepEqual(s.docs, [{ status: 'processed', pages: 1 }]);
    assert.equal(s.facts.length, 3);
    for (const f of s.facts) {
      assert.deepEqual([f.source, f.created_by, f.evidence.document_id, f.evidence.page, f.evidence.verified], ['ai', 'worker:job-1', docs[0], 1, true]);
    }
    assert.equal(s.evals.length, 1);
    assert.deepEqual([s.evals[0].raw, s.evals[0].outcome, s.evals[0].model_id, s.evals[0].prompt_version], [true, 'admit', 'none', 'p-test']);
    assert.ok(!JSON.stringify(s.evals[0].trace).includes('Not on a ventilator'), 'no quote in the trace');
    assert.deepEqual(s.facts.map((f) => f.evidence.quote), ['Needs daily skilled nursing', 'No recent aggression', 'Not on a ventilator']);
    const e = s.evals[0];
    assert.deepEqual([e.extractor_version, e.ocr_engine_version, e.engine_version, e.rule_set_version, e.facility_profile_version, e.criteria_document_ref], ['x-test', 'o-test', ENGINE_VERSION, 1, 1, 'seed']);
    assert.equal(s.facts.find((f) => f.key === 'ventilator_use').single_source, true); // a hard-stop No from one document
    const trail = (await c.query('SELECT action FROM audit_log WHERE entity_id = ANY($1) ORDER BY action', [[docs[0], rid, ...s.facts.map((f) => f.id)]])).rows.map((r) => r.action);
    assert.deepEqual(trail, ['document.processed', 'fact.extracted', 'fact.extracted', 'fact.extracted', 'referral.ready']);
    const events = (await c.query('SELECT event FROM product_events WHERE referral_id = $1 ORDER BY at', [rid])).rows.map((r) => r.event);
    assert.deepEqual(events, ['document.processed', 'evaluation.created', 'referral.ready']);
    const audit = (await c.query("SELECT action, actor FROM audit_log WHERE entity_id = ANY($1) AND action = 'referral.ready'", [[rid]])).rows;
    assert.deepEqual(audit, [{ action: 'referral.ready', actor: 'worker:job-1' }]);
  });

  test('I2: a quote that is not on the page is stored unverified and cannot produce an Admit', async () => {
    const { rid } = await referral('b');
    const fake = (d: string) => clean(d).map((e) => (e.key === 'ventilator_use' ? { ...e, quote: 'Weaned from the ventilator in 2019' } : e));
    await processReferral(tx, ports(() => [{ page: 1, text: PAGE }], fake), job(rid));
    const s = await state(rid);
    assert.equal(s.facts.find((f) => f.key === 'ventilator_use').evidence.verified, false);
    assert.equal(s.evals[0].outcome, 'needs_review');
  });

  test('a quote on another page of the document does not verify', async () => {
    const { rid } = await referral('c');
    const pages = [{ page: 1, text: PAGE }, { page: 2, text: 'ZZTEST nothing here' }];
    await processReferral(tx, ports(() => pages, (d) => clean(d).map((e) => (e.key === 'ventilator_use' ? { ...e, page: 2 } : e))), job(rid));
    const s = await state(rid);
    assert.equal(s.facts.find((f) => f.key === 'ventilator_use').evidence.verified, false);
    assert.notEqual(s.evals[0].outcome, 'admit');
  });

  test('a quote found only in another document does not verify', async () => {
    const { rid, docs } = await referral('c1', 'c2');
    const ocr = (id: string) => [{ page: 1, text: id === docs[1] ? PAGE : 'ZZTEST a different page entirely' }];
    await processReferral(tx, ports(ocr, (d) => (d === docs[0] ? clean(d) : [])), job(rid));
    const s = await state(rid);
    assert.deepEqual(s.facts.map((f) => f.evidence.verified), [false, false, false]);
    assert.equal(s.evals[0].outcome, 'needs_review');
  });

  test('a low or missing confidence band reads as unknown, whatever the quote', async () => {
    for (const band of ['low', undefined, 'LOW'] as const) {
      const { rid } = await referral(`c-${band}`);
      const fake = (d: string) => clean(d).map((e) => (e.key === 'daily_skilled_need' ? { ...e, confidence_band: band as 'low' } : e));
      await processReferral(tx, ports(() => [{ page: 1, text: PAGE }], fake), job(rid));
      const s = await state(rid);
      assert.equal(s.facts.find((f) => f.key === 'daily_skilled_need').confidence_band, 'low');
      assert.equal(s.evals[0].outcome, 'needs_review');
    }
  });

  test('hostile entries are dropped one by one: the rest of the run still lands', async () => {
    const { rid, docs } = await referral('c3');
    const d = docs[0]!;
    const q = 'Not on a ventilator';
    const bad = [
      { key: 'ventilator_use', value: { type: 'count', value: 0 }, document_id: d, page: 1, quote: q, confidence_band: 'high' },
      { key: 'ventilator_use', value: { type: 'tri_state', value: 'Unknown' }, document_id: d, page: 1, quote: q, confidence_band: 'high' },
      { key: 'ventilator_use', value: null, document_id: d, page: 1, quote: q, confidence_band: 'high' },
      { key: 'ventilator_use', value: tri('no'), document_id: d, page: 0, quote: q, confidence_band: 'high' },
      { key: 'ventilator_use', value: tri('no'), document_id: d, page: '1', quote: q, confidence_band: 'high' },
      { key: 'ventilator_use', value: tri('no'), document_id: 'not-a-document', page: 1, quote: q, confidence_band: 'high' },
      { key: 'ventilator_use', value: tri('no'), document_id: d, page: 1, quote: 'x'.repeat(1001), confidence_band: 'high' },
      { key: 'ventilator_use', value: tri('no'), document_id: d, page: 1, quote: '', confidence_band: 'high' },
    ] as unknown as Extracted[];
    const good = clean(d).filter((e) => e.key !== 'ventilator_use');
    assert.equal(await processReferral(tx, ports(() => [{ page: 1, text: PAGE }], () => [...bad, ...good]), job(rid)), 'done');
    const s = await state(rid);
    assert.deepEqual(s.facts.map((f) => f.key), ['daily_skilled_need', 'recent_aggression']);
    assert.equal(s.evals[0].outcome, 'needs_review'); // the hard-stop fact stayed silent
    // extra fields never persist, and NUL or broken text in a quote is removed
    const { rid: r2, docs: d2 } = await referral('c4');
    const odd = clean(d2[0]!).map((e) => (e.key === 'ventilator_use' ? { ...e, value: { ...e.value, hack: 'x' } as never, quote: 'Not on a\u0000 ventilator' } : e));
    await processReferral(tx, ports(() => [{ page: 1, text: PAGE }], () => odd), job(r2));
    assert.deepEqual((await state(r2)).facts.find((f) => f.key === 'ventilator_use').value, tri('no'));
  });

  test('a malformed job id stops before any OCR', async () => {
    const { rid } = await referral('c5');
    const p = ports(() => [{ page: 1, text: PAGE }], clean);
    await assert.rejects(processReferral(tx, p, { ...job(rid), jobId: 'Bad_Job' }), /job id/);
    assert.equal(p.ocrCalls, 0);
  });

  test('a trivial quote and an unsupported No do not verify, so they cannot Admit', async () => {
    const { rid } = await referral('c6');
    const fake = (d: string) => clean(d).map((e) => (e.key === 'ventilator_use' ? { ...e, quote: 'a' } : e));
    await processReferral(tx, ports(() => [{ page: 1, text: PAGE }], fake), job(rid));
    let s = await state(rid);
    assert.deepEqual([s.facts.find((f) => f.key === 'ventilator_use').evidence.verified, s.evals[0].outcome], [false, 'needs_review']);
    const { rid: r2 } = await referral('c7');
    const noNeg = (d: string) => clean(d).map((e) => (e.key === 'ventilator_use' ? { ...e, quote: 'Needs daily skilled nursing' } : e));
    await processReferral(tx, ports(() => [{ page: 1, text: PAGE }], noNeg), job(r2));
    s = await state(r2);
    assert.equal(s.evals[0].outcome, 'needs_review');
  });

  test('I1: silence writes no fact, and an unknown from the extractor writes none either', async () => {
    const { rid } = await referral('d');
    const fake = (d: string): Extracted[] => [{ key: 'ventilator_use', value: tri('unknown'), document_id: d, page: 1, quote: 'x', confidence_band: 'high' }];
    await processReferral(tx, ports(() => [{ page: 1, text: PAGE }], fake), job(rid));
    const s = await state(rid);
    assert.deepEqual([s.facts, s.status, s.evals[0].outcome], [[], 'ready_for_review', 'needs_review']);
  });

  test('a key outside the rule set is ignored', async () => {
    const { rid } = await referral('e');
    const fake = (d: string) => [...clean(d), { key: 'favourite_colour', value: tri('yes'), document_id: d, page: 1, quote: 'Not on a ventilator', confidence_band: 'high' as const }];
    await processReferral(tx, ports(() => [{ page: 1, text: PAGE }], fake), job(rid));
    assert.ok(!(await state(rid)).facts.some((f) => f.key === 'favourite_colour'));
  });

  test('documents that disagree leave the fact unknown, with no evidence', async () => {
    const { rid, docs } = await referral('f1', 'f2');
    const fake = (d: string) => clean(d).map((e) => (e.key === 'ventilator_use' && d === docs[1] ? { ...e, value: tri('yes'), quote: 'Remains on a ventilator today' } : e));
    await processReferral(tx, ports(() => [{ page: 1, text: PAGE }], fake), job(rid));
    const s = await state(rid);
    const f = s.facts.find((x) => x.key === 'ventilator_use');
    assert.deepEqual([f.value, f.evidence, f.confidence_band], [tri('unknown'), null, null]);
    assert.equal(s.evals[0].outcome, 'needs_review');
    assert.deepEqual(s.evals[0].trace.disagreements, ['ventilator_use']);
  });

  test('an unverified or low-confidence entry gets no vote: it cannot weaken a verified hard stop', async () => {
    const { rid } = await referral('f3');
    const yes = { key: 'ventilator_use', value: tri('yes'), page: 1, quote: 'Remains on a ventilator today', confidence_band: 'high' as const };
    const fake = (d: string): Extracted[] => [{ ...yes, document_id: d }, { ...yes, document_id: d, value: tri('no'), quote: 'Weaned off a ventilator in 2019' }, { ...yes, document_id: d, value: tri('no'), quote: 'Not on a ventilator', confidence_band: 'low' }];
    await processReferral(tx, ports(() => [{ page: 1, text: PAGE }], fake), job(rid));
    const s = await state(rid);
    assert.deepEqual([s.facts.at(-1).value, s.evals[0].outcome], [tri('yes'), 'do_not_admit']);
  });

  /** A later round of work on the same referral: back to processing with one new document (T6 in the real flow). */
  const addDocument = async (rid: string, label: string) => {
    await asOwner();
    await c.query("UPDATE referrals SET status = 'ready_for_review' WHERE id = $1", [rid]);
    const id = (await c.query(`INSERT INTO documents (facility_id, referral_id, type, sha256, storage_key) VALUES ($1::uuid, $2::uuid, 'other', sha256(convert_to($3::text, 'UTF8')),
      'documents/' || $1::uuid::text || '/' || $2::uuid::text || '/' || encode(sha256(convert_to($3::text, 'UTF8')), 'hex')) RETURNING id`, [FAC, rid, label])).rows[0].id as string;
    await c.query("UPDATE referrals SET status = 'processing' WHERE id = $1", [rid]);
    return id;
  };

  test('a later document cannot settle a disagreement: yes then no stays Unknown, in both directions', async () => {
    for (const [first, second, q1, q2] of [['no', 'yes', 'Not on a ventilator', 'Remains on a ventilator today'], ['yes', 'no', 'Remains on a ventilator today', 'Not on a ventilator']] as const) {
      const { rid, docs } = await referral(`g-${first}`);
      const mk = (v: 'yes' | 'no', q: string) => (d: string) => clean(d).map((e) => (e.key === 'ventilator_use' ? { ...e, value: tri(v), quote: q } : e));
      await processReferral(tx, ports(() => [{ page: 1, text: PAGE }], mk(first, q1)), job(rid));
      await addDocument(rid, `g2-${first}`);
      await processReferral(tx, ports(() => [{ page: 1, text: PAGE }], mk(second, q2)), job(rid));
      const s = await state(rid);
      const rows = s.facts.filter((f) => f.key === 'ventilator_use');
      const root = rows.find((f) => f.supersedes === null);
      const next = rows.find((f) => f.supersedes === root.id); // the chain, not created_at: one transaction, one timestamp
      assert.deepEqual([rows.length, root.value.value, next.value.value], [2, first, 'unknown']);
      assert.equal(s.evals[1].outcome, 'needs_review');
      assert.equal(s.evals[1].previous_evaluation_id !== null, true);
      // and a third document that agrees with one side does not end it
      await addDocument(rid, `g3-${first}`);
      await processReferral(tx, ports(() => [{ page: 1, text: PAGE }], mk('no', 'Not on a ventilator')), job(rid));
      assert.equal((await state(rid)).evals[2].outcome, 'needs_review');
      assert.ok(docs.length);
    }
  });

  const entry = (d: string, key: string, v: 'yes' | 'no', quote: string, band: 'high' | 'low' = 'high'): Extracted => ({ key, value: tri(v), document_id: d, page: 1, quote, confidence_band: band });
  const Y = 'Remains on a ventilator today';
  const N = 'Not on a ventilator';
  const AGG_Y = 'Needs daily skilled nursing'; // on the page; the words do not matter to the rule under test
  const others = (d: string) => clean(d).filter((e) => e.key !== 'ventilator_use');

  test('a review-rule Yes that is disputed or low confidence never turns into an Admit', async () => {
    const a = await referral('r1');
    const aggY = (d: string) => clean(d).map((e) => (e.key === 'recent_aggression' ? entry(d, 'recent_aggression', 'yes', AGG_Y) : e));
    await processReferral(tx, ports(() => [{ page: 1, text: PAGE }], aggY), job(a.rid));
    await addDocument(a.rid, 'r2');
    await processReferral(tx, ports(() => [{ page: 1, text: PAGE }], clean), job(a.rid));
    let s = await state(a.rid);
    assert.equal(s.evals.at(-1).outcome, 'needs_review');
    await addDocument(a.rid, 'r3');
    await processReferral(tx, ports(() => [{ page: 1, text: PAGE }], () => []), job(a.rid)); // a silent run keeps it, and keeps showing why
    s = await state(a.rid);
    assert.deepEqual([s.evals.at(-1).outcome, s.evals.at(-1).trace.disagreements], ['needs_review', ['recent_aggression']]);
    const b = await referral('r4');
    const lowY = (d: string) => clean(d).map((e) => (e.key === 'recent_aggression' ? entry(d, 'recent_aggression', 'yes', AGG_Y, 'low') : e));
    await processReferral(tx, ports(() => [{ page: 1, text: PAGE }], lowY), job(b.rid));
    assert.equal((await state(b.rid)).evals[0].outcome, 'needs_review');
  });

  test('a Yes nobody can rely on is never overturned by a No without a person, across runs or within one', async () => {
    const pageOk = () => [{ page: 1, text: PAGE }];
    const lowY = (d: string) => [...others(d), entry(d, 'ventilator_use', 'yes', Y, 'low')];
    const fakeY = (d: string) => [...others(d), entry(d, 'ventilator_use', 'yes', 'Weaned off in spring')];
    const goodN = (d: string) => [...others(d), entry(d, 'ventilator_use', 'no', N)];
    for (const first of [lowY, fakeY]) {
      const { rid } = await referral(`s-${first === lowY}`);
      await processReferral(tx, ports(pageOk, first), job(rid));
      await addDocument(rid, `s2-${first === lowY}`);
      await processReferral(tx, ports(pageOk, goodN), job(rid));
      const s = await state(rid);
      assert.deepEqual([s.evals.at(-1).outcome, s.evals.at(-1).trace.disagreements], ['needs_review', ['ventilator_use']]);
    }
    const { rid } = await referral('s3');
    await processReferral(tx, ports(pageOk, (d) => [...others(d), entry(d, 'ventilator_use', 'yes', Y, 'low'), entry(d, 'ventilator_use', 'no', N)]), job(rid));
    assert.equal((await state(rid)).evals[0].outcome, 'needs_review');
  });

  test('a confident reading replaces a low-confidence one of the same value', async () => {
    const { rid } = await referral('t1');
    const yes = (band: 'high' | 'low') => (d: string) => [...others(d), entry(d, 'ventilator_use', 'yes', Y, band)];
    await processReferral(tx, ports(() => [{ page: 1, text: PAGE }], yes('low')), job(rid));
    assert.equal((await state(rid)).evals[0].outcome, 'needs_review');
    await addDocument(rid, 't2');
    await processReferral(tx, ports(() => [{ page: 1, text: PAGE }], yes('high')), job(rid));
    assert.equal((await state(rid)).evals.at(-1).outcome, 'do_not_admit');
  });

  test('a document contradicting a person is shown, and the person\'s value stands', async () => {
    const { rid } = await referral('u1');
    await c.query(`INSERT INTO facts (facility_id, referral_id, key, value, source, note, created_by) VALUES ($1, $2, 'ventilator_use', $3, 'user', 'SYNTHETIC', 'user:00000000-0000-4000-8000-00000000d1aa')`, [FAC, rid, tri('no')]);
    await processReferral(tx, ports(() => [{ page: 1, text: PAGE }], (d) => [...others(d), entry(d, 'ventilator_use', 'yes', Y)]), job(rid));
    const s = await state(rid);
    assert.deepEqual([s.evals[0].outcome, s.evals[0].trace.disagreements], ['admit', ['ventilator_use']]);
  });

  test('a re-run reads only new documents; agreement changes nothing and reports no change', async () => {
    const { rid } = await referral('g4');
    await processReferral(tx, ports(() => [{ page: 1, text: PAGE }], clean), job(rid));
    await addDocument(rid, 'g5');
    const p = ports(() => [{ page: 1, text: PAGE }], clean);
    await processReferral(tx, p, job(rid));
    assert.equal(p.ocrCalls, 1);
    const s = await state(rid);
    assert.equal(s.facts.length, 3);
    const attrs = (await c.query("SELECT attrs FROM product_events WHERE referral_id = $1 AND event = 'evaluation.created' ORDER BY at", [rid])).rows.map((r) => r.attrs);
    assert.equal(attrs[1].changed_fact_count, 0);
  });

  test('T2 counts every document: one that failed in an earlier run still holds the referral (§4 step 1)', async () => {
    const { rid, docs } = await referral('m1', 'm2');
    await processReferral(tx, ports((id) => { if (id === docs[0]) throw new Error('x'); return [{ page: 1, text: PAGE }]; }, clean), job(rid));
    assert.equal((await state(rid)).status, 'partial_failure');
    await asOwner();
    const id = (await c.query(`INSERT INTO documents (facility_id, referral_id, type, sha256, storage_key) VALUES ($1::uuid, $2::uuid, 'other', sha256('m3'::bytea),
      'documents/' || $1::uuid::text || '/' || $2::uuid::text || '/' || encode(sha256('m3'::bytea), 'hex')) RETURNING id`, [FAC, rid])).rows[0].id;
    assert.ok(id);
    await c.query("UPDATE referrals SET status = 'processing' WHERE id = $1", [rid]);
    await processReferral(tx, ports(() => [{ page: 1, text: PAGE }], clean), job(rid));
    const s = await state(rid);
    assert.equal(s.status, 'partial_failure');
    assert.deepEqual([s.evals.at(-1).outcome, s.evals.at(-1).sub_reasons], ['needs_review', ['processing_incomplete']]);
  });

  test('a stale job cannot finish a newer round of work; a duplicate during extraction writes nothing', async () => {
    const { rid } = await referral('n1');
    // while this job extracts, a duplicate finishes and a new document arrives
    const outer: Ports = { versions: VERSIONS, ocr: async () => [{ page: 1, text: PAGE }], extract: async () => {
      await processReferral(tx, ports(() => [{ page: 1, text: PAGE }], clean), job(rid));
      await addDocument(rid, 'n2');
      return []; } };
    assert.equal(await processReferral(tx, outer, job(rid)), 'skipped');
    let s = await state(rid);
    assert.deepEqual([s.status, s.evals.length, s.facts.length], ['processing', 1, 3]);
    assert.ok(s.docs.some((d) => d.status === 'uploaded')); // the new document still waits for its own job
    const { rid: r2 } = await referral('n3');
    const dup: Ports = { versions: VERSIONS, ocr: async () => [{ page: 1, text: PAGE }], extract: async () => {
      await processReferral(tx, ports(() => [{ page: 1, text: PAGE }], clean), job(r2)); return []; } };
    assert.equal(await processReferral(tx, dup, job(r2)), 'skipped');
    s = await state(r2);
    assert.deepEqual([s.evals.length, s.facts.length], [1, 3]);
  });

  test('switched-off rules are not extracted; the evaluation pins the profile version', async () => {
    const seen: string[][] = [];
    const spy = (): Ports => ({ versions: VERSIONS, ocr: async () => [{ page: 1, text: PAGE }], extract: async (p, keys) => { seen.push(keys); return p.flatMap((x) => clean(x.document_id)); } });
    const a = await referral('o1');
    await processReferral(tx, spy(), job(a.rid));
    assert.deepEqual(seen[0], ['daily_skilled_need', 'recent_aggression', 'ventilator_use']);
    await asOwner();
    await c.query("SAVEPOINT prof");
    await c.query("INSERT INTO facility_profiles (facility_id, version, capabilities, disabled_rules, created_by) VALUES ($1, 0, $2, '{seed.review.behavioral_escalation}', 'platform:test')", [FAC, CAPS]);
    const b = await referral('o2');
    await processReferral(tx, spy(), job(b.rid));
    assert.deepEqual(seen[1], ['daily_skilled_need', 'ventilator_use']);
    const s = await state(b.rid);
    assert.deepEqual([s.facts.some((f) => f.key === 'recent_aggression'), s.evals[0].facility_profile_version], [false, 2]);
    await c.query('ROLLBACK TO SAVEPOINT prof');
  });

  test('raw is the AI-only snapshot: a run after a person stated a fact is not raw', async () => {
    const { rid } = await referral('p1');
    await c.query(`INSERT INTO facts (facility_id, referral_id, key, value, source, note, created_by) VALUES ($1, $2, 'recent_aggression', $3, 'user', 'SYNTHETIC', 'user:00000000-0000-4000-8000-00000000d1aa')`, [FAC, rid, tri('no')]);
    await processReferral(tx, ports(() => [{ page: 1, text: PAGE }], clean), job(rid));
    assert.equal((await state(rid)).evals[0].raw, false);
  });

  test('the database itself refuses the worker superseding a person\'s fact', async () => {
    const { rid } = await referral('p2');
    const userId = (await c.query(`INSERT INTO facts (facility_id, referral_id, key, value, source, note, created_by) VALUES ($1, $2, 'ventilator_use', $3, 'user', 'SYNTHETIC', 'user:00000000-0000-4000-8000-00000000d1aa') RETURNING id`, [FAC, rid, tri('yes')])).rows[0].id;
    await assert.rejects(tx((q) => q(`SELECT set_config('app.facility_id', $1, true)`, [FAC]).then(() => q(
      `INSERT INTO facts (facility_id, referral_id, key, value, source, evidence, supersedes, created_by) VALUES ($1, $2, 'ventilator_use', $3, 'ai', $4, $5, 'worker:job-1')`,
      [FAC, rid, tri('no'), { document_id: 'x', page: 1, quote: 'q', verified: true }, userId]))), /may not supersede a fact a person stated/);
  });

  test('what a person stated is never overwritten', async () => {
    const { rid } = await referral('g');
    await c.query(`INSERT INTO facts (facility_id, referral_id, key, value, source, note, created_by) VALUES ($1, $2, 'ventilator_use', $3, 'user', 'SYNTHETIC: phone call', 'user:00000000-0000-4000-8000-00000000d1aa')`, [FAC, rid, tri('yes')]);
    await processReferral(tx, ports(() => [{ page: 1, text: PAGE }], clean), job(rid));
    const s = await state(rid);
    assert.deepEqual(s.facts.filter((f) => f.key === 'ventilator_use').map((f) => f.source), ['user']);
    assert.equal(s.evals[0].outcome, 'do_not_admit');
  });

  test('T3: a failed or unreadable document alone moves the referral to partial failure, without its error text', async () => {
    for (const kind of ['failed', 'unreadable'] as const) {
      const { rid, docs } = await referral(`h-${kind}`, `h2-${kind}`);
      const ocr = (id: string): Page[] => {
        if (id !== docs[0]) return [{ page: 1, text: PAGE }];
        if (kind === 'failed') throw new Error('SYNTHETIC-CANARY unreadable at page 1');
        return [{ page: 1, text: '   ' }];
      };
      await processReferral(tx, ports(ocr, clean), job(rid));
      const s = await state(rid);
      assert.deepEqual([s.status, s.docs.map((d) => d.status).sort()], ['partial_failure', [kind, 'processed'].sort()]);
      assert.equal(s.facts.length, 3);
      assert.deepEqual([s.evals[0].outcome, s.evals[0].sub_reasons], ['needs_review', ['processing_incomplete']]);
      const events = (await c.query('SELECT event, attrs FROM product_events WHERE referral_id = $1', [rid])).rows;
      assert.ok(!JSON.stringify(events).includes('CANARY'));
      assert.ok(!events.some((e) => e.event === 'referral.ready'));
      assert.deepEqual((await c.query("SELECT action FROM audit_log WHERE entity_id = $1 AND action LIKE 'referral.%'", [rid])).rows, [{ action: 'referral.partial_failure' }]);
    }
  });

  test('a crash in extraction leaves nothing written, and the job can run again', async () => {
    const { rid } = await referral('i');
    const crash: Ports = { versions: VERSIONS, ocr: async () => [{ page: 1, text: PAGE }], extract: async () => { throw new Error('boom'); } };
    await assert.rejects(processReferral(tx, crash, job(rid)), /boom/);
    let s = await state(rid);
    assert.deepEqual([s.status, s.docs[0].status, s.facts, s.evals], ['processing', 'uploaded', [], []]);
    assert.equal(await processReferral(tx, ports(() => [{ page: 1, text: PAGE }], clean), job(rid)), 'done');
    s = await state(rid);
    assert.equal(s.status, 'ready_for_review');
  });

  test('a repeated job, or a referral not in processing, is left alone', async () => {
    const { rid } = await referral('j');
    const p = ports(() => [{ page: 1, text: PAGE }], clean);
    await processReferral(tx, p, job(rid));
    assert.equal(await processReferral(tx, p, job(rid)), 'skipped');
    assert.equal(p.ocrCalls, 1);
    assert.equal((await state(rid)).evals.length, 1);
  });

  test('a referral that is not in processing is skipped before any OCR', async () => {
    const { rid } = await referral('q1');
    await asOwner();
    await c.query("UPDATE referrals SET status = 'draft' WHERE id = $1", [rid]);
    const p = ports(() => [{ page: 1, text: PAGE }], clean);
    assert.equal(await processReferral(tx, p, job(rid)), 'skipped');
    assert.equal(p.ocrCalls, 0);
  });

  test('a job pairing a referral with the wrong facility is refused, spends nothing and changes nothing (XF-13)', async () => {
    const { rid } = await referral('k');
    const p = ports(() => [{ page: 1, text: PAGE }], clean);
    await assert.rejects(processReferral(tx, p, job(rid, OTHER)), /no referral at this facility/);
    assert.equal(p.ocrCalls, 0);
    await assert.rejects(failReferral(tx, VERSIONS, job(rid, OTHER)), /no referral at this facility/);
    assert.equal((await state(rid)).status, 'processing');
  });

  test('a dead-lettered job sends the referral to a person, and never touches finished work', async () => {
    const { rid } = await referral('v1', 'v2');
    await failReferral(tx, VERSIONS, job(rid));
    const s = await state(rid);
    assert.deepEqual([s.status, s.docs.map((d) => d.status), s.evals.length], ['partial_failure', ['failed', 'failed'], 1]);
    assert.deepEqual([s.evals[0].outcome, s.evals[0].sub_reasons], ['needs_review', ['processing_incomplete']]);
    await failReferral(tx, VERSIONS, job(rid)); // redelivery of the dead letter changes nothing
    assert.equal((await state(rid)).evals.length, 1);
    const done = await referral('v3');
    await processReferral(tx, ports(() => [{ page: 1, text: PAGE }], clean), job(done.rid));
    await failReferral(tx, VERSIONS, job(done.rid));
    assert.equal((await state(done.rid)).status, 'ready_for_review');
  });

  test('a dead-lettered job with no usable settings still reaches a person, without an evaluation', async () => {
    const { rid } = await referral('v4');
    await asOwner();
    await c.query('SAVEPOINT sets');
    await c.query('ALTER TABLE rule_sets DISABLE TRIGGER USER');
    await c.query('DELETE FROM rule_sets WHERE organization_id = $1', [ORG]);
    await c.query('ALTER TABLE rule_sets ENABLE TRIGGER USER');
    await failReferral(tx, VERSIONS, job(rid));
    const s = await state(rid);
    assert.deepEqual([s.status, s.docs.map((d) => d.status), s.evals.length], ['partial_failure', ['failed'], 0]);
    await c.query('ROLLBACK TO SAVEPOINT sets');
  });
});

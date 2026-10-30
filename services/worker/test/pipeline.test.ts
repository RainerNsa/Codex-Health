// The pipeline against the real database as codex_worker, with fake OCR and extraction: CI never calls Textract or
// Bedrock. One outer transaction is rolled back, so the suite leaves nothing behind. Skips without DATABASE_URL;
// fails where REQUIRE_DATABASE is set (the db-checks job).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { processReferral, type Extracted, type Page, type Ports, type Query, type Tx } from '../src/pipeline.ts';

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
const PAGE = 'ZZTEST, Patient. Not on a ventilator. No recent aggression. Needs daily skilled nursing.';

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
      facts: (await c.query('SELECT key, value, source, evidence, confidence_band, created_by FROM facts WHERE referral_id = $1 ORDER BY key, created_at', [rid])).rows,
      evals: (await c.query('SELECT raw, outcome, model_id, prompt_version, trace FROM evaluations WHERE referral_id = $1 ORDER BY evaluated_at', [rid])).rows,
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

  test('a quote on another page of the document does not verify; low confidence reads as unknown', async () => {
    const { rid } = await referral('c');
    const pages = [{ page: 1, text: PAGE }, { page: 2, text: 'ZZTEST nothing here' }];
    const fake = (d: string) => clean(d).map((e) => (e.key === 'ventilator_use' ? { ...e, page: 2 } : e.key === 'daily_skilled_need' ? { ...e, confidence_band: 'low' as const } : e));
    await processReferral(tx, ports(() => pages, fake), job(rid));
    const s = await state(rid);
    assert.equal(s.facts.find((f) => f.key === 'ventilator_use').evidence.verified, false);
    assert.notEqual(s.evals[0].outcome, 'admit');
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
    const fake = (d: string) => clean(d).map((e) => (e.key === 'ventilator_use' && d === docs[1] ? { ...e, value: tri('yes'), quote: 'ZZTEST, Patient' } : e));
    await processReferral(tx, ports(() => [{ page: 1, text: PAGE }], fake), job(rid));
    const s = await state(rid);
    const f = s.facts.find((x) => x.key === 'ventilator_use');
    assert.deepEqual([f.value, f.evidence, f.confidence_band], [tri('unknown'), null, null]);
    assert.equal(s.evals[0].outcome, 'needs_review');
  });

  test('what a person stated is never overwritten', async () => {
    const { rid } = await referral('g');
    await c.query(`INSERT INTO facts (facility_id, referral_id, key, value, source, note, created_by) VALUES ($1, $2, 'ventilator_use', $3, 'user', 'SYNTHETIC: phone call', 'user:00000000-0000-4000-8000-00000000d1aa')`, [FAC, rid, tri('yes')]);
    await processReferral(tx, ports(() => [{ page: 1, text: PAGE }], clean), job(rid));
    const s = await state(rid);
    assert.deepEqual(s.facts.filter((f) => f.key === 'ventilator_use').map((f) => f.source), ['user']);
    assert.equal(s.evals[0].outcome, 'do_not_admit');
  });

  test('T3: a failed document fails without its error text; an illegible one is unreadable; the rest still count', async () => {
    const { rid, docs } = await referral('h1', 'h2', 'h3');
    const ocr = (id: string): Page[] => {
      if (id === docs[0]) throw new Error('SYNTHETIC-CANARY unreadable at page 1');
      return id === docs[1] ? [{ page: 1, text: '   ' }] : [{ page: 1, text: PAGE }];
    };
    await processReferral(tx, ports(ocr, clean), job(rid));
    const s = await state(rid);
    assert.equal(s.status, 'partial_failure');
    assert.deepEqual(s.docs.map((d) => d.status).sort(), ['failed', 'processed', 'unreadable']);
    assert.equal(s.facts.length, 3);
    assert.equal(s.evals[0].outcome, 'needs_review'); // processing incomplete
    const rows = JSON.stringify((await c.query('SELECT attrs FROM product_events WHERE referral_id = $1', [rid])).rows);
    assert.ok(!rows.includes('CANARY'));
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

  test('a job naming the wrong facility sees no referral and changes nothing', async () => {
    const { rid } = await referral('k');
    assert.equal(await processReferral(tx, ports(() => [], () => []), job(rid, OTHER)), 'skipped');
    assert.equal((await state(rid)).status, 'processing');
  });
});

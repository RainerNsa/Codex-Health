// The document pipeline for one referral (SPEC §5.1 T2/T3, §12.1, §14.2). OCR and extraction run first, touching
// nothing; then one transaction writes every result. A crash anywhere leaves no half-written facts, and a redelivered
// job repeats cleanly (4.3). The model never sees the rules or emits an outcome: the engine decides from verified facts.
// shortcut: one write per run, so no document-level partial results yet; slice 4 (4.1) splits this per document.
import { ENGINE_VERSION, evaluate, referencedKeys, parseExpression, type Fact, type FactValue, type Rule } from '@codex-health/rules-engine';
import { verifyQuote } from './verify.ts';

export type Query = <R = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: R[]; rowCount: number | null }>;
export type Tx = <T>(fn: (q: Query) => Promise<T>) => Promise<T>;

export interface Page { page: number; text: string }
export interface DocumentRef { id: string; storage_key: string }
export interface Extracted { key: string; value: FactValue; document_id: string; page: number; quote: string; confidence_band: 'high' | 'medium' | 'low' }
export interface Ports {
  /** Page text of one document. Throws when it cannot be read; an empty result means nothing was legible. */
  ocr(doc: DocumentRef): Promise<Page[]>;
  /** Facts found in the pages, for these keys only. Silence on a key is simply no entry. */
  extract(pages: { document_id: string; pages: Page[] }[], keys: string[]): Promise<Extracted[]>;
  versions: { model_id: string; prompt_version: string; extractor_version: string; ocr_engine_version: string };
}
export interface Job { facilityId: string; referralId: string; jobId: string }

type Outcome = { doc: DocumentRef; status: 'processed'; pages: Page[]; ms: number } | { doc: DocumentRef; status: 'failed' | 'unreadable'; pages: []; ms: number };

const isKnown = (v: FactValue) => v.value !== null && v.value !== 'unknown';

async function bind(q: Query, facilityId: string): Promise<string> {
  await q("SELECT set_config('app.facility_id', $1, true)", [facilityId]);
  const org = (await q<{ organization_id: string }>('SELECT organization_id FROM facilities WHERE facility_id = $1', [facilityId])).rows[0]?.organization_id;
  if (!org) throw new Error('job names an unknown facility');
  await q("SELECT set_config('app.organization_id', $1, true)", [org]);
  return org;
}

/** The enabled rules and profile the evaluation runs under, or null if the facility has none. */
async function settings(q: Query, facilityId: string, org: string) {
  const rs = (await q<{ version: number; criteria_document_ref: string; rules: Rule[] }>(
    'SELECT version, criteria_document_ref, rules FROM rule_sets WHERE organization_id = $1 ORDER BY version DESC LIMIT 1', [org])).rows[0];
  const fp = (await q<{ version: number; capabilities: Record<string, boolean | number>; disabled_rules: string[] }>(
    'SELECT version, capabilities, disabled_rules FROM facility_profiles WHERE facility_id = $1 ORDER BY version DESC LIMIT 1', [facilityId])).rows[0];
  if (!rs || !fp) return null;
  const rules = rs.rules.map((r) => ({ ...r, enabled: r.enabled === true && !fp.disabled_rules.includes(r.id) }));
  return { rules, profile: fp.capabilities, ruleSetVersion: rs.version, profileVersion: fp.version, criteriaRef: rs.criteria_document_ref };
}

const currentFacts = async (q: Query, fid: string, rid: string) => (await q<Fact & { id: string }>(
  `SELECT f.id, f.key, f.value, f.source, f.evidence, f.note, to_char(f.as_of_date, 'YYYY-MM-DD') AS as_of_date, f.is_critical, f.specially_protected, f.single_source, f.confidence_band
   FROM facts f WHERE f.facility_id = $1 AND f.referral_id = $2
     AND NOT EXISTS (SELECT 1 FROM facts n WHERE n.facility_id = f.facility_id AND n.supersedes = f.id) ORDER BY f.key`, [fid, rid])).rows;

/** Process one referral. Safe to repeat: anything but a referral in processing is left alone. */
export async function processReferral(tx: Tx, ports: Ports, job: Job): Promise<'done' | 'skipped'> {
  const { facilityId: fid, referralId: rid } = job;
  const actor = `worker:${job.jobId}`;

  const plan = await tx(async (q) => {
    const org = await bind(q, fid);
    const ref = (await q<{ status: string }>('SELECT status FROM referrals WHERE facility_id = $1 AND id = $2', [fid, rid])).rows[0];
    if (ref?.status !== 'processing') return null;
    const set = await settings(q, fid, org);
    if (!set) throw new Error('facility has no rule set or profile');
    const docs = (await q<DocumentRef>("SELECT id, storage_key FROM documents WHERE facility_id = $1 AND referral_id = $2 AND status = 'uploaded' ORDER BY created_at", [fid, rid])).rows;
    const keys = [...new Set(set.rules.filter((r) => r.enabled).flatMap((r) => referencedKeys(parseExpression(r.expression))).filter((k) => !k.startsWith('facility.')))].sort();
    return { docs, keys };
  });
  if (!plan) return 'skipped';

  const results: Outcome[] = [];
  for (const doc of plan.docs) {
    const start = Date.now();
    try {
      const pages = (await ports.ocr(doc)).filter((p) => p.text.trim() !== '');
      results.push(pages.length ? { doc, status: 'processed', pages, ms: Date.now() - start } : { doc, status: 'unreadable', pages: [], ms: Date.now() - start });
    } catch {
      results.push({ doc, status: 'failed', pages: [], ms: Date.now() - start }); // never the error text: it can quote the document
    }
  }
  const read = results.filter((r) => r.status === 'processed');
  const extracted = read.length ? await ports.extract(read.map((r) => ({ document_id: r.doc.id, pages: r.pages })), plan.keys) : [];

  return tx(async (q) => {
    const org = await bind(q, fid);
    const ref = (await q<{ status: string }>('SELECT status FROM referrals WHERE facility_id = $1 AND id = $2 FOR UPDATE', [fid, rid])).rows[0];
    if (ref?.status !== 'processing') return 'skipped'; // a duplicate delivery finished first
    const set = await settings(q, fid, org);
    if (!set) throw new Error('facility has no rule set or profile');

    for (const r of results) {
      await q('UPDATE documents SET status = $3, pages = $4, updated_at = now() WHERE facility_id = $1 AND id = $2', [fid, r.doc.id, r.status, r.pages.length || null]);
      await q('INSERT INTO audit_log (facility_id, actor, action, entity_type, entity_id) VALUES ($1, $2, $3, $4, $5)', [fid, actor, `document.${r.status}`, 'document', r.doc.id]);
      await q('INSERT INTO product_events (facility_id, referral_id, actor, event, attrs) VALUES ($1, $2, $3, $4, $5)', [fid, rid, actor, r.status === 'processed' ? 'document.processed' : 'document.failed',
        r.status === 'processed' ? { document_id: r.doc.id, pages_ocr: r.pages.length, duration_ms: r.ms } : { document_id: r.doc.id, pages_ocr: 0, stage: 'ocr', duration_ms: r.ms }]);
    }

    const pageText = new Map(read.flatMap((r) => r.pages.map((p) => [`${r.doc.id}:${p.page}`, p.text] as const)));
    const before = new Map((await currentFacts(q, fid, rid)).map((f) => [f.key, f]));
    let changed = 0;
    for (const key of plan.keys) {
      const found = extracted.filter((e) => e.key === key && isKnown(e.value));
      if (found.length === 0) continue; // silence stays silence: it never becomes a No (I1)
      const current = before.get(key);
      if (current?.source === 'user') continue; // what a person stated is never overwritten
      const distinct = new Set(found.map((e) => JSON.stringify(e.value)));
      // documents that disagree are for a person to settle: the fact stays unknown, with no evidence to lean on
      const chosen = distinct.size === 1 ? found[0]! : null;
      const value: FactValue = chosen ? chosen.value : { type: found[0]!.value.type, value: found[0]!.value.type === 'tri_state' ? 'unknown' : null } as FactValue;
      if (current && JSON.stringify(current.value) === JSON.stringify(value)) continue;
      const evidence = chosen ? { document_id: chosen.document_id, page: chosen.page, quote: chosen.quote, verified: verifyQuote(chosen.quote, pageText.get(`${chosen.document_id}:${chosen.page}`) ?? ''), span: null, coordinates: null } : null;
      const f = await q<{ id: string }>(
        `INSERT INTO facts (facility_id, referral_id, key, value, source, evidence, confidence_band, is_critical, supersedes, created_by)
         VALUES ($1, $2, $3, $4, 'ai', $5, $6, false, $7, $8) RETURNING id`,
        [fid, rid, key, value, evidence, chosen ? chosen.confidence_band : null, current?.id ?? null, actor]);
      await q('INSERT INTO audit_log (facility_id, actor, action, entity_type, entity_id) VALUES ($1, $2, $3, $4, $5)', [fid, actor, 'fact.extracted', 'fact', f.rows[0]!.id]);
      changed += 1;
    }

    const anyFailed = results.some((r) => r.status !== 'processed');
    const facts = await currentFacts(q, fid, rid);
    const referralDate = new Date().toISOString().slice(0, 10);
    const result = evaluate({ facts, profile: set.profile, rules: set.rules, referral_date: referralDate, processing_complete: !anyFailed });
    const prev = (await q<{ id: string }>('SELECT id FROM evaluations WHERE facility_id = $1 AND referral_id = $2 ORDER BY evaluated_at DESC LIMIT 1', [fid, rid])).rows[0]?.id ?? null;
    const { trace, missing, conflicts, blocking, empty_profile_keys, resolution_step, confirmation_set } = result;
    const v = ports.versions;
    const ev = (await q<{ id: string }>(
      `INSERT INTO evaluations (facility_id, referral_id, previous_evaluation_id, raw, outcome, clinical_outcome, financial_status, sub_reasons, trace,
         criteria_document_ref, rule_set_version, facility_profile_version, model_id, prompt_version, extractor_version, ocr_engine_version, engine_version)
       VALUES ($1, $2, $3, true, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING id`,
      [fid, rid, prev, result.outcome, result.clinical_outcome, result.financial_status, result.sub_reasons,
        { resolution_step, trace, missing, conflicts, blocking, empty_profile_keys, confirmation_set, inputs: { referral_date: referralDate, processing_complete: !anyFailed, fact_ids: facts.map((f) => (f as { id: string }).id) } },
        set.criteriaRef, set.ruleSetVersion, set.profileVersion, v.model_id, v.prompt_version, v.extractor_version, v.ocr_engine_version, ENGINE_VERSION])).rows[0]!.id;
    await q('INSERT INTO audit_log (facility_id, actor, action, entity_type, entity_id) VALUES ($1, $2, $3, $4, $5)', [fid, actor, 'evaluation.created', 'evaluation', ev]);
    await q('INSERT INTO product_events (facility_id, referral_id, actor, event, attrs) VALUES ($1, $2, $3, $4, $5)', [fid, rid, actor, 'evaluation.created',
      { evaluation_id: ev, ...(prev ? { previous_evaluation_id: prev } : {}), raw: true, outcome: result.outcome, changed_fact_count: changed }]);

    // T3 on any unreadable or failed document, otherwise T2
    await q('UPDATE referrals SET status = $3, updated_at = now() WHERE facility_id = $1 AND id = $2', [fid, rid, anyFailed ? 'partial_failure' : 'ready_for_review']);
    await q('INSERT INTO audit_log (facility_id, actor, action, entity_type, entity_id) VALUES ($1, $2, $3, $4, $5)', [fid, actor, anyFailed ? 'referral.partial_failure' : 'referral.ready', 'referral', rid]);
    if (!anyFailed) {
      await q('INSERT INTO product_events (facility_id, referral_id, actor, event, attrs) VALUES ($1, $2, $3, $4, $5)', [fid, rid, actor, 'referral.ready',
        { evaluation_id: ev, outcome: result.outcome, sub_reasons: result.sub_reasons, blocking_count: blocking.length }]);
    }
    return 'done';
  });
}

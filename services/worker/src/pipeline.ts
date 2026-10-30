// The document pipeline for one referral (SPEC §5.1 T2/T3, §12.1, §14.2). OCR and extraction run first, touching
// nothing; then one transaction writes every result. A crash anywhere leaves no half-written facts, and a redelivered
// job repeats cleanly (4.3). The model never sees the rules or emits an outcome: the engine decides from verified facts.
// shortcut: one write per run, so no document-level partial results yet; slice 4 (4.1) splits this per document.
import { ENGINE_VERSION, evaluate, keyTypes, parseExpression, parseFactValue, referencedKeys, type Fact, type FactValue, type KeyType, type Rule } from '@codex-health/rules-engine';
import { isNegative, verifyEvidence } from './verify.ts';

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
const JOB_ID = /^[a-z0-9-]{1,64}$/;
const QUOTE_MAX = 1000;

/** Extractor output is hostile input (a packet can carry prompt injection). An entry that is not exactly valid is
 *  dropped, never stored, so one bad entry cannot stop the referral. */
function clean(e: Extracted, types: Map<string, KeyType>, keys: Set<string>, docs: Set<string>): (Omit<Extracted, 'value'> & { value: FactValue }) | null {
  if (!e || !keys.has(e.key) || !docs.has(e.document_id) || !Number.isInteger(e.page) || e.page < 1 || typeof e.quote !== 'string') return null;
  const value = parseFactValue(e.value, types.get(e.key) ?? 'tri_state');
  const quote = e.quote.replace(/[\p{Cs}\u0000]/gu, '').trim();
  if (!value || !isKnown(value) || !quote || quote.length > QUOTE_MAX) return null;
  return { key: e.key, value, document_id: e.document_id, page: e.page, quote, confidence_band: e.confidence_band === 'high' || e.confidence_band === 'medium' ? e.confidence_band : 'low' };
}

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
  if (!JOB_ID.test(job.jobId)) throw new Error('job id is malformed'); // before any OCR or model spend
  const actor = `worker:${job.jobId}`;

  const plan = await tx(async (q) => {
    const org = await bind(q, fid);
    const ref = (await q<{ status: string }>('SELECT status FROM referrals WHERE facility_id = $1 AND id = $2', [fid, rid])).rows[0];
    if (ref?.status !== 'processing') return null;
    const set = await settings(q, fid, org);
    if (!set) throw new Error('facility has no rule set or profile');
    const docs = (await q<DocumentRef>("SELECT id, storage_key FROM documents WHERE facility_id = $1 AND referral_id = $2 AND status = 'uploaded' ORDER BY created_at", [fid, rid])).rows;
    const enabled = set.rules.filter((r) => r.enabled);
    const keys = [...new Set(enabled.flatMap((r) => referencedKeys(parseExpression(r.expression))).filter((k) => !k.startsWith('facility.')))].sort();
    return { docs, keys, types: keyTypes(enabled.map((r) => r.expression)), hardKeys: new Set(enabled.filter((r) => r.kind === 'hard_stop').flatMap((r) => r.inputs)) };
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
    // this job must still own exactly the documents it read: a stale job never finishes a newer round of work
    const waiting = (await q<{ id: string }>("SELECT id FROM documents WHERE facility_id = $1 AND referral_id = $2 AND status = 'uploaded'", [fid, rid])).rows.map((d) => d.id).sort();
    if (waiting.join() !== plan.docs.map((d) => d.id).sort().join()) return 'skipped';
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
    const keySet = new Set(plan.keys);
    const docSet = new Set(read.map((r) => r.doc.id));
    const entries = extracted.flatMap((e) => clean(e, plan.types, keySet, docSet) ?? []).map((e) => ({ ...e, verified: verifyEvidence(e.value, e.quote, pageText.get(`${e.document_id}:${e.page}`) ?? '') }));
    const unknownOf = (t: FactValue['type']) => ({ type: t, value: t === 'tri_state' ? 'unknown' : null }) as FactValue;
    // critical: a Yes on record that nobody can yet rely on, or a dispute, holds the outcome for a person (§3, §4 step 3)
    const insert = async (key: string, value: FactValue, e: (typeof entries)[number] | null, singleSource: boolean, supersedes: string | null, critical = false) => {
      const f = await q<{ id: string }>(
        `INSERT INTO facts (facility_id, referral_id, key, value, source, evidence, confidence_band, is_critical, single_source, supersedes, created_by)
         VALUES ($1, $2, $3, $4, 'ai', $5, $6, $10, $7, $8, $9) RETURNING id`,
        [fid, rid, key, value, e ? { document_id: e.document_id, page: e.page, quote: e.quote, verified: e.verified, span: null, coordinates: null } : null, e?.confidence_band ?? null, singleSource, supersedes, actor, critical]);
      await q('INSERT INTO audit_log (facility_id, actor, action, entity_type, entity_id) VALUES ($1, $2, $3, $4, $5)', [fid, actor, 'fact.extracted', 'fact', f.rows[0]!.id]);
    };
    let changed = 0;
    const contested: string[] = [];
    for (const key of plan.keys) {
      const found = entries.filter((e) => e.key === key);
      const current = before.get(key);
      if (found.length === 0) continue; // silence stays silence (I1)
      const usable = found.filter((e) => e.verified && e.confidence_band !== 'low');
      if (current?.source === 'user') {
        // a person's statement stands; a document that contradicts it is shown, not applied
        if (usable.some((e) => JSON.stringify(e.value) !== JSON.stringify(current.value))) contested.push(key);
        continue;
      }
      // the pipeline writes an Unknown only for a disagreement, which stands until a person states the fact (§3)
      if (current && !isKnown(current.value)) continue;
      if (usable.length === 0) {
        // nothing trustworthy: keep a first sighting on record, the most cautious one, and never replace anything with it
        if (!current) {
          const worst = found.find((e) => !isNegative(e.value)) ?? found[0]!;
          await insert(key, worst.value, worst, false, null, !isNegative(worst.value));
          changed += 1;
        }
        continue;
      }
      const onRecord = (await q<{ value: FactValue; trusted: boolean }>(
        `SELECT value, coalesce((evidence->>'verified')::boolean, false) AND confidence_band IN ('high', 'medium') AS trusted
         FROM facts WHERE facility_id = $1 AND referral_id = $2 AND key = $3 AND source = 'ai'`, [fid, rid, key])).rows.filter((r) => isKnown(r.value));
      const chosen = usable[0]!;
      const same = (v: FactValue) => JSON.stringify(v) === JSON.stringify(chosen.value);
      // verified values that differ are a disagreement. A negative value must also answer to every other reading, trusted
      // or not: a Yes on record is never overturned without a person, while a fabricated No cannot unseat a verified Yes.
      const disputed = [...onRecord.filter((r) => r.trusted).map((r) => r.value), ...usable.map((e) => e.value)].some((v) => !same(v))
        || (isNegative(chosen.value) && [...onRecord.map((r) => r.value), ...found.map((e) => e.value)].some((v) => !same(v)));
      if (disputed) {
        await insert(key, unknownOf(chosen.value.type), null, false, current?.id ?? null, true);
        changed += 1;
        continue;
      }
      if (current && same(current.value) && current.evidence?.verified && current.confidence_band !== 'low') continue;
      // a hard-stop No resting on one document is flagged for confirmation against the page (§5.1 T12, XF-7b)
      const single = plan.hardKeys.has(key) && isNegative(chosen.value) && new Set(usable.map((e) => e.document_id)).size === 1;
      await insert(key, chosen.value, chosen, single, current?.id ?? null);
      changed += 1;
    }

    // every document of the referral counts, not only this run's: one that failed earlier still holds the outcome
    const open = (await q<{ n: string }>("SELECT count(*) AS n FROM documents WHERE facility_id = $1 AND referral_id = $2 AND status NOT IN ('processed', 'not_applicable')", [fid, rid])).rows[0]!.n;
    const anyFailed = open !== '0';
    const facts = await currentFacts(q, fid, rid);
    const disagreements = [...new Set([...contested, ...facts.filter((f) => f.source === 'ai' && !isKnown(f.value)).map((f) => f.key)])].sort();
    const raw = !facts.some((f) => f.source === 'user'); // §14.2: raw is the AI-only snapshot, before any person touched a fact
    const referralDate = new Date().toISOString().slice(0, 10);
    const result = evaluate({ facts, profile: set.profile, rules: set.rules, referral_date: referralDate, processing_complete: !anyFailed });
    const prev = (await q<{ id: string }>('SELECT id FROM evaluations WHERE facility_id = $1 AND referral_id = $2 ORDER BY evaluated_at DESC LIMIT 1', [fid, rid])).rows[0]?.id ?? null;
    const { trace, missing, conflicts, blocking, empty_profile_keys, resolution_step, confirmation_set } = result;
    const v = ports.versions;
    const ev = (await q<{ id: string }>(
      `INSERT INTO evaluations (facility_id, referral_id, previous_evaluation_id, raw, outcome, clinical_outcome, financial_status, sub_reasons, trace,
         criteria_document_ref, rule_set_version, facility_profile_version, model_id, prompt_version, extractor_version, ocr_engine_version, engine_version)
       VALUES ($1, $2, $3, $17, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING id`,
      [fid, rid, prev, result.outcome, result.clinical_outcome, result.financial_status, result.sub_reasons,
        { resolution_step, trace, missing, conflicts, disagreements, blocking, empty_profile_keys, confirmation_set, inputs: { referral_date: referralDate, processing_complete: !anyFailed, fact_ids: facts.map((f) => (f as { id: string }).id) } },
        set.criteriaRef, set.ruleSetVersion, set.profileVersion, v.model_id, v.prompt_version, v.extractor_version, v.ocr_engine_version, ENGINE_VERSION, raw])).rows[0]!.id;
    await q('INSERT INTO audit_log (facility_id, actor, action, entity_type, entity_id) VALUES ($1, $2, $3, $4, $5)', [fid, actor, 'evaluation.created', 'evaluation', ev]);
    await q('INSERT INTO product_events (facility_id, referral_id, actor, event, attrs) VALUES ($1, $2, $3, $4, $5)', [fid, rid, actor, 'evaluation.created',
      { evaluation_id: ev, ...(prev ? { previous_evaluation_id: prev } : {}), raw, outcome: result.outcome, changed_fact_count: changed }]);

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

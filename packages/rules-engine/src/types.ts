// Decided types for the rules engine (dev-alignment 0.2, 2.6, 2.8; master-plan §7; SPEC §10).

/** Three-valued (Kleene) fact value. Unknown never collapses to no. */
export type TriState = 'yes' | 'no' | 'unknown';

/** Who asserted the fact: the extraction pipeline or a person. */
export type FactSource = 'ai' | 'user';

/** Tagged fact value (ruling R2). Every type can be unknown: tri_state 'unknown', null for the rest. */
export type FactValue =
  | { type: 'tri_state'; value: TriState }
  | { type: 'count'; value: number | null }
  | { type: 'date'; value: string | null }
  | { type: 'enum'; value: string | null; options?: readonly string[] }
  | { type: 'text'; value: string | null }
  | { type: 'medication_list'; value: readonly MedicationRecord[] | null };

export interface MedicationRecord {
  name: string;
  route: string;
  frequency: string;
  duration_days: number | null;
}

/** Where an AI value came from. null for user facts and unknown values. */
export interface Evidence {
  document_id: string;
  /** 1-based page within document_id. */
  page: number;
  /** Verbatim quote supporting the value. */
  quote: string;
  /** Found in the page text under the 5.6 normalisation rules; an unverified ai fact is treated as unknown (I2). */
  verified: boolean;
  span: { start: number; end: number } | null;
  /** Page-render bounding box as fractions of page size. */
  coordinates: { x: number; y: number; w: number; h: number } | null;
}

/** One source-linked fact from a referral packet. Mirrors packages/schemas/schemas/fact.v0.json. */
export interface Fact {
  /** Fact key from the baseline fact list (snake_case), e.g. "ventilator_use". */
  key: string;
  value: FactValue;
  source: FactSource;
  evidence: Evidence | null;
  /** Why a person asserted the fact; required when source is 'user'. */
  note: string | null;
  /** ISO date (YYYY-MM-DD) the fact was true as of; null when the source gives none. */
  as_of_date: string | null;
  /** Read by a hard-stop or payer rule; unknown here blocks Admit. */
  is_critical: boolean;
  /** 42 CFR Part 2 / psychotherapy-note class; display-only, routes to Needs Review only. */
  specially_protected: boolean;
  /** A hard-stop 'no' resting on one document; blocks finalize until page-image confirmation. */
  single_source: boolean;
  /** Label only; the engine never reads it. */
  confidence_band: 'high' | 'medium' | 'low' | null;
}

/**
 * The tri-state a hard-stop or payer rule reads from any typed value (ruling R2). Unknown stays
 * unknown (I1); a count of 0 or an empty list is 'no'; any other known count or list is 'yes'.
 * An AI fact is unknown when its evidence is missing or unverified (I2) or its confidence band is
 * low (SPEC §3: a low-confidence fact is Unknown for hard-stop purposes until a person confirms it).
 * Anything not literally from a user is held to the AI rules.
 * shortcut: enum, date and text values are always unknown here, because "present" says nothing
 * about a negation-valued enum ("isolation_pathogen: none"); upgrade when the §10 DSL compares
 * values at M2.
 */
export function presence(fact: Pick<Fact, 'value' | 'source' | 'evidence' | 'confidence_band'>): TriState {
  if (fact.source !== 'user' && (!fact.evidence?.verified || fact.confidence_band === 'low')) return 'unknown';
  const v = fact.value;
  switch (v.type) {
    case 'tri_state':
      return v.value;
    case 'count':
      return v.value === null ? 'unknown' : v.value === 0 ? 'no' : 'yes';
    case 'medication_list':
      return v.value === null ? 'unknown' : v.value.length === 0 ? 'no' : 'yes';
    default:
      return 'unknown';
  }
}

export type Outcome = 'admit' | 'needs_review' | 'do_not_admit';

/** Sub-reason emitted with a needs_review outcome (dev-alignment 2.6). */
export type NeedsReviewReason =
  | 'missing_info'
  | 'clinical'
  | 'financial'
  | 'leadership'
  | 'processing_incomplete';

/** Rule categories (brief §6; ruling R2). payer rules evaluate into financial_status, never the clinical outcome. */
export type RuleKind = 'hard_stop' | 'review' | 'favorable' | 'payer';

/**
 * Fixed outcome resolution order (master-plan §7). The first step that applies wins:
 * 1. processing_incomplete        → needs_review (critical document processing incomplete)
 * 2. hard_stop_true               → do_not_admit
 * 3. hard_stop_or_critical_unknown → needs_review (hard-stop input unknown, or critical fact unknown/conflicting)
 * 4. review_rule_true             → needs_review
 * 5. favorable_rule_true          → admit (only reachable by positive confirmation)
 * 6. default_needs_review         → needs_review (nothing fired)
 * Changing this order is a founder decision recorded in ../ops/decision-log.md.
 */
export const OUTCOME_RESOLUTION_ORDER = [
  'processing_incomplete',
  'hard_stop_true',
  'hard_stop_or_critical_unknown',
  'review_rule_true',
  'favorable_rule_true',
  'default_needs_review',
] as const;

export type ResolutionStep = (typeof OUTCOME_RESOLUTION_ORDER)[number];

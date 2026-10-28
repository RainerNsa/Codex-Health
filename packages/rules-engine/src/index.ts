// Decided types for the rules engine (dev-alignment 0.2, 2.6, 2.8; master-plan §7).
// No logic lives here yet: evaluate() is written with /spec at M2. See README.md.

/** Three-valued (Kleene) fact value. Unknown never collapses to no. */
export type TriState = 'yes' | 'no' | 'unknown';

/** Who asserted the fact: the extraction pipeline or a person. */
export type FactSource = 'ai' | 'user';

/** One source-linked fact from a referral packet. Mirrors packages/schemas/schemas/fact.v0.json. */
export interface Fact {
  /** Fact key from the baseline fact list (snake_case), e.g. "ventilator_use". */
  key: string;
  value: TriState;
  source: FactSource;
  /** Verbatim quote supporting the value; null when the fact was entered by a user. */
  quote: string | null;
  document_id: string | null;
  /** 1-based page within document_id. */
  page: number | null;
  /** ISO date (YYYY-MM-DD) the fact was true as of; null when the source gives none. */
  as_of_date: string | null;
  /** Read by a hard-stop or payer rule; unknown here blocks Admit. */
  is_critical: boolean;
  /** 42 CFR Part 2 / psychotherapy-note class; display-only, routes to Needs Review only. */
  specially_protected: boolean;
}

export type Outcome = 'admit' | 'needs_review' | 'do_not_admit';

/** Sub-reason emitted with a needs_review outcome (dev-alignment 2.6). */
export type NeedsReviewReason =
  | 'missing_info'
  | 'clinical'
  | 'financial'
  | 'leadership'
  | 'processing_incomplete';

export type RuleKind = 'hard_stop' | 'review' | 'favorable';

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

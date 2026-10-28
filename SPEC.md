# Codex Health — Core Specification

Status: **M0 draft — to be completed with `/spec` and the founder interview.**
Version: v0 (2026-10-22). Sources: `../research/planning/master-plan.md`, `../research/dev-alignment.md` (§1 accepted changes, §2 rulings, §4 founder items), `../ops/COO-BRIEF.md`. The brief is cited as §n.

Sections marked **decided** are in force. Sections marked **PENDING** name what is missing and who decides. Nothing here is product code; see `CONSTRAINTS.md` for what every change is checked against.

## 1. Purpose

Answer one question fast and defensibly: *can this facility safely, appropriately and financially accept this patient?* (§3). **The AI reads the packet; the facility's criteria make the call; staff decide.** The MVP is the §21 workflow with §15 as the release bar (master-plan decision 2).

## 2. Architecture (decided)

- A server-side pipeline turns documents into verified, source-linked facts; a pure rules library turns facts and the facility profile into an outcome; a human finalizes. The model never sees the rules, never emits an outcome, has no tools, and its output is schema-bound (ADR 0001).
- Stack: AWS under one BAA — RDS Postgres with row-level security, S3 (private, KMS), SQS with a dead-letter queue, Textract, Claude on Bedrock with a pinned model id, Cognito with MFA for all roles, Secrets Manager, Terraform with dev and test environments (production deferred to M7 behind a workspace flag, dev-alignment 1.12). React/TypeScript front end; Node/TypeScript API and workers (ADR 0002).
- Facility isolation in three layers: API checks, Postgres RLS with `FORCE ROW LEVEL SECURITY` on every tenant table, S3 prefixes with short-lived signed URLs. Workers bind their job's `facility_id` with `SET LOCAL` on a non-`BYPASSRLS` role (1.9).
- Audit log: append-only, per-facility hash chains anchored daily to S3 Object Lock in a separate account, covers writes and reads of patient data (one event per referral view, document open and export; ids, never values) (1.10).
- Organizations are the contract entity; an org-level base rule set with per-facility on/off and profile parameters; no per-facility logic forks (1.7).
- Synthetic data only outside the BAA-covered evaluation environment (ADR 0003). OmniRoute and any non-Bedrock gateway are developer-machine only (ADR 0004).
- The AI-written summary is cut from the MVP (ruling D6). The "why" and the short summary are rendered deterministically from verified facts and the rule trace (M5).

## 3. Three-valued logic (decided)

- Every fact is **Yes / No / Unknown**. Silence in the packet is Unknown. A fact whose quote fails verification is Unknown. A low-confidence fact is Unknown for hard-stop purposes until a person confirms it.
- Rule conditions evaluate under Kleene logic: a condition on an Unknown fact is Unknown, never False. `NOT Unknown = Unknown`; `Unknown AND False = False`; `Unknown OR True = True`.
- An empty facility-profile key evaluates to Unknown and the trace names the empty key (0.3).
- Recency windows ("recent aggression") are measured from the referral date, never the system clock. The engine has no clock and no network.
- Conflicts between documents are shown, never resolved automatically. With `as_of_date`, a chronological sequence is a timeline; the most recent value is suggested and never auto-chosen (5.4).
- Reviewer corrections (`source = user`, with a note) feed the rules; the AI value is retained alongside.

## 4. Outcome resolution order (decided)

Evaluated in this fixed order; the first match wins.

| Step | Condition | Outcome | Sub-reason code |
| --- | --- | --- | --- |
| 1 | Critical processing incomplete (any document not processed and not marked not-applicable) | Needs Review | `processing_incomplete` |
| 2 | Any hard-stop rule true | Do Not Admit | — |
| 3 | Any hard-stop input Unknown, or any critical fact Unknown or in conflict | Needs Review | `missing_info` |
| 4 | Any review rule true | Needs Review | `clinical`, `financial` or `leadership` per the rule |
| 5 | A favorable rule true and nothing above | Admit | — |
| 6 | Nothing fired | Needs Review | `missing_info` |

- Step 5 is governed by the flag `favorable_rule_required` (default **on**): with it on, Admit requires a positive favorable rule; with it off, step 5 reads "nothing above fired → Admit" and step 6 disappears. The founders choose before M2 exit (ruling D12); the Needs Review rate is reported from P0 either way.
- Admit is reachable only by positive confirmation: every fact feeding a triggered rule or a hard-stop input is confirmed by a person before finalize (the minimum confirmation set, 2.7); nothing else is required.
- The critical-input set is derived from the enabled hard-stop and payer rules; a manual `is_critical` flag may only add, never remove (2.4).
- The engine emits, per evaluation: outcome, sub-reason codes, triggered rules with evidence, missing and conflicting items, a ranked list of blocking facts ("would be Admit if X confirmed"), and `clinical_outcome` and `financial_status` as separate fields (1.5). Whether a payer Unknown still blocks the clinical answer stays on merged behaviour until the founders decide (§4 item 10).
- Protected inputs (payer source, psychiatric or behavioral history, substance use, bariatric, homelessness, guardianship, disability-related) route only to Needs Review, never Do Not Admit, unless a rule carries recorded legal approval (2.8).

## 5. Referral state machine (decided states; transitions proposed)

States (ruling D1): `draft`, `processing`, `partial_failure`, `ready_for_review`, `on_hold`, `info_requested`, `escalated`, `finalized`, `amended`.

Main path: `draft → processing → ready_for_review → finalized`. `processing → partial_failure` when any document fails; `partial_failure → processing` on re-upload or replace, or `→ ready_for_review` once every failed document is processed or marked `not_applicable` with a reason (1.4). From `ready_for_review`: `→ on_hold`, `→ info_requested`, `→ escalated` (with a department tag and note, decision 10), each returning `→ processing` when documents are added or `→ ready_for_review` when facts are entered manually. `finalized → amended` only by an audited amendment that creates a new decision record; the original is unchanged (decision 11).

Every fact change (human correction or new document) produces a new immutable evaluation snapshot; a decision pins exactly one `evaluation_id`; the pre-correction raw snapshot is always retained (1.2). The full transition table with guards and the actor allowed per transition is **PENDING: Team B at M1, before the schema lands.**

## 6. Roles and permissions (decided)

Three roles, all with MFA. Escalation is a status plus a department tag, not a role.

| Capability | Admin | Reviewer | Viewer |
| --- | --- | --- | --- |
| Create referral, upload, correct or enter facts | Yes | Yes | No |
| Finalize, override with reason, hold, request info, escalate | Yes | Yes | No |
| Override a hard stop to Admit | Co-sign by a second, different Admin (DB-enforced) | Needs an Admin co-sign | No |
| Facility profile, users, rule on/off per facility | Yes | No | No |
| History and audit | Own facilities | Own facilities | Permitted facilities, read-only; aggregates only across non-member facilities, served from a rollup table with no identifiers |

Organisations and first Admins are created only through an audited internal admin role (1.13). Break-glass scope is **PENDING: founders (§4 item 7).** Patient-level Viewer reads in the pilot are **PENDING: founders (§4 item 8); engineering default is none.**

## 7. Versions pinned on every evaluation (decided)

`criteria_document_ref`, `rule_set_version`, `facility_profile_version`, `model_id` (exact Bedrock id, never an alias), `prompt_version`, `extractor_version`, `ocr_engine_version`, `engine_version`. `processing_runs` additionally meter pages, OCR pages, input/output/cache-read tokens and estimated cost per facility per month (1.6).

## 8. Schemas (decided properties; definitions in `packages/schemas`)

The JSON Schemas are owned by the schemas agent and versioned under `packages/schemas/`. This section fixes what they must express; the files are the source of truth for field names.

- **Extraction fact v0** (`packages/schemas/extraction-fact.v0.json`, 0.2): typed, tri-state value; `is_critical` (provisional, derived set wins); `as_of_date`; `source = ai | user` with a note for user; `specially_protected` flag; evidence = document, page, verbatim quote, verified flag, page-render coordinates; `single_source` flag on hard-stop "No" values; confidence band as a label only. Baseline fact list = §5 Step 5 plus the clinical additions in 0.2; medications are typed records (route, frequency, duration).
- **Facility profile v0** (`packages/schemas/facility-profile.v0.json`, 0.3): typed keys, boolean and count, including counts per constrained bed type; an empty key is Unknown; a profile-completeness checklist drives the facility-settings screen (ruling D2). Static counts only; no daily census (declined X1).
- **Rule record v0** (`packages/schemas/rule-record.v0.json`): the twelve §6 fields plus `legal_basis` (required), `protected_input`, `legal_reviewer`; rule kind = hard_stop | review | favorable | payer; per-facility on/off; True/False/Unknown test cases per rule. Examples live under `packages/schemas/examples/rules/` and are checked by `legal-basis.mjs`.
- **Referral**: `referral_type` (skilled default; long-term, bed-hold readmission, respite, hospice) readable by rules; MVP set is **PENDING: founders (§4 item 11); engineering default is skilled only.**
- **Documents**: status includes `processed`, `failed`, `unreadable`, `not_applicable` (reason required); sha256 duplicate check.

## 9. Retention classes (decided shape; periods pending)

Documents, pages, OCR text and facts on a short purge class; decisions, evaluations and audit rows on a 6-year class carrying ids and hashes only; `deletion_requests` spanning S3 versions, backups, DLQ messages and OCR text; per-referral and per-facility export; per-facility purge provable at pilot end (1.8). Periods are **PENDING: founders (§4 item 6); proposal is a short fixed document purge and 6 years for decision and audit records.**

## 10. Rules DSL

**PENDING: Team B proposes the grammar at M2 (conditions over facts and profile keys under Kleene logic; recency windows from the referral date; no arbitrary code); the business founder and counsel approve rule content, never the grammar.** Seed content until the criteria document arrives: the three §7 examples, labelled as seeds.

## 11. Criteria mapping

**PENDING: the business founder delivers the admissions criteria document and the answers to: does it contain favorable rules; payer or psychiatric hard stops; is it this facility's criteria or general experience (COO brief decision 5). The criteria-to-rules workshop (M1–M2) with counsel fills one rule record per criterion; the business founder signs each rule's wording and critical flags.**

## 12. Threat model and data-flow diagram (dev-alignment 0.9)

**PENDING: Team B with the security lead, one page, at M0.** Must name the four actors the control list missed — pipeline workers, the corporate Viewer, our own staff and support, and the referral source as adversary — and map each to a test in the M1 cross-facility suite. The Supabase fallback is conditioned on "never the anon-key / unauthenticated edge-function pattern" (ADR 0002). Feeds the M8 security questionnaire pack.

## 13. §15 standard → test-type matrix (dev-alignment 0.6)

**PENDING: Team B/QA at M0.** One row per §15 standard: test kind, first-passing milestone, evidence artefact. Standards 7 and 11 are scripted usability protocols with ≥ 3 admissions staff and a written definition of "assistance"; standard 1 passes only after criteria are encoded at M7.

## 14. Pilot event model (dev-alignment 0.5)

**PENDING: Team B specifies at M0, builds at M1.** Per-stage timestamps (received, uploaded, processed, review start/end, finalized), per-user review time, evidence-view events per decisive fact, confirmations, corrections, overrides, raw vs verified recommendation snapshots, `pilot_actual_outcome`, `disagreement_cause` (six §16 codes plus "factor outside tool scope: bed, census, relationship"), adjudicator verdict and notes. Per-facility `pilot_mode` (lagged, blinded, assisted) with lagged semantics per ruling D9.

## 15. Golden-packet label schema (dev-alignment 0.4)

**PENDING: Team B/QA at M0.** Per field: value, document, page, quote span; per packet: expected outcome, triggered rules, missing and conflicting items. The extraction-evaluation set (≥ 25 positive and ≥ 25 near-miss negative fixtures per hard-stop field) is a separate artefact from the 17-type case library. Gate numbers are in `CONSTRAINTS.md` §4.1.

## 16. Open founder decisions

Tracked in `../research/dev-alignment.md` §4 and `../ops/decision-log.md`. The ones this document waits on: criteria document and its three questions; Admit semantics (D12 flag default); clinical vs financial outcome split; referral types; retention periods; Viewer scope; break-glass scope; second-approver mode at a one-Admin facility; preliminary-recommendation visibility; request-info return path; the provisional extraction gate and its fixture arithmetic (`CONSTRAINTS.md` §4.1).

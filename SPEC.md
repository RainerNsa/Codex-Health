# Codex Health — Core Specification

Status: **M0 draft — to be completed with `/spec` and the founder interview.**
Version: v0.1 (2026-10-28; §12 decided, §11 re-pointed at the workshop). Sources: `../research/planning/master-plan.md`, `../research/dev-alignment.md` (§1 accepted changes, §2 rulings, §4 founder items), `../ops/COO-BRIEF.md`. The brief is cited as §n.

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

**PENDING: Team B proposes the grammar at M2 (conditions over facts and profile keys under Kleene logic; recency windows from the referral date; no arbitrary code); the business founder and counsel approve rule content, never the grammar.** Seed content until the criteria workshop (§11) has run: the three §7 examples, labelled as seeds.

## 11. Criteria mapping

**PENDING: ruled 2026-10-28 (F3) that no criteria document is coming.** Rules content comes from a criteria workshop Rainer runs with the clinicians he recruits (F6); counsel joins when funded (F5). The workshop fills one rule record per criterion; Rainer and the clinician sign each rule's wording and critical flags. Until it runs: the provisional hard-stop set is the `is_critical` facts in dev-alignment 0.2, the three §7 examples are the seed rules, and `criteria_document_ref` (§7) points at the signed workshop output.

## 12. Threat model and data-flow diagram (dev-alignment 0.9) — decided 2026-10-28

One page plus a table. Names the actors the control list missed and gives each a test. Test ids `XF-n` are the cross-facility suite (I3): database-role tests in `packages/db/test/`, HTTP tests in `apps/api/test/` from M3, storage and queue tests against LocalStack until an AWS sandbox is funded (F5). A row marked **today** passes in CI now, with the exact scope stated; everything else carries its milestone. Adversarially reviewed by the security-auditor persona on 2026-10-28; its fifteen findings are folded in.

### 12.1 Data flow (the M4 slice)

```
 referral source ──paper / fax / portal PDF──▶ facility staff (outside the system)
                                                     │ upload, browser, Cognito + MFA           B1 internet
 ────────────────────────────────────────────────────┼──────────────────────────────────────────────────
 browser ──JSON, no-store──▶ API (codex_app)         │ signed PUT, TTL ≤ 5 min, checksum-bound  B2 identity
           every txn: SET LOCAL app.facility_id      ▼
           API role is the only bucket principal  S3 documents/<facility_id>/<referral_id>/<sha256>  KMS, no public
           and the only queue sender                 │ quarantined until size + magic-byte checks pass
                                  │                  │ SQS message: referral_id + key; never trusted for tenancy
                                  ▼                  ▼
                     RDS Postgres ◀──────── worker (codex_worker), one job = one referral
                     FORCE RLS on every           facility_id read from the referral row, then SET LOCAL
                     facility_id table              │ per-job STS session policy: documents/<facility_id>/*
                     audit_log append-only,         │ Textract (sync, or async polled; AWS keeps results 7 d)
                     per-facility chain             │ Bedrock pinned model ──▶ facts  no tools, logging off
                                  │                 ▼                                  B4 egress allowlist
                                  │           facts + evidence (quote, page, coords) ──▶ RDS, under RLS
                                  │ daily root hash per facility
 ─────────────────────────────────┼──────────────────────────────────────────────────── B5 account boundary
                                  ▼
                     audit-anchor bucket, separate account, Object Lock, write-once
 ──────────────────────────────────────────────────────────────────────────────────────── B6 synthetic-only line
 developer machines, CI runners, GitHub, OmniRoute: synthetic packets only; CI holds no cloud credentials
```

PHI also persists in: S3 noncurrent versions (kept `retention_days`), RDS automated backups and the final snapshot, the DLQ (14 days), Textract's asynchronous job store (7 days, AWS-side), and CloudWatch log groups (to be created with KMS and ≤ 30-day retention at M1; nothing but ids may land there, canary-checked from M4). The §9 deletion drill at M6 is the test for all of them.

Trust boundaries: **B1** internet to browser; **B2** browser to API (Cognito SRP, TOTP MFA, no self sign-up; the 15-minute idle timeout is client-enforced at M3 with refresh-token revocation); **B3** API and worker to the database (two `NOBYPASSRLS` roles plus the per-transaction session variable; the API tier's network path arrives with compute at M1, today only workers reach the DB security group); **B4** VPC to AWS services (interface endpoints with policies; no internet gateway anywhere; no NAT in test and prod, optional in dev); **B5** workloads account to anchor account; **B6** anything real to anything a developer, CI runner or coding agent can reach.

### 12.2 Actors, threats, controls, tests

| Actor | Reach | Threat | Control (where it is enforced) | Test |
| --- | --- | --- | --- | --- |
| **Referral source** (adversary; sends the packet) | The packet only | Planted visible text ("no ventilator dependence") that passes the verbatim check because it is on the page; invisible text (white-on-white, 2 pt) that OCR reads; a hostile PDF that exploits the parser; script or markup in a field value; prompt injection aimed at the model | The model has no tools, never sees the rules, never emits an outcome; output is schema-bound (ADR 0001). Hard-stop inputs are confirmed by a person against the **rendered page image** (I2, M5). `single_source` flag on any hard-stop "No" (X2 substitute). Parsers run in a sandboxed worker with upload caps and magic-byte checks (M3). Extracted values render as text; `dangerouslySetInnerHTML` is banned (Floor, **today**). The AI summary is cut (D6) | XF-7a invisible, XSS and instruction-shaped text: outcome equals the clean packet's (M5). XF-7b planted visible text on a hard-stop field: the fact is flagged `single_source` and blocks finalize until page-image confirmation (M5). XF-8 hostile-PDF corpus: the sandboxed worker dies, its prefix is untouched, no facts are written (M4) |
| **Queue sender** (anyone in the account with `sqs:SendMessage`) | The worker's input | A forged message naming facility B and B's key makes the worker bind to B and process B's packet; today the SCP and endpoint policy allow `sqs:*` account-wide and the queue has no policy | The worker derives `facility_id` from the referral row it owns, never from the message; a message whose key disagrees with the row is dead-lettered. Queue policy restricts `SendMessage` to the API role (M1 infra) | XF-13 a message whose `referral_id` and key disagree, or whose referral belongs to another facility than the key prefix, is rejected and dead-lettered with no facts written (M4, LocalStack) |
| **Pipeline worker** | One referral's documents per job; Textract and Bedrock | Bug or compromise reads or writes another facility's rows or S3 prefix; exfiltrates through egress; leaks document text into logs or the queue | `codex_worker` is `NOBYPASSRLS` and binds its job's `facility_id` with `SET LOCAL`; `FORCE RLS` on every tenant table (**today**). Per-job credentials: the worker assumes its role with a session policy scoped to `documents/<facility_id>/*` (M1; a static task role cannot narrow per job). Endpoint policies: S3 only our two buckets, Bedrock only the pinned model ARN (**today**, infra tests). Queue payloads carry ids and keys, never text; log field allowlist (data policy 5) | XF-1 worker role bound to A sees zero rows of B (**today** on referrals, facilities, audit_log; every table from M1 when the suite iterates `rls-enumeration.sql`'s result set). XF-2 worker with an unset facility sees zero rows (**today**, referrals only; all tables M1). XF-3 credentials minted for job A are denied `GetObject` on B's key (M4, LocalStack). XF-4 a worker crash mid-packet leaves no half-written facts (M4). Canary-PHI sweep over worker logs and the DLQ (M4, needs the F5 sandbox) |
| **Corporate Viewer** | Several facilities, read-only; the widest account | "Aggregates across non-member facilities" cannot be expressed in RLS; the shortcut is a `USING (true)` policy or a query outside RLS. There is no Viewer database role: `viewer` is an application role on `codex_app`, so the distinction lives in the API | Patient-level rows only in member facilities: the API sets `app.facility_id` only to a membership. Cross-facility numbers come only from a rollup table with **no identifier columns**, the single allow-listed exception in `rls-enumeration.sql`. No patient-level cross-facility read in the pilot (R5 default; §6 keeps the founder item open; any later one is a `constraints-change` PR with its own suite case) | XF-5 API test: a Viewer token for {A1, A2} gets 404 on B's referral, 403 on every write, and the set of facilities it can bind is exactly its memberships (M3). XF-6 schema test: the rollup table has no `referral_id`, `document_id`, name, MRN or date-of-birth column and is the only table on the enumeration allowlist (M1) |
| **Our own staff and support** | The database as owner; provisioning; "can you look at this referral" | A raw connection as `codex_migrator` writes tenant data with no audit row; a support read nobody records | `codex_migrator` runs migrations and the synthetic seed only; `FORCE RLS` binds the owner (**today**, migration). `codex_app` and `codex_worker` are `NOSUPERUSER NOBYPASSRLS` (grants.sql, **today**; a check that no other role has `SUPERUSER` or `BYPASSRLS` is M1). Organisations and first Admins are created only through the audited internal admin role (1.13, M1), writing to a platform-scope audit chain, since `audit_log.facility_id` is NOT NULL and an organisation has no facility when it is created. No standing support access; break-glass is a time-boxed grant through that role with an audit row per read and notice to the facility Admin (R5 default; §6 founder item stays open) | XF-9 the owner role with no `app.facility_id` set sees zero rows on every tenant table (M1; today only app/worker are tested unset). XF-10 the internal-admin role's INSERT into `organizations` fails when its platform-audit INSERT fails (M1, with the platform chain). `grants.sql` (**today**) plus the M1 "no other SUPERUSER/BYPASSRLS role" row |
| **Account operator** (a human with admin IAM in the workload account: a laptop running `terraform apply`) | Every store: S3 objects, RDS snapshots, the master password in Secrets Manager, Cognito users, SQS and the DLQ | Reads the master credential and logs in as `codex_admin` (the human-reachable master user, which `FORCE RLS` does not bind); restores a snapshot under a new password; `GetObject` on any document (no bucket policy restricts principals); `AdminCreateUser` with a staff email; redrives the DLQ | No standing admin credential in test or prod; break-glass by assumed role with a CloudTrail alert (M1 infra, with the organisation trail and GuardDuty). KMS key policies restricted to service roles (M1). Bucket policy: API role and worker session role are the only principals (M1). `terraform apply` is a named human from their own workstation with MFA (infra README) | Snapshot-restore drill: the restored instance has no human login and the chain verifies against the anchor (M8). CloudTrail alert fires on `GetSecretValue` for the master secret and on `AdminCreateUser` outside the provisioning path (M1) |
| **Facility staff** (Reviewer, Admin; the legitimate user) | Own facilities | IDOR by referral id in a URL; sharing a signed URL; an unattended shared workstation; a Reviewer overriding a hard stop alone; a client-chosen object key that overwrites an existing document | API authorisation then RLS, so a foreign id is a 404 not a 403. The signed-URL issuer (the API role) is the only principal holding bucket-wide access, so the authz check before signing is the control; URLs are issued only after it, TTL ≤ 5 min; the PUT is bound to `x-amz-checksum-sha256` and the object is quarantined until size and magic-byte checks pass (M3). `no-store` on every response (**today**, API); 15-minute idle timeout (M3). Hard stop → Admit needs a second, different Admin, enforced by a database CHECK and trigger (I5) | XF-11 as a user of A, every endpoint with B's referral id returns 404 and writes no audit row for B (M3). XF-12 a user of A cannot obtain a signed URL for B's key (issue endpoint 404), and an issued URL fails after its TTL (M4, LocalStack). Co-sign test: the same user twice is rejected in the database (M1 schema) |
| **Cloud and infrastructure** | The AWS account | Misconfiguration opens a bucket, an unpinned model or a new region; an attacker with the account rewrites the audit chain | SCP HIPAA-eligible allowlist and region pin; AI-services opt-out; block-public-access, KMS and TLS-only on every bucket; endpoint policies; the anchor bucket in a **separate** account with Object Lock and write-once keys, so rewriting the chain in RDS does not rewrite the anchor | `infra/scripts` static tests (**today**). Chain verifier: alter one audit row and the daily root differs from the anchored one (M1). CloudTrail organisation trail and GuardDuty (M1) |
| **The model** (Bedrock) | Page text and the prompt | A boundary, not an actor: it cannot decide, act, or retain | No tools, no outcome field, schema-bound, pinned id (I7, I9); US regions only; `bedrockClientConfig()` refuses an endpoint override (**today**). Invocation logging cannot be switched on from a workload account (SCP denies the configuration call, **today**); that it is off is verified in the account at M4 | `bedrock-only.mjs` (**today**); logging-off verification (M4, needs the F5 sandbox) |

### 12.3 What the controls do not cover (residual, each dated)

- **A packet that lies truthfully.** Planted visible text passes the verbatim check by design. The mitigation is page-image confirmation of hard-stop inputs at M5; the two-document corroboration rule was declined (X2) with `single_source` as the substitute. Residual accepted at M5 exit unless Rainer reverses X2.
- **The RDS master user** `codex_admin` and AWS's own `rdsadmin`. `FORCE RLS` binds neither. The master credential has no human path once break-glass exists (M1); until then any account operator can reach it, and CloudTrail is the detective control (M1). Dated: M1.
- **The chain before anchoring.** Until the M1 anchoring job and verifier exist, the chain is tamper-evident only against someone who cannot rewrite it. Dated: M1.
- **Tests that need a live account.** XF-3, XF-12, the canary sweep of real log sinks and the logging-off verification run on LocalStack or not at all until the F5 sandbox is funded. Dated: F5.
- **The two public prototypes.** Outside this system; accounts not held by Codex Health; recorded 2026-10-28 as the former partner's residual exposure. Nothing from them is imported (data policy 7).
- **Supabase fallback** (ADR 0002) stays conditioned on never using the anon-key or unauthenticated edge-function pattern; a move to it re-runs this section.

### 12.4 What this section feeds

M1: XF-1/XF-2 extended to every tenant table, XF-6, XF-9, XF-10 and the platform audit chain, the co-sign test, the queue policy, per-job worker credentials, CloudTrail and GuardDuty, log groups, restricted KMS and bucket policies. M3: XF-5, XF-11, upload quarantine, idle timeout. M4: XF-3, XF-4, XF-8, XF-12, XF-13. M5: XF-7a/b. M8: the snapshot-restore drill and the security questionnaire pack, which answers "how is tenant data isolated" by pointing at this table and the green suite.

## 13. §15 standard → test-type matrix (dev-alignment 0.6)

**PENDING: Team B/QA at M0.** One row per §15 standard: test kind, first-passing milestone, evidence artefact. Standards 7 and 11 are scripted usability protocols with ≥ 3 admissions staff and a written definition of "assistance"; standard 1 passes only after criteria are encoded at M7.

## 14. Pilot event model (dev-alignment 0.5)

**PENDING: Team B specifies at M0, builds at M1.** Per-stage timestamps (received, uploaded, processed, review start/end, finalized), per-user review time, evidence-view events per decisive fact, confirmations, corrections, overrides, raw vs verified recommendation snapshots, `pilot_actual_outcome`, `disagreement_cause` (six §16 codes plus "factor outside tool scope: bed, census, relationship"), adjudicator verdict and notes. Per-facility `pilot_mode` (lagged, blinded, assisted) with lagged semantics per ruling D9.

## 15. Golden-packet label schema (dev-alignment 0.4)

**PENDING: Team B/QA at M0.** Per field: value, document, page, quote span; per packet: expected outcome, triggered rules, missing and conflicting items. The extraction-evaluation set (≥ 25 positive and ≥ 25 near-miss negative fixtures per hard-stop field) is a separate artefact from the 17-type case library. Gate numbers are in `CONSTRAINTS.md` §4.1.

## 16. Open founder decisions

Tracked in `../research/dev-alignment.md` §4 and `../ops/decision-log.md`. The ones this document waits on: criteria document and its three questions; Admit semantics (D12 flag default); clinical vs financial outcome split; referral types; retention periods; Viewer scope; break-glass scope; second-approver mode at a one-Admin facility; preliminary-recommendation visibility; request-info return path; the provisional extraction gate and its fixture arithmetic (`CONSTRAINTS.md` §4.1).

# Codex Health — Core Specification

Status: **M0 draft — to be completed with `/spec` and the founder interview.**
Version: v0.2 (2026-10-28; §12–§15 decided, §11 re-pointed at the workshop). Sources: `../research/planning/master-plan.md`, `../research/dev-alignment.md` (§1 accepted changes, §2 rulings, §4 founder items), `../ops/COO-BRIEF.md`. The brief is cited as §n.

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

- **Extraction fact v0** (`packages/schemas/schemas/fact.v0.json`, 0.2): typed, tri-state value; `is_critical` (provisional, derived set wins); `as_of_date`; `source = ai | user` with a note for user; `specially_protected` flag; evidence = document, page, verbatim quote, verified flag, page-render coordinates; `single_source` flag on hard-stop "No" values; confidence band as a label only. Baseline fact list = §5 Step 5 plus the clinical additions in 0.2; medications are typed records (route, frequency, duration).
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

## 13. §15 standard → test-type matrix (dev-alignment 0.6) — decided 2026-10-28

The brief's twelve readiness standards (§15) are the release bar. "All twelve have automated tests" is replaced by this table: each standard names its test kind, the milestone at which it first passes, and the artefact that proves it. A standard passes only when its artefact exists and is linked from the milestone exit record in `../ops/decision-log.md`. At M8 this table, with evidence links filled in, is the pre-PHI checklist (QA review, M8).

**Assistance**, for standards 7 and 11: any communication to the tester during a scripted task from anyone present (developer, agent, facilitator, clinician or another tester), other than reading the task aloud. Answering a question, pointing at a control, or explaining an error counts as assistance and fails the task. A tester who abandons a task, or exceeds the protocol's per-step time cap, also fails it. Sessions are recorded; the tester, not the facilitator, signs the assistance log. **Admissions staff** means a person currently doing admissions screening at a skilled nursing facility; the professionals recruited under F6 qualify only if they do.

| # | §15 standard | Test kind | First passes | Evidence artefact |
| --- | --- | --- | --- | --- |
| 1 | Every admissions criterion has been tested | Rule CI: every rule record in the enabled rule set has a True, a False and an Unknown case and all three pass (CONSTRAINTS §4.2) | Seeds at M2; the full set only after the criteria workshop (§11) is encoded. That milestone (M7) is unscheduled under F3 | Rule-coverage report from rule CI listing every rule id with its three cases |
| 2 | Every hard-stop rule has at least one passing and one failing test | Same gate as 1, restricted to `kind = hard_stop`; plus the generative property "a correction that makes a hard stop true flips to Do Not Admit with the AI value retained" (2.3) | M2 for the seed hard stops; the full set with row 1 | Rule-coverage report; property-test run log |
| 3 | Missing information cannot silently produce an Admit | Generative property tests over random facts and rule sets: no Admit while any critical fact is Unknown, in conflict, or processing is incomplete (I1); **and no Admit when the confirmed set is empty or every fact is Unknown, whatever `favorable_rule_required` is set to** (otherwise an empty rule set with the flag off admits an all-Unknown packet through step 5); outcome-resolution table test (§4) | M2 (engine); M4 end-to-end on the slice | Property-test run log; the §4 table test; one end-to-end fixture with a critical Unknown ending in Needs Review `missing_info` |
| 4 | Contradictory information is visibly flagged | Pipeline test: two documents with opposing values on one fact produce a `conflict` item, never a resolved value (§3); UI test: the review screen renders the §19 contradictory-information state from a test flag (3.2) | M4 (pipeline, slice facts); M5 (timeline-aware, 5.4) | Golden packets with labelled conflicts (§15 label schema `conflicts`); the UI state test's screenshot, taken on a canary-free non-golden fixture, since `canary-phi.mjs` treats snapshot directories as log sinks |
| 5 | Uploaded documents cannot be accessed by unauthorized users | Storage and API tests XF-11, XF-12 (§12); bucket policy and block-public-access static tests; signed-URL TTL test (§4.2) | Static tests today; XF-11 M3; XF-3, XF-12, XF-13 M4 (LocalStack until the F5 sandbox) | Cross-facility suite run log; `infra/scripts` test log |
| 6 | One facility cannot access another facility's information | Cross-facility suite XF-1, XF-2, XF-5, XF-9 as every role, the worker role and the database role directly; `db-grants.mjs` enumeration (I3) | XF-1 today on three tables and XF-2 on `referrals`; every table M1; XF-5 M3; the "zero files" half of I3 is row 5's XF-3 | Suite run log in the CI `db-checks` job; `rls-enumeration.sql` zero rows |
| 7 | Users can complete the full workflow without developer assistance | Scripted usability protocol (2.10): the fifteen §21 steps on a synthetic packet, time-on-task per step, assistance as defined above, comprehension probe per §19 state, evidence-view rate per decisive fact before Finalize. Passes when **every** tester in a cohort of ≥ 3 admissions staff completes all fifteen steps unassisted; a cohort is named before the session and nobody is dropped from it afterwards | Session 1 at M2 (manual-entry slice, one reviewer), session 2 at M4, session 3 at M6, the three-person pass at M8. Until F6 names a reviewer, each session is recorded as **"standard 7 not met: no admissions staff available"**, never as passed by proxy | Session protocol, per-tester task sheet, time-on-task table, assistance log |
| 8 | The recommendation can be traced to triggered criteria | Engine test: every evaluation lists the triggered rule ids, their inputs and values; replay property test reproduces the stored snapshot exactly from the pinned versions (I6) | M2 (engine trace); M4 (rendered on the recommendation screen) | Property-test run log; one stored evaluation snapshot with its trace |
| 9 | Major findings can be traced to referral evidence | Pipeline test: every AI-sourced Yes/No fact carries a verbatim quote that verifies against the page text, or is Unknown (I2); evidence carries document, page and page-render coordinates; UI test: fact → rendered page image with highlight (5.1) | M4 (slice facts, exact-match quotes on clean generator output); M5 (all facts, scan-degraded output, normalisation rules and both 5.6 metrics) | Quote-verification pass rate and false-pass rate from the eval harness; golden-packet labels with quote spans (§15) |
| 10 | Overrides are documented | Database and API tests: an override without a non-blank reason is rejected server-side; a hard stop → Admit override without a second, different Admin is rejected by the database CHECK and trigger; the override row carries the reason, approver identity and role title, and the audit row carries that row's id and hash, never the text (I4, I5) | M1 (schema and database tests); M6 (screen) | Database test log; one override row with its audit row in the synthetic demo org |
| 11 | Errors are visible and understandable | Every §19 state (loading, error, processing failure, missing information, contradictory information, override confirmation) reachable by a test flag with a snapshot test (3.2); comprehension probe in the usability protocol: for each of the six states, the tester states the cause and the next action, scored against a written answer key; passes when every cohort tester scores all six | Snapshot tests M3 (on canary-free fixtures, as row 4); the probe with the row-7 cohort at M8, recorded **"not met: no admissions staff"** until F6 names them, as row 7 | Snapshot test log; comprehension-probe sheet and answer key per tester |
| 12 | Failed processing does not produce a misleading recommendation | Fault-injection tests per pipeline stage (4.3, 5.7): a failed or unprocessed document, empty OCR on a page with content, evidence pointing at a non-existent page, and a stuck job each leave the referral in `partial_failure` with outcome Needs Review `processing_incomplete` (§4 step 1); a worker crash leaves no half-written facts (XF-4); idempotent re-processing | M4 (document failure, crash, idempotency); M5 (OCR and evidence injections) | Fault-injection run log; one end-to-end fixture per failing stage |

Rows 5 and 6 are also security evidence (§12.4). Rows 7 and 11 are the only standards a human must witness; nothing substitutes for the three admissions staff.

## 14. Pilot event model (dev-alignment 0.5) — decided 2026-10-28; built at M1 (events), M6 (pilot fields)

The pilot track is parked under F4 (no facility). The event model is specified anyway because the same events feed the usability sessions (§13 rows 7 and 11), the CONSTRAINTS §6 measurements, and every §17 metric; the pilot-only fields in 14.3 are built at M6 only if a facility exists by then.

### 14.1 Events

One table, `product_events`, tenant-scoped by `facility_id` under RLS, append-only like `audit_log` but **not** hash-chained. It carries ids, timestamps, durations and enum codes, never a fact value, a quote or a name. It is still PHI-bearing (a timestamp per referral is a date of service), so it sits in the short purge class with the referral (§9) and leaves the system only as aggregates (6.7). Every row: `facility_id`, `referral_id`, `actor` (user id or `worker:<job id>`), `event`, `at`, and an `attrs` JSON object whose keys are limited to the allowlist below; a row with any other key is rejected by a CHECK at M1.

| Event | When | `attrs` keys (ids and numbers only) | Emitter |
| --- | --- | --- | --- |
| `referral.received` | A referral is created; `received_at` is what the user says the hospital sent it, defaulting to creation time | `received_at` | API |
| `referral.uploaded` | Each document upload completes | `document_id`, `pages`, `bytes` | API |
| `document.processed` / `document.failed` | A document leaves the pipeline | `document_id`, `pages_ocr`, `stage` (on failure), `duration_ms` | worker |
| `referral.ready` | Status enters `ready_for_review` | `evaluation_id`, `outcome`, `sub_reasons[]`, `blocking_count` | worker |
| `review.started` / `review.ended` | A Reviewer or Admin opens or leaves the review screens; `ended` carries the active time so idle time on a shared workstation is excluded | `screen`, `active_ms` | web |
| `evidence.viewed` | The page image for a fact is opened | `fact_key`, `document_id`, `page`, `decisive` (bool: feeds a triggered rule or hard-stop input) | web |
| `fact.confirmed` / `fact.corrected` / `fact.entered` | Confirmation of an AI value; a correction; a user-entered fact. No values: even a tri-state code is the fact, and for a `specially_protected` key it is the protected fact, so `fact_key` is omitted for those | `fact_key` (omitted when specially protected), `decisive` | API |
| `evaluation.created` | Every re-evaluation after a fact change or new document; `raw` is true for the pre-correction AI-only snapshot (1.5, 4.2) | `evaluation_id`, `previous_evaluation_id`, `raw`, `outcome`, `changed_fact_count` | API |
| `decision.finalized` / `decision.amended` | A decision row is written or amended; `decisive_fact_count` is the size of the minimum confirmation set (2.7) at that moment and `decisive_viewed_count` the number of those facts with at least one `evidence.viewed` before this event | `decision_id`, `evaluation_id`, `outcome`, `override` (bool), `cosigner_present` (bool), `decisive_fact_count`, `decisive_viewed_count` | API |
| `referral.held` / `referral.info_requested` / `referral.escalated` | State changes from `ready_for_review` (§5) | `department` (enum, escalation only), `items_requested` (count) | API |
| `pilot.outcome_recorded` / `pilot.adjudicated` | 14.3 fields written | `decision_id`, `cause`, `verdict` | API |

Per-stage timestamps (received, uploaded, processed, review start and end, finalized) are derived from these events, never stored twice. Per-user review time is the sum of `active_ms` over `review.*` pairs per referral per user. The evidence-view rate per decisive fact before Finalize (§13 row 7) is `decisive_viewed_count / decisive_fact_count` on `decision.finalized`, computed server-side at that moment because `decisive` on a view event is stamped at view time and can change after a correction.

### 14.2 Snapshots

Every evaluation is an immutable row (I6). The pipeline writes the **raw** snapshot before any human touches a fact; every correction or new document produces a new **verified** snapshot; a decision pins exactly one. The pilot compares the raw and the verified outcome separately against the actual decision (6.7), so neither may be overwritten.

### 14.3 Pilot-only fields (M6, if a facility exists)

On the decision row:

- `pilot_actual_outcome`: `admitted | declined | withdrawn | pending`, entered by staff after the facility's own process decides.
- `disagreement_cause`: one of seven codes: `incorrect_extraction`, `missing_information`, `incorrect_rule_logic`, `facility_specific_exception`, `human_judgment`, `error_in_existing_process` (the six §16 causes) and `outside_tool_scope` (bed, census, relationship; the seventh from 0.5). Required when the pinned outcome and `pilot_actual_outcome` disagree.
- `adjudicator_verdict`: `tool_correct | process_correct | both_wrong | indeterminate` and `adjudicator_id` on the decision row (6-year class, codes and ids only); `adjudicator_notes` is free text and therefore lives in a separate notes table on the short purge class, excluded from export; `reliability_sample` (bool) marks the 10–20% of agreements and every disagreement a second adjudicator also judges.

Per facility: `pilot_mode` = `lagged | blinded | assisted`, default `lagged` for a facility flagged `pilot` (R5) and `assisted` otherwise, so the R8 demo organisation shows its recommendation. **Lagged semantics (ruling D9):** the engine runs at processing time and the evaluation is sealed and audited then, so the recommendation provably predates the facility's decision; it is hidden from every user by permission until `pilot_actual_outcome` is entered, then revealed. `blinded` shows it only to users flagged `pilot_reviewer`; `assisted` shows it to all Reviewers and Admins.

### 14.4 What the model answers

§17 speed from the stage timestamps; §17 accuracy from raw-vs-verified agreement, `disagreement_cause` and adjudication; §17 reliability from `document.failed` and re-processing counts; adoption from referral counts per facility; the CONSTRAINTS §6 Needs Review rate from `referral.ready`; every number leaves the system only through the aggregate CSV (6.7).

## 15. Golden-packet label schema (dev-alignment 0.4) — decided 2026-10-28; schema file at M1

A golden packet is a synthetic referral packet plus a label file that says what a correct system must find in it. Labels live in `packages/schemas/schemas/golden-packet-label.v0.json` (M1, schemas as data) with examples under `packages/schemas/examples/golden/`. Committed per packet: the label, the generator inputs, and the per-page **reference text** (the ground truth the generator rendered, as `pages/<n>.txt`). The rendered PDF is never committed (`.gitignore`); the generator (4.5, M4) reproduces it from the inputs.

Two artefacts, never mixed:

- **The case library** (the 17 Phase 9 case types, two packets each): tests that the whole workflow reaches the right outcome for each kind of referral. Its labels carry the packet-level fields below; per-field labels are optional.
- **The extraction-evaluation set**: tests per-field recall on hard-stop fields against the CONSTRAINTS §4.1 gate. Its labels carry every per-field element; it lives in its own directory so the gate cannot be padded with case-library packets. QA authors ≥ 30 positive and ≥ 30 near-miss negative fixtures per hard-stop field (R4); the enforced floor is whatever `CONSTRAINTS.md` §4.1 says, ≥ 25 today, and raising it to 30 is a pending `constraints-change` PR now that a remote exists.

### 15.1 Per packet

| Field | Meaning |
| --- | --- |
| `packet_id`, `set` (`case_library` \| `extraction_eval`), `case_type` (one of the 17 types, case library only), `generator_version` | Identity; the generator version pins layout, fax cover, rotation and scan degradation (4.5) |
| (no canary field) | Every packet embeds the three canary strings from `scripts/checks/canary-strings.json`; the schema test asserts all three occur in the packet's committed reference text, so the claim cannot be written, only proven |
| `referral_date`, `referral_type` | Recency windows run from `referral_date` (§3); `referral_type` per §8 |
| `documents[]`: `document_id`, `type`, `pages`, `expected_status` (`processed` \| `failed` \| `unreadable` \| `not_applicable`) | Document classification (5.5) and the §4 step-1 behaviour; a `failed` document is how §13 row 12 fixtures are labelled |
| `facility_profile_ref`, `rule_set_ref` | Which synthetic profile and rule set the expected outcome was computed against; both pinned by version. Case-library packets must carry a per-field label (15.2) for every fact the referenced rule set reads, so rule CI has its inputs |
| `expected.outcome`, `expected.clinical_outcome`, `expected.financial_status`, `expected.sub_reasons[]` | The §4 result for this packet under the referenced profile and rules |
| `expected.triggered_rules[]` | Rule ids that must fire, each with the fact keys it fired on |
| `expected.missing[]` | Fact keys that must be Unknown and reported as missing |
| `expected.conflicts[]`: `fact_key`, `values[]` of {`document_id`, `page`, `value`, `as_of_date`} | Facts with opposing values across documents; the system must surface all values and choose none (§3) |
| `adversarial`: `planted_visible[]`, `invisible_text[]`, `xss_values[]`, `instruction_text[]`, `identity_mismatch_pages[]` | Which fields or pages carry an attack (§12 XF-7a/b, 5.3). An adversarial packet's twin is the same `packet_id` with `_clean` suffix; the differential suite asserts on facts and quotes, not outcome (5.7) |

### 15.2 Per field (required in the extraction-evaluation set; optional in the case library)

One entry per fact key the packet is labelled for, using the fact v0 field names:

| Field | Meaning |
| --- | --- |
| `key` | Fact key from the baseline list (§8) |
| `value` | `yes` \| `no` \| `unknown`; `unknown` is a legitimate label: the packet is silent, and the extractor must say so (I1) |
| `document_id`, `page` | Where the evidence is; null when `value = unknown` |
| `quote` | The verbatim supporting text as it appears in the page's committed reference text (`pages/<n>.txt`), not OCR output |
| `span`: `start`, `end` | Character offsets of `quote` in that reference text, so the 5.6 pass rate on correct facts can be scored against OCR drift without a human |
| `negative_quotes[]` | Passages that are verbatim-present on the page but do not support `value`, plus fabricated passages that are not on the page at all; the 5.6 false-pass rate is scored on these (the human-labelled evidence-support fixtures) |
| `as_of_date` | The date the fact is true as of, from the document |
| `polarity` | `positive` \| `near_miss_negative` \| `absent`; near-miss negatives are the "weaned before discharge", "decannulated" cases the gate counts separately (§4.1) |
| `is_critical`, `specially_protected` | Mirrors the fact schema, so a label can assert the flags the extractor must set |
| `typed_value` | For non-tri-state facts (counts, medication records; §8 and R2): the structured value; its schema arrives with the R2 slice |

### 15.3 How the labels are used

- The eval harness (4.5, 5.7) produces a 3×3 confusion matrix per `key` from `value`, scores quote verification from `span`, and computes the §4.1 gate numbers per hard-stop field over the extraction-evaluation set only.
- Rule CI never reads a packet: it runs the engine on the per-field labels and the referenced profile and compares with the `expected` block (free, offline; 2.9).
- Every label file passes the schema test in `packages/schemas/test/` before it is merged: schema-valid; all three canary strings present in the reference text; every `quote` equal to the reference text at its `span`; every `negative_quotes[]` entry either present on the page or marked `fabricated`. The reference text makes this enforceable from M1, before the generator exists.
- Labels are authored by QA from the generator's ground truth, reviewed by the clinician once F6 names one; until then the clinical lead agent proxies and the label says `reviewed_by: "agent-proxy"`, which the M5 gate reports as provisional.

## 16. Open founder decisions

Tracked in `../research/dev-alignment.md` §4 and `../ops/decision-log.md`. The ones this document waits on: criteria document and its three questions; Admit semantics (D12 flag default); clinical vs financial outcome split; referral types; retention periods; Viewer scope; break-glass scope; second-approver mode at a one-Admin facility; preliminary-recommendation visibility; request-info return path; the provisional extraction gate and its fixture arithmetic (`CONSTRAINTS.md` §4.1).

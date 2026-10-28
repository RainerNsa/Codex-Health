# Constraints

Version: v0 (M0 draft). Last reviewed: 2026-10-22 by the DevOps constraints author (security-auditor and QA lens).
Sources: `../research/planning/master-plan.md`, `../research/dev-alignment.md` (rows 0.7, 0.10, 0.11, 1.9, 1.10, 2.8, 2.9), the security, compliance and QA sector reviews.

This file is the quality and safety bar for Codex Health. Every number in it has a reason next to it. Every check in it names the command that produces the verdict. A rule with a number and no command is listed under "Not constrained yet" with the milestone it arrives, not here.

## 0. Precedence and who may change this file

1. **CONSTRAINTS.md wins.** Where it conflicts with ponytail (any level), with `CLAUDE.md` or `AGENTS.md`, with any skill, command, persona, prompt or agent instruction, or with a task handed to an agent by a workflow script, this file wins. The audit hash chain, RLS, verbatim quote verification, the version stamps and override reasons are required, not extras to cut.
2. **No agent may weaken it.** An agent that cannot make a change pass stops and reports; it does not lower a threshold, remove a check from a stage, add an exception, skip a test, add a suppression comment or edit this file. A change that touches this file in the same PR as the feature that was failing is refused.
3. **Who may change it:** the founder (Rainer, sole founder and owner since 2026-10-23, holding the security hat until a security lead is named; `../ops/OPERATIONS.md`), through a PR labelled `constraints-change`, with the reason in the PR description, after the security-auditor persona's review is attached. When a second engineer or security lead exists, they approve too. Tightening may be proposed by anyone; the same people approve it. Exceptions (section 7) follow the same path, since an exception is a weakening with a date on it.
4. Checks and scripts mirror this file, not the other way round. If a script and this file drift, this file is right and the script is a bug.

## 1. Invariants (must always hold)

These are the properties the product is sold on. They are enforced in the database, the engine and the pipeline, never only in the UI. Each names the check or test that proves it and the milestone at which that proof first exists.

| # | Invariant | Proven by | First proven |
| --- | --- | --- | --- |
| I1 | **Unknown never becomes Admit or No.** Silence in the packet is Unknown; an Unknown input to a hard-stop rule routes to Needs Review; no Admit while any critical fact is Unknown, in conflict, or processing is incomplete. | Engine property tests (generative, three-valued) and the outcome-resolution table test | M2 |
| I2 | **Every AI-extracted fact carries a verbatim quote verified against the page text, or it is Unknown.** Hard-stop inputs are additionally confirmed by a person against the rendered page image before a decision is final. | Pipeline tests; quote-verification metrics; verify-view enforcement | M4 (slice), M5 (full) |
| I3 | **Every tenant query is RLS-scoped.** Every table with a `facility_id` has `FORCE ROW LEVEL SECURITY` and a policy; the app and worker roles lack `BYPASSRLS`; workers bind their job's `facility_id` with `SET LOCAL`. The cross-facility suite returns zero rows and zero files as every role, as the worker role, and as the database role directly. | `db-grants.mjs` (section 3); cross-facility suite | M1 |
| I4 | **The audit log is append-only and hash-chained.** `UPDATE`/`DELETE` on `audit_log` fail for the app role; per-facility chains; root hashes anchored daily to S3 Object Lock in a separate account; a verifier job; an action whose audit write fails does not happen. Audit rows carry ids and hashes, never PHI values. | `db-grants.mjs`; tamper test | M1 |
| I5 | **An override needs a reason**, rejected server-side when empty or whitespace. **A hard stop → Admit override needs a second approver who is a different user with the Admin role, enforced by a database CHECK and trigger**, with the approver's identity, name and role title in the audit row. | Database tests; API tests | M1 (schema), M6 (screen) |
| I6 | **Every evaluation pins its versions:** criteria document reference, rule-set version, facility-profile version, model id, prompt version, extractor version, OCR engine version. A decision row pins exactly one immutable `evaluation_id`; the pre-correction raw snapshot is always retained; finalized decisions change only by an audited amendment. | Schema tests; replay property test ("replay reproduces the stored snapshot exactly") | M1 (schema), M2 (replay) |
| I7 | **The production AI endpoint is AWS Bedrock only,** with a pinned model id, under the AWS BAA. No other AI provider, gateway or proxy exists in the product path. Egress from the pipeline is limited to the Terraform allowlist (S3, Bedrock, Textract via VPC endpoints). | `bedrock-only.mjs`; Terraform policy checks; egress test | M0 (script), M1 (CI), M4 (egress test) |
| I8 | **Synthetic data only** on developer machines, in CI, in dev and test environments, in fixtures and golden packets, and on any host a coding-agent gateway (OmniRoute or similar) can reach. Real packets, de-identified or not, exist only in the BAA-covered evaluation environment (section 5). | `canary-phi.mjs`; `secrets.mjs`; the data policy | M0 |
| I9 | **Rules decide; the AI extracts and explains; humans finalize.** The model never sees the rules, never emits an outcome, has no tools, and its output is schema-bound. Conflicts are shown, never resolved automatically. Reviewer corrections feed the rules and the original AI values are kept. | Engine has no network and no clock (library tests); differential prompt-injection suite | M2 (engine), M5 (injection suite) |
| I10 | **No rule reads a protected input without recorded legal approval.** Every rule record carries `legal_basis`; a hard-stop or payer rule with `protected_input` set and no `legal_reviewer` is rejected by CI; protected inputs route to Needs Review, never Do Not Admit. | `legal-basis.mjs` (presence, M0); approval logic in rule CI (M2) | M0, M2 |

## 2. Floor (always enforced, no setup required)

Adapted from the constraint-driven-development skill. These hold from the first commit.

- No new suppression comments: `@ts-ignore`, `@ts-expect-error` without a reason, `eslint-disable`, `istanbul ignore`, `nosemgrep`, `gitleaks:allow`.
- No unimplemented stubs: `throw new Error("Not implemented")`, empty `catch {}`, a `TODO` standing where the implementation should be.
- No skipped or deleted tests without a reason in the commit message.
- No secrets in source: keys, tokens, connection strings, account ids, real hostnames. Placeholders only.
- No real person's health data, name, MRN, date of birth or free text anywhere in the repo. Fake names are obviously fake (`ZZTEST, Patient`).
- No `dangerouslySetInnerHTML` (or equivalent raw-HTML sink) on any extracted value. Extracted values are untrusted strings.
- No prohibited external claims in product copy: "HIPAA compliant", "HIPAA certified", accuracy percentages, customer counts, invented statistics or badges (brief §10; master-plan decision 15).
- `/build auto` is never used on the rules engine, RLS policies or the audit log.
- Production AI calls go only to Bedrock. OmniRoute and any other AI gateway are for developers' coding agents on developer machines only (ADR 0004).
- This file is not weakened to make a change pass.

## 3. Enforced checks

Scripts live in `scripts/checks/` (owned by the ci-checks agent) and are written at M0 and wired to CI at M1 (dev-alignment 0.10). Each script exits `0` pass, `1` fail, `2` skipped-with-reason, and prints exactly one line `PASS|FAIL|SKIP <name>: <detail>`. `run-all.mjs` runs them all, exits `1` if any failed, and `--fast` runs the edit-loop subset. Checks are diff-scoped where the script can be; the budget for the `--fast` set is a few seconds, for task end under 90 seconds, unlimited in CI.

In CI a `SKIP` from a check marked "must run in CI" is treated as a failure from the milestone named, because a skipped gate that looks green is worse than no gate.

| Check | Command | What it proves | Runs at | First wired | Must run in CI from |
| --- | --- | --- | --- | --- | --- |
| All | `node scripts/checks/run-all.mjs` | Orchestrates every row below | task end, CI, milestone gate | M1 | M1 |
| Fast subset | `node scripts/checks/run-all.mjs --fast` | `bedrock-only`, `prohibited-claims`, `canary-phi`, `secrets`, `legal-basis` (the greps; no database, no build) | edit loop | M1 | — |
| Bedrock only | `node scripts/checks/bedrock-only.mjs` | No AI client in `apps/`, `services/` or `packages/` points anywhere but the Bedrock runtime endpoint; no OpenAI, Anthropic-direct, OmniRoute or other gateway hostname, SDK or env var in the product path (I7) | edit loop, task end, CI | M1 | M1 |
| Prohibited claims | `node scripts/checks/prohibited-claims.mjs` | No prohibited claim string in `apps/web` source or bundle, API responses, or docs shipped to customers (Floor; 0.10) | edit loop, task end, CI | M1 | M1 |
| Canary PHI | `node scripts/checks/canary-phi.mjs` | The canary strings in `scripts/checks/canary-strings.json` (a unique synthetic name and MRN present in every golden packet) appear in no log output, test artefact, snapshot or build output in the repo. From M4 the same check runs against every log sink of the dev and test environments (I8) | edit loop, task end, CI | M1 | M1 |
| Web bundle hygiene | `node scripts/checks/web-bundle-hygiene.mjs` | The built `apps/web` bundle contains no database client, JWT, vendor key or AI SDK, and no `dangerouslySetInnerHTML` on extracted values; runs against source until a bundle exists (0.10) | task end, CI | M1 | M3 (first bundle) |
| Secrets | `node scripts/checks/secrets.mjs` | No key, token, connection string, AWS account id or real hostname in the diff or tree; reports rule and location, never the matched value (Floor) | edit loop, task end, CI | M1 | M1 |
| DB grants and RLS | `node scripts/checks/db-grants.mjs` | Runs `packages/db/sql/checks/rls-enumeration.sql` (every table with `facility_id` has `FORCE ROW LEVEL SECURITY` and at least one policy) and `packages/db/sql/checks/grants.sql` (app and worker roles lack `BYPASSRLS`; `UPDATE`/`DELETE` on `audit_log` fail) against `DATABASE_URL`; exits `2` "skipped" when `DATABASE_URL` is unset (I3, I4) | task end, CI | M1 | M1 (CI provides an ephemeral database) |
| Rule CI offline | `node scripts/checks/rules-ci-offline.mjs` | The rules-engine package and its tests import no network, Bedrock, Textract or AWS SDK module and read no clock; rule changes re-run only the engine (I9; 2.9) | task end, CI | M1 | M2 (engine exists) |
| Legal basis | `node scripts/checks/legal-basis.mjs` | Every rule example under `packages/schemas/examples/rules/` carries a non-empty `legal_basis`; from M2 also: a hard-stop or payer rule with `protected_input` and no `legal_reviewer` fails (I10; 2.8) | edit loop, task end, CI | M1 | M1 |

The ci-checks agent owns the scripts; this table owns their meaning. A script that passes while the row's "what it proves" is false is a bug in the script.

## 4. Enforced with numbers

Every number states its reason. A number without a command behind it yet is in section 9.

### 4.1 Provisional extraction gate (dev-alignment 0.7) — provisional until a founder overrules

Applies per hard-stop field, on the extraction evaluation set (a separate artefact from the 17-type case library), first gated at M5 and re-run nightly with a cost cap or on any model, prompt or OCR change.

| Metric | Threshold | Why this number |
| --- | --- | --- |
| Recall per hard-stop field | ≥ 0.98 | A missed hard-stop positive is the false-Admit path; with ≤ 50 positives this means zero misses, which is the intent |
| Lower 95% confidence bound on that recall | ≥ 0.90 | Stops a small, lucky sample passing; the bound is what the number means on real packets |
| Invented-value rate | 0 | An invented value is a fabricated fact with a quote attached; one is a pilot-stop event |
| Unknown → No rate | 0 | Invariant I1: silence is Unknown, never No |
| Positive fixtures per field | ≥ 30 | At 30 positives with zero misses the exact one-sided 95% lower bound is 0.905, so the recall and bound rows can both be met; at 25 it is 0.887 and the gate could never pass (ruling R4, 2026-10-22; applied 2026-10-29) |
| Near-miss negative fixtures per field | ≥ 30 | "Vent-dependent in ICU, weaned before discharge", "trach, decannulated": the cases that produce a false positive hard stop and a wrongful Do Not Admit |

Method decision (engineering, until QA or the founder overrules): the confidence bound is the exact (Clopper-Pearson) one-sided 95% lower bound. Arithmetic: with zero misses the bound is 0.887 at 25 positives, 0.902 at 29 and 0.905 at 30; with one miss it needs 46 positives (0.901). The floor was raised from 25 to 30 rather than the bound lowered to 0.88 (R4), so the gate is reachable at the floor with zero misses and the bound keeps its meaning. QA authors to 30 per field; the extraction-evaluation set is a separate artefact from the case library (SPEC §15).

Gate commands arrive with the eval harness (M4/M5, owned by Team B/QA) and are added to section 3 then.

### 4.2 Other numbers already decided

| Rule | Number | Why | Checked by | First wired |
| --- | --- | --- | --- | --- |
| Signed-URL TTL | ≤ 5 min | Long enough to open a page image, short enough that a leaked URL is dead before it is shared | Terraform policy test and API test | M3 |
| Idle session timeout | 15 min | Shared SNF workstations | Front-end and Cognito config test | M3 |
| Exception lifetime | ≤ 90 days | Long enough to plan the fix, short enough to remember | Review of section 7 at every milestone gate | M0 |
| Rule test coverage | every rule id has a True, a False and an Unknown case | Three-valued logic makes "Unknown treated as No" a structural property only if every rule is tested on Unknown | Rule coverage gate in rule CI | M2 (seeds), M7 (all rules) |
| Bedrock model id | pinned, exact version string, never an alias | Model drift changes extractions silently; the pinned id is part of I6 | `bedrock-only.mjs` (alias rejection) | M1 |

## 5. Data policy (dev-alignment 0.11)

1. Development, test and CI data is **synthetic only**. "Synthetic or de-identified" is withdrawn: scanned packets cannot be reliably Safe-Harbor de-identified.
2. Real referral packets, including de-identified ones (the P1 replay set and QA's ≥ 20 packets), are handled **solely in the BAA-covered evaluation environment**: never on a developer machine, never in CI, never in a fixture, never on any host that OmniRoute or another coding-agent gateway can reach. The evaluation harness exports per-field confusion matrices without PHI so results can leave that environment; packets never do.
3. Every synthetic packet carries the canary name and MRN from `scripts/checks/canary-strings.json`, so any leak into a log, snapshot or bundle is detectable. Fake names are obviously fake (`ZZTEST, Patient`); synthetic MRNs, dates of birth and provider names follow the same convention.
4. No real credential, key, account id or hostname in the repo or in fixtures. Placeholders only (`<ACCOUNT_ID>`, `example.invalid`), matching `.claude/rules/data-policy.md`.
5. Logs carry a field allowlist of ids, never values. Bedrock invocation logging is off (verified by test at M4). Queue payloads carry ids and S3 keys, never document text.
6. Prompts request only schema fields. Fields flagged `specially_protected` (42 CFR Part 2, psychotherapy notes, state-protected categories) are handled per counsel; until counsel rules, they are display-only and route only to Needs Review.
7. The prototype incident is handled by the forensic runbook (dev-alignment 0.1); nothing from either prototype's database is imported here.

## 6. Measured, not yet enforced

No code exists at M0, so there are no values yet. Each row records the milestone at which the first value is taken; from then on the recorded value is a ratchet (tolerance 0.5%) that must not fall until a founder sets a target.

| Metric | Today | First measured | Direction |
| --- | --- | --- | --- |
| Changed-line test coverage | — | M1 | hold at ≥ 80% once the first suite exists (default from the skill; forces a test, allows a config line) |
| Project test coverage | — | M1 | must not fall |
| Processing time, 150-page packet to ready-for-review | — | M4 | report weekly; target 5 min becomes a gate only when the founders set the turnaround requirement (4.7) |
| Cost per packet (Bedrock + Textract), by model tier | — | M0 spike, M4 | must not rise without a recorded reason |
| Prompt-cache read tokens per Bedrock call | — | M4 | non-zero from the first call (4.4) |
| Needs Review rate on the golden library | — | M2 (seeds), P0 | report; the founders decide the ceiling |
| Quote-verification pass rate on correct facts / false-pass rate on fabricated quotes | — | M5 | first up, second down |
| Web bundle size (main) | — | M3 | must not grow without a reason |

## 7. Exceptions

None. An exception needs an id, the rule it suspends, the exact path, a reason, an owner and an expiry no more than 90 days out, and is added only through a `constraints-change` PR (section 0).

| ID | Rule | Path | Reason | Owner | Expires |
| --- | --- | --- | --- | --- | --- |
| — | — | — | — | — | — |

## 8. Guarding the bar

At review time, the reviewer (human or `/constraints guard`) compares the diff for the five moves that lower a bar quietly: a threshold moved, a test got easier, a checker got silenced, work left unfinished, an exception appeared. Tightening is silent; loosening is loud. At least one check in section 3 is external to the project's own tests (gitleaks, osv-scanner and Semgrep arrive at M1; until then `secrets.mjs` and `db-grants.mjs` are the outside opinions, since they read the tree and the database, not the suite).

## 9. Not constrained yet

Written down so nobody mistakes absence for permission. Each arrives with the milestone named and is added to section 3 or 4 when its command exists.

| Area | What arrives | Milestone |
| --- | --- | --- |
| Types and lint | `tsc --noEmit` and the shared lint config in the edit loop, zero errors | M1 |
| Secrets, SAST, dependencies | `gitleaks detect --redact --no-banner`, `semgrep scan --config p/default --config p/owasp-top-ten`, `osv-scanner scan source -r .`; nothing at high or above | M1 (CI) |
| Cross-facility suite | zero rows and zero files as every role, the worker role, and the database role directly; seed 2 orgs × 2 facilities × 3 roles; allow-list test for the Viewer rollup path | M1 |
| Audit chain | tamper test, per-facility chains, daily anchoring, verifier job, restore drill re-verifies the chain | M1, M8 |
| Infrastructure guardrails | SCP limited to HIPAA-eligible services, AI services opt-out, Bedrock pinned to US regions with invocation logging off, VPC endpoints and egress allowlist, block-public-access and KMS on every bucket, no patient data in Cognito templates, budgets alarms; checked by Terraform policy tests | M1 (written), M4 (verified by test) |
| Audited provisioning path | organisations and first Admins created only through an internal admin role whose every action writes an audit row | M1 |
| Engine property tests | generative over random facts × random rule sets; replay, derived critical set, hard-stop flip, toggle diff; outcome order as a table test | M2 |
| Protected-input approval logic | rule CI rejects a hard-stop or payer rule reading a protected input without `legal_reviewer`; criminal/background extraction behind a flag that reads "off until counsel determines the pilot state's rule" | M2 |
| Intake hardening | upload size and count caps, magic-byte checks, malware scan hand-off, sandboxed parsers scoped to one prefix, rate limits, `Cache-Control: no-store` on PHI responses, minimum-necessary response shaping per role | M3 |
| Every §19 state reachable by a test flag; product events emitted | M3 |
| Accessibility and web performance | axe (zero critical or serious) and Lighthouse (LCP ≤ 2500 ms, CLS ≤ 0.1) need a running URL; added when a preview URL exists | M3 |
| Pipeline robustness | transactional per-stage writes, fault-injection hooks, idempotency and watchdog tests, temperature 0 with seeds, signed-URL IDOR tests, egress test, invocation-logging-off test, canary-PHI test against real log sinks | M4 |
| Extraction evaluation | 3×3 confusion matrix per field, N-run agreement, differential prompt-injection suite, adversarial fixtures (planted negatives, invisible text, XSS strings), quote-normalisation spec and its two metrics, nightly golden run with cost cap, per-page identity check | M5 |
| Decision hardening | DB-enforced second Admin co-sign on the screen, read-event audit at the fixed granularity, deletion drill across S3 versions, backups, DLQ and OCR text, aggregate-only pilot CSV | M6 |
| External penetration test on staging with synthetic data; retest | M6 exit, M8 |
| Rule coverage gate and founder sign-off per rule version; rule-version diff over replayed snapshots; all section 3 checks green on real rules | M7 |
| §15 standard → test matrix with evidence links as the pre-PHI checklist; 300-page load test; incident-response tabletop; compliance sign-off | M8 |

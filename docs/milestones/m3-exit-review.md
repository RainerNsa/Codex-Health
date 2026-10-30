# M3 exit review — intake and screens

Date: 2026-10-30. Scope: dev-alignment §M3 (items 3.1–3.6) and the team plans' M3 row. Everything below was built
and tested locally on synthetic data only; nothing is deployed (F5).

## Verdict

M3 engineering is complete for everything that does not depend on the M4 pipeline, cloud sign-in or a founder
ruling. The exit test in the plan, "a non-developer completes create → upload → status unaided", has not been run:
it needs one person who is not a developer and about fifteen minutes (see "Exit test" below).

## Delivered (PRs #23–#30)

| Slice | PR | What a user can do |
| --- | --- | --- |
| Facility settings | #23 | Admins version the facility profile and switch review and favorable rules on or off; hard stops and payer rules stay locked (F9); a completeness checklist shows unset settings |
| Review screens | #24 | Submit, hold, request information, escalate, resume, decide with an override reason and the confirmation checklist; every status move is a checked, audited database row |
| Second-Admin co-sign | #25 | An Admit after any hard stop, or any decision after a flipped hard-stop fact, is filed by one person and co-signed by a different Admin |
| Amendments | #26 | Admins amend a decision with a reason; earlier decisions never change; the same co-sign rules apply; no reopening |
| Document intake | #27 | Upload PDF or image files (25 MB, 20 per referral) on a signed link into quarantine; the API checks the bytes before they count; replace or set aside failed documents |
| Referral queue | #28 | A facility's referrals by status, codes and counts only, paged, audited |
| Review time | #29 | Active review time per person and referral, for the pilot measures |
| Navigation and placeholders | #30 | Referrals and Facility settings, plus five M6 placeholder screens |

Beyond the plan: the co-sign flow, amendments, the referral queue and database-enforced status transitions were
not M3 items; they were built because the review screens needed them to be safe.

Every slice had independent security and test reviews before merge (except #30, web only). They found real
issues, each fixed and tested before the slice stood, among them: an Admin admitting over a hard stop alone by
toggling a setting (#25), temporary tables shadowing the database's own checks (#24), unchecked bytes promoted by
swapping an upload after its check (#27), and an amendment passing with an unknown fact by switching a rule off
and back (#26).

## Against the plan

| Item | Status |
| --- | --- |
| 3.1 Screens | New referral, upload, processing status, recommendation, decision, facility settings with checklist: **done**. Extracted-information review: **manual facts only** (AI facts arrive with M4). Login/reset and facility selection: **not built**: the local sign-in stand-in remains until Cognito, which needs a cloud account. Dashboard, history, audit trail, criteria versions, users: **placeholders, as planned** |
| 3.2 Every §19 state reachable by a test flag | **Not met.** The §19 notes never arrived (operations blocker 3). States exist per screen; a test-flag harness waits for a written state list |
| 3.3 Product events | Corrections, overrides, per-stage timestamps, per-user review time: **done**. Evidence views and AI fact confirmations: **M4** (no AI facts yet) |
| 3.4 Asynchronous processing, notifications, partial results, 200+ page packets | **Moves to M4**: it is the pipeline. Intake already accepts the documents and holds the referral in processing |
| 3.5 Hardening | Upload caps, magic-byte checks, quarantine, `no-store`, per-role response shaping: **done**. Upload rate limit: **done, in-process** (shortcut). Malware scanning: **not built, a gate before any real data**. Sandboxed parsers: **M4**. Login/reset rate limits and the 15-minute idle timeout: **with real sign-in**. Viewer aggregates: **waits on founder item 8** |
| 3.6 Mark a document not applicable with a reason | **Done** (#27) |

## Recorded shortcuts (each marked `shortcut:` in the code)

- Identity from a request header, development and test only (`apps/api/src/auth.ts`); replaced by Cognito.
- A settings save committing in the moment before a decision is not seen by that decision; close before pilot.
- The upload rate limit is per process; a shared limit once the API runs as more than one process.
- The referral date is today in UTC until referrals carry a received date.
- The settings audit row names the actor and action, not the version.
- Engine: enum, date and text values read as unknown in rule presence (pre-existing, M2).

## Open for the founder

1. **Referral types in the MVP** (item 11): the column exists and defaults to skilled.
2. **Second approver at a one-Admin facility**: an Admin's own co-sign filing needs a different Admin.
3. **Viewer patient-level reads** (item 8): Viewers see nothing patient-level today.
4. **Clinicians (F6)**: the criteria workshop and the usability sessions.
5. **Funding (F5)**: M4's document reading (Textract) and extraction (Bedrock) need AWS spend.

## Exit test

One person who is not a developer, the local build (`docs/local-development.md`), synthetic files only: create a
referral, upload two synthetic PDFs, submit for processing, find the referral in the queue and read its status,
without help. Record pass or fail and anything they got stuck on in the decision log. A pass closes M3.

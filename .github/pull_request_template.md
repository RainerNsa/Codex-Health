## What and why

<!-- One or two sentences. Link the task, ADR or decision-log entry if there is one. -->

## CONSTRAINTS checklist

Every box is ticked or explained. `npm run check` and `npm test` are green locally.

- [ ] **Synthetic data only.** No real patient data, de-identified or otherwise, in code, fixtures, tests, prompts, logs or screenshots. Fake names are obviously fake (`ZZTEST, Patient`); golden packets carry the canary identifiers.
- [ ] **No new AI endpoint.** Product AI calls go only to AWS Bedrock (`@aws-sdk/client-bedrock-runtime`, pinned model id). No other client, gateway, proxy or env var; OmniRoute stays on developer machines.
- [ ] **RLS on every new tenant table.** Any new table with `facility_id` has `ENABLE` and `FORCE ROW LEVEL SECURITY` with policies, and the app role has no `BYPASSRLS`.
- [ ] **Audit rows for every new write path.** Every new mutation of referral, fact, evaluation, decision or override data appends an audit row (ids and hashes, never PHI).
- [ ] **No PHI in logs, errors, URLs or metrics.** New log lines carry ids only.
- [ ] **No weakened checks.** No edits to `scripts/checks/`, thresholds or `CONSTRAINTS.md` to get to green; no new `@ts-ignore`, `eslint-disable`, `.skip` or `.only`. (A deliberate constraints change carries the `constraints-change` label and a security-lead review.)
- [ ] **No credentials, account ids or hostnames.** Placeholders only.
- [ ] **Tests reviewed as code.** A bug fix includes a reproduction test that failed on `main` (failing run linked); no test deleted or skipped without a reason here; expectations changed only where the description says why.
- [ ] **Database change is reversible.** Any migration is expand-only (no `DROP`/`RENAME` of anything still read by the previous release) and names its rollback path in its header, or carries the `constraints-change` label as irreversible (ADR 0006).

## `shortcut:` comments added in this PR

<!-- List each one as `path:line  shortcut: <the limit>, <when to upgrade>`, or write "none". -->

- none

## Reviewer notes

<!-- Touches a PHI path, packages/db, packages/rules-engine or audit code? Attach security-auditor and test-engineer findings. -->

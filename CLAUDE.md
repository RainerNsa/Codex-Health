# Codex Health: operating rules for coding agents

Codex Health is AI-assisted admissions decision support for skilled nursing facilities.
The AI reads the referral packet into source-linked Yes/No/Unknown facts; the facility's own
deterministic rules make the call (Admit / Needs Review / Do Not Admit); staff decide; every
decision lands in an append-only hash-chained audit log.

## Read first, in this order

1. `CONSTRAINTS.md`: the rules every change is checked against. Never weaken it. A check that
   fails is fixed in the code, never in the check. If a task conflicts with it, stop and report.
2. `SPEC.md`: rules DSL, extraction schema, data model, outcome resolution order.
3. `README.md`: where things live (the layout tree there is the map of this repo).
4. `.claude/rules/`: short always-on rules (`constraints-first.md`, `data-policy.md`).

Milestone now: **M5** (`docs/milestones/m5-plan.md`). M0, M1 and M2 closed 2026-10-29 and M3 is engineering complete (`../ops/decision-log.md`; the infra half is Terraform validated, never applied). M4 (`docs/milestones/m4-plan.md`) is built except slice 6; that slice and M5's real eval runs need AWS, paused by the founder since 2026-10-30. Resolver, RLS, audit and override changes still get `doubt-driven-development` and fresh-context reviews; `/build auto` is never used on them.

## Non-negotiables

- **Synthetic data only.** No real patient data, ever, in this repo, in tests, in fixtures, in
  prompts, in logs, in chat with an agent. Fake names must be obviously fake (`ZZTEST, Patient`).
  Real de-identified packets exist only in the BAA-covered evaluation environment, never here.
- **Bedrock only in product code.** The product's AI calls go to AWS Bedrock with a pinned model
  id, under the AWS BAA. No other AI endpoint, gateway or proxy appears in any `@codex-health` package,
  env var or config. OmniRoute is for developers' coding agents only (`docs/tooling/omniroute-dev-only.md`).
- **Unknown never becomes No or Admit.** Three-valued (Kleene) logic throughout.
- **RLS on every tenant table**, `FORCE ROW LEVEL SECURITY`, app role without `BYPASSRLS`.
- **Audit rows are append-only**, hash-chained per facility, carrying ids and hashes, never PHI.
- No PHI in logs, error messages, URLs, metrics or test output.

## The milestone process (agent-skills)

Every milestone runs `/spec` → `/constraints` → `/plan` → `/build` → `/test` → `/review` → `/ship`.

- Founder decisions are extracted with `interview-me`, then recorded in `../ops/decision-log.md`
  (and an ADR in `docs/adr/` when the decision shapes architecture). Do not guess a founder decision:
  write a placeholder and list it as an open question.
- `doubt-driven-development` is **required** on: the outcome resolver, Kleene logic, RLS policies,
  the audit hash chain, override handling. Fresh-context adversarial review before the change stands.
- `test-driven-development` on the rules engine and the pipeline. Rule CI never calls Bedrock or
  Textract. A bug fix starts with a reproduction test that is shown failing on `main` before the
  fix; link the failing run in the PR. Test changes are reviewed as application code (ADR 0006).
- The `security-auditor` and `test-engineer` personas (from the agent-skills plugin) review **any** change that
  touches a PHI path, `packages/db`, `packages/rules-engine` or audit code. Attach their findings
  to the PR.
- **`/build auto` is never used** on `packages/rules-engine`, `packages/db` RLS/policies/migrations,
  or audit code. Those tasks are built one slice at a time with human sign-off between slices.
- Skill-to-milestone map: `docs/tooling/agent-skills.md`.

## Coding style (ponytail, level `full`)

Ponytail is always on at level `full` (`AGENTS.md` carries the compact ruleset). The smallest complete
change; reuse before adding; stdlib first; no speculative abstraction; one small test for anything with
logic; finish every caller, fixture and test the change touches.

- **`CONSTRAINTS.md` wins any conflict with ponytail.** The audit chain, RLS, verbatim quote checks,
  version stamps and override reasons are required, not extras to cut.
- `shortcut:` comments are the debt marker: `shortcut: <the limit>, <when to upgrade>`.
  `/ponytail-debt` runs before each pilot gate and every shortcut is paid off or accepted on record.
- `/ponytail-review` on each diff before `/review`.
- ES modules everywhere. Node built-ins (`node:test`, `node:fs`) over dependencies in scripts.
- Never add a dependency for a few lines. Never add a dependency to `packages/rules-engine`
  (pure, deterministic, no I/O).

## Commands

| When | Run |
|---|---|
| In the edit loop | `npm run check:fast` |
| Before handing work back | `npm run check` and `npm test` |
| Lint / types | `npm run lint`, `npm run typecheck` |
| Local services | `npm run dev:up` / `npm run dev:down` (Docker) |

A red check is fixed in the code. Do not edit `scripts/checks/`, thresholds, or `CONSTRAINTS.md`
to make a check pass. Do not add `@ts-ignore`, `eslint-disable`, `.skip` or `.only` to get to green.

Do not run `npm install` to "fix" a problem; name the dependency change in your reply instead.

## Where things live

See the layout tree in `README.md`. Short version: `apps/web` (React UI), `apps/api` (HTTP API),
`services/worker` (document pipeline), `packages/rules-engine`, `packages/schemas`, `packages/db`,
`packages/shared`, `infra/terraform`, `scripts/checks`, `docs/` (ADRs, tooling, local development),
`.claude/` (skills, agents, commands, settings). Research and the decision log: `../research`, `../ops`.

## Agents must never

- Enter, paste, fetch or generate anything resembling real PHI anywhere (code, fixtures, prompts,
  chat, logs, screenshots).
- Publish or write accuracy, compliance or customer claims ("HIPAA compliant", accuracy
  percentages, customer counts) in UI copy, docs or README. CI greps for them.
- Change a rule's logic, a hard-stop field, a protected-input default or the outcome order without
  a founder decision recorded in `../ops/decision-log.md`.
- Create, modify or destroy cloud resources (`terraform apply`, `aws` CLI writes, console).
  Terraform is written and planned here; applies are a human action.
- Point any product package or env var at a non-Bedrock AI endpoint.
- Weaken a check, a threshold, a test or `CONSTRAINTS.md` to get to green.
- Commit `.env` files, keys, account ids or real hostnames. Placeholders only.

End every reply with one or two lines: what you skipped or did not check, and any risk the reader
must know.

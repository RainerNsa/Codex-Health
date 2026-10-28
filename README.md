# Codex Health

AI-assisted admissions decision support for skilled nursing facilities.
**The AI reads the packet; the facility's criteria make the call; staff decide.**

This is the product monorepo. Research, plans, sector reviews and the decision log live one level up in
`../ops` and `../research`. The build brief is `../research/brief/`.

## Status

M1 (skeleton, tenancy, data model). M0 closed 2026-10-29. No product logic exists yet. Nothing here has touched real patient data,
and nothing here may: see `CONSTRAINTS.md` (synthetic data only, Bedrock-only AI calls, RLS on every tenant table).

## Layout

```
code/
├── CONSTRAINTS.md        the rules every change is checked against; CI enforces them
├── SPEC.md               core spec (rules DSL, extraction schema, data model, outcome order) — written with /spec
├── CLAUDE.md / AGENTS.md agent operating rules for this repo (agent-skills process, ponytail at `full`)
├── apps/
│   ├── web/              React + TypeScript reviewer UI
│   └── api/              HTTP API (facility-scoped, RLS-backed)
├── services/worker/      document pipeline workers (OCR, extract, verify) — never public
├── packages/
│   ├── rules-engine/     pure deterministic engine + CLI; three-valued logic; no I/O
│   ├── schemas/          extraction facts, facility profile, rule record (JSON Schema, versioned)
│   ├── db/               migrations, roles, RLS policies, audit-log triggers
│   └── shared/           types and small utilities shared across packages
├── infra/terraform/      AWS account guardrails and environments (dev, test; prod gated until M7)
├── scripts/checks/       automatable CONSTRAINTS checks, run locally and in CI
├── docs/                 ADRs, local development, tooling, subprocessor register
└── .claude/              skills, agents, commands (agent-skills + ponytail), project settings
```

## Getting started

See `docs/local-development.md`. Short version: Node 24+, Docker, `npm install`, `npm run dev:up`, `npm run check`.

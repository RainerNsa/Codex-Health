# @codex-health/rules-engine

Pure, deterministic, no I/O, no network, no clock, no runtime dependencies (CONSTRAINTS I9; SPEC §10).

## Status (M2 slice 1)

- `parseExpression` / `lintRule`: the SPEC §10.1 grammar and the rule-CI static checks.
- `evaluate()`: every enabled rule to a tri-state under Kleene logic, then the fixed §4 order; emits the merged,
  clinical and financial results, sub-reasons, a trace of keys/codes/tri-states, missing and conflicting keys,
  the ranked blocking list and empty profile keys.
- `runRuleTests`: each rule's own True/False/Unknown cases.
- `src/cli.ts`: `evaluate <facts.json> <profile.json> <rules.json> --referral-date YYYY-MM-DD` and `rules test <dir>`.

Rule CI runs only this package (dev-alignment 2.9): it never calls Bedrock or Textract.

## Scripts

`npm test` (vitest: table tests of §4, typed conditions, fast-check properties for I1/I6, the example rules through the CLI),
`npm run typecheck`, `npm run lint`.

# @codex-health/rules-engine

Pure, deterministic, no I/O, no network, no dependencies at runtime.

## Status (M0)

Only the decided types and `OUTCOME_RESOLUTION_ORDER` exist (`src/index.ts`).
**`evaluate()` is not implemented.** It is written with `/spec` at M2, after `SPEC.md §rules`
fixes the DSL, the Kleene semantics and the trace format. `src/cli.ts` prints usage and exits 2
until then.

Rule CI runs only this package (dev-alignment 2.9): it never calls Bedrock or Textract.

## Scripts

`npm test` (vitest; includes one fast-check smoke property), `npm run typecheck`, `npm run lint`.

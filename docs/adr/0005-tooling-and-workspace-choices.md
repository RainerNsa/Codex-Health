# ADR 0005: Tooling and workspace choices

Status: accepted (M0). Owner: DevOps / monorepo. Date: 2026-10-22.

## Context

npm workspaces monorepo (`packages/*`, `apps/*`, `services/*`), Node 24+, ES modules, ponytail at
level `full` (smallest complete change, stdlib first). The root `package.json` carries scripts only;
every workspace exposes `lint`, `typecheck`, `test`, `build` as applicable (`--if-present`).

## Decisions (one line each)

| Choice | Why |
|---|---|
| TypeScript ^5.8, `strict`, ES2022, `NodeNext` | Node 24+ runs `.ts` directly (type stripping), so no tsx/ts-node; `erasableSyntaxOnly` guards that, `rewriteRelativeImportExtensions` lets source import `./x.ts` and still emit `./x.js`. |
| `apps/web` overrides to `moduleResolution: bundler` | Vite resolves; `allowImportingTsExtensions` + `noEmit` there. |
| vitest ^3 for `rules-engine` and `api` | Fast, TS-native, `fastify.inject` works without a server; property tests need a real runner. |
| `node:test` for `schemas`, `shared`, `worker` | Stdlib first: those tests are a handful of assertions and need no framework. |
| fast-check ^3 as devDependency of `rules-engine` only | Property tests ("no Admit on unknown") are the M2 exit test; no other package needs it. No runtime deps in rules-engine, ever. |
| ESLint 9 flat config, `typescript-eslint` recommended, nothing else | Catches the obvious; style is prettier's job. Workspaces pass `--config ../../eslint.config.js` so lookup is explicit. |
| Prettier defaults (`.prettierrc` is `{}`) | Nothing to argue about. |
| Vite ^6 + React 19 + Tailwind ^3.4 (postcss config) | Tailwind 4 changes config shape; 3.4 is the known path and trivial to migrate later. |
| Fastify 5, security headers set by hand in one `onSend` hook | JSON-only API; seven headers do not justify `@fastify/helmet`. `Cache-Control: no-store` on every response (PHI never cached). Binds 127.0.0.1 only. |
| `services/worker` is plain Node; `@aws-sdk/client-sqs` declared but not imported | Keeps the Bedrock-only / rules-CI-offline checks trivial until the pipeline lands at M3. |
| `packages/shared` and `packages/rules-engine` export TypeScript source via `exports` | No build step for internal packages at M0; Node and vitest load `.ts` from the workspace symlink's real path. Revisit (project references or `dist`) when a consumer needs `tsc` emit. |
| Repo-wide tooling (`eslint`, `typescript-eslint`, `prettier`) lives in `packages/shared` devDependencies | The root `package.json` has no devDependencies and is not ours to edit; npm hoists them to the root `node_modules`, where the root `eslint.config.js` resolves them. Move to root when the root file is opened. |
| Versions pinned as caret ranges on known majors | Reproducibility comes from the lockfile written by the one `npm install` in the verify stage. |
| JSON Schema draft 2020-12, validated with ajv (`ajv/dist/2020.js`) in tests only | Schemas are data (dev-alignment 0.2); no format plugin, dates use a pattern. |

## Consequences

- `npm run test` at root runs vitest in two workspaces and `node --test` in three; both read the
  same `tsconfig.base.json`.
- Nothing here is production-ready and nothing has run against `npm install` yet (verify stage).
- `rules-engine` has no `evaluate()`: it is written with `/spec` at M2.

## Open questions (founders / COO)

See the structured output of the M0 DevOps run; the ones that touch tooling: whether to open the
root `package.json` for devDependencies, and whether Tailwind 4 is wanted before any real screen.

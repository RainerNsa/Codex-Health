# ADR 0006: Release pipeline shape

Status: proposed (M0), to be accepted by the technical founder before the first deployable build at M1.
Owner: DevOps / platform. Date: 2026-10-22.

## Context

CI exists (`.github/workflows/ci.yml`) but nothing is deployable yet and no environment exists. The shape of
the path from a merged change to a running task has not been written down, and the two founders have not
agreed how production is updated or rolled back. These are the defaults the DevOps sector adopts now so the
M1 and M4 work builds toward one target. They follow the ordinary CI/CD discipline: merge small changes
often, run every check on every integration, block promotion when a required check fails, deploy the same
package you tested, update production gradually, watch errors and restore a working version when needed.

## Decisions (one line each)

| Decision | Why |
|---|---|
| Every PR runs the full CI workflow; all four jobs are required checks in branch protection on `main`; no admin bypass. | A failed job blocks promotion. The checks are the only outside opinion on an agent-written change. |
| One artefact per merge to `main`: each deployable workspace (`apps/api`, `services/worker`, `apps/web`) is built once into an image tagged with the git SHA and recorded by digest. Environments are updated by digest, never by rebuilding. | Same bytes in dev, test and production. A rebuild can pull a different dependency or base layer than the one that passed. |
| Continuous delivery, not continuous deployment: `test` updates automatically on a green `main`; production updates on an approval recorded in GitHub by a person who did not author the change (two people from M7, when production exists). | A facility pilot with real packets needs a named human on every production change; the approval is the change record. |
| Production updates gradually: ECS rolling deployment with the deployment circuit breaker on and automatic rollback to the previous task definition; a minimum of two tasks per service in production so a rollout never replaces every instance at once. | A bad release reaches part of the fleet and rolls back on its own health checks before anyone has to act. |
| The previous image digest and task definition are retained for every service and restorable in one command, documented in the runbook before M7. | "Restore a working version" has to be a known command, not a rebuild under pressure. |
| Promotion watches errors, latency and health: an alarm on 5xx rate, p95 latency and task health gates the next step of a rollout and triggers rollback. The same alarms page the on-call person. | Observe and recover, with the same signal for both. |
| Database changes are expand/contract. A migration never drops or renames a column, table or enum value in the same release as the code that stops using it; the contract step ships one release later. Every migration states its rollback path in its header, or states that it is irreversible and why, and an irreversible migration needs the `constraints-change` label. | The app can be rolled back without rolling the database back. "Can this database change be reversed?" is answered in the PR, not after the incident. |
| Staging replay uses synthetic golden packets only; no real request is ever replayed outside the BAA-covered evaluation environment (CONSTRAINTS I8, ADR 0003). | The usual "replay a real request in staging" is not available to this product. |
| Agent-written changes keep every existing regression test required. A bug fix starts with a reproduction test shown failing against `main` (the failing run is linked in the PR). Changes to tests are reviewed as application code, and a PR that deletes or skips a test says why in its description. | An agent can write code and tests that share one wrong assumption; the failing-first run and the human read of the test diff are what catch it. |

## Consequences

- M1 adds: a `build` job producing SHA-tagged images (no push until an ECR exists), the expand/contract rule in
  the migration template header, and the test-change rule in the PR template (done now, below).
- M4 adds: the test-environment deploy on green `main`, the alarms, and the one-command restore in the runbook.
- M7 adds: production approval by two people, the circuit breaker, the retained-release drill.
- `CONSTRAINTS.md` §9 lists "migrations are expand/contract" as not yet enforced; moving it into the Floor is a
  `constraints-change` PR for Team B at M1 together with a check that greps migrations for `DROP` and `RENAME`
  without a `-- contract-of:` header.

## Not decided here

Whether production runs more than one region, blue/green instead of rolling, and the exact alarm thresholds.
Those wait for the first measured pilot load (M8 300-page load test).

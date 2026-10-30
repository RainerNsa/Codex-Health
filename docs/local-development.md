# Local development

Everything here runs on your machine against Docker containers with synthetic data. Nothing touches AWS.

## Prerequisites

- Node 24 or newer (`.nvmrc` says 24; `node --version`)
- Docker Desktop, running (`docker info` must succeed)
- `npm install` once at the repo root (installs every workspace, including `pg` for `packages/db`)

No AWS credentials, no `aws` CLI, no Terraform are needed for local work.

## Start

```sh
scripts/dev/up.sh
```

This does, in order:

1. Copies `.env.example` to `.env` if you have none. `.env` is git-ignored.
2. `docker compose up -d`: Postgres 16 on `127.0.0.1:5432` and LocalStack (S3 + SQS) on `127.0.0.1:4566`.
   Both ports bind to loopback only. On first start Postgres runs `packages/db/sql/init/` (roles
   `codex_migrator`, `codex_app`, `codex_worker`; database `codex_health`) and LocalStack runs
   `scripts/dev/localstack-init/` (bucket `codex-health-documents-local`, queues `codex-healthcessing` and
   `codex-healthcessing-dlq`).
3. Waits until both containers report healthy.
4. Runs the migrations: `npm run migrate -w @codex-health/db` (applies `packages/db/migrations/*.sql` in order,
   one transaction each, recorded in `schema_migrations`).

Then, as you need them:

```sh
node scripts/dev/seed-synthetic.mjs   # 2 orgs x 2 facilities x 3 users, all named ZZTEST; idempotent
npm run check -w @codex-health/db        # the two CONSTRAINTS SQL checks; prints "db checks: all pass"
npm test -w @codex-health/db             # migration-runner unit test + cross-facility/audit tests
npm run dev:down                      # stop containers, keep data
```

With the API running, `npm run test:e2e -w @codex-health/web` opens every screen in light and dark, at desktop and phone
width: it checks accessibility and sideways scroll, and leaves screenshots in `apps/web/test-results/shots`. It adds ZZTEST
draft referrals to the local database. First run needs `npx playwright install chromium`. It does not run in CI yet.

`npm run dev:up` (root) is the bare `docker compose up -d` without the wait and migrate; use `scripts/dev/up.sh`.

## Synthetic only: what it means in practice

- Never load a real referral packet, PDF, screenshot, note, name, MRN or date of birth into the local
  stack, a fixture, a test, a prompt or a chat. Not "de-identified", not "just one page". Real
  de-identified packets live only in the BAA-covered evaluation environment (dev-alignment row 0.11).
- Fake people are obviously fake: `ZZTEST, Patient`, `ZZTEST, Reviewer`, emails on `example.invalid`.
- `.env` holds only the placeholders from `.env.example`. No real key, account id, bucket or hostname,
  ever, even temporarily. `AWS_ACCESS_KEY_ID=test` is LocalStack's documented dummy value.
- Local services never call Bedrock, Textract, OpenAI or Anthropic. `BEDROCK_MODEL_ID` stays a placeholder.
- If you suspect real data reached a local machine, stop, do not delete anything, and tell the technical
  founder the same day (it is a potential reportable incident, see `../ops/COO-BRIEF.md` decision 1).

## The database roles

| Role | Used by | Can |
|---|---|---|
| `codex_migrator` | migrations, seed, db tests (`DATABASE_URL`) | own the schema; `SET ROLE` to the two roles below for tests |
| `codex_app` | the API (`DATABASE_URL_APP`) | read org/facility/user tables; read/insert referrals (drafts only; status moves through referral_transitions); read/insert documents (as uploaded, on an open referral; status to not_applicable only), user facts, verified evaluations, decisions, product events; insert audit rows. Every write is bound per transaction with `SET LOCAL app.facility_id` and `app.organization_id` |
| `codex_worker` | the pipeline (`DATABASE_URL_WORKER`) | read facilities, referrals, documents, facts, evaluations; move an in-flight referral to processing / partial_failure / ready_for_review; report document results; insert ai facts and evaluations; emit product events (no read); insert audit rows |

No role has `BYPASSRLS` or `SUPERUSER`. Every table with a `facility_id` column has
`FORCE ROW LEVEL SECURITY` and a policy on `app.facility_id`, so even the owner sees only the facility set
for the current transaction:

```sql
SELECT set_config('app.facility_id', '<facility uuid>', true);  -- transaction-local; unset means no rows
```

`audit_log` is append-only for the app and worker roles by grant (no UPDATE/DELETE/TRUNCATE) and by a
statement-level trigger that rejects UPDATE, DELETE and TRUNCATE for every role while it is enabled. The
owner (`codex_migrator`) has no grant to revoke and can disable or drop that trigger, so "append-only
for the owner" holds only as long as the trigger exists and is enabled; `grants.sql` returns a row when it
is missing or disabled, and the migrator role is used for migrations and the synthetic seed only.

## Running the checks

`npm run check -w @codex-health/db` runs every file in `packages/db/sql/checks/` and fails if any returns rows:

- `rls-enumeration.sql`: every table, partitioned table or materialized view with a `facility_id` column has
  RLS enabled, forced, and at least one policy; every policy on such a table references `app.facility_id`; and
  every table in `public` carries `facility_id` unless it is on the check's allowlist (`organizations`,
  `users`, `schema_migrations`).
- `grants.sql`: `codex_app` and `codex_worker` exist and are not superusers; every other non-superuser
  role (except `codex_migrator`, `pg_*`, `rds_*`) lacks `BYPASSRLS`, lacks CREATE on schema `public`, and
  holds no table- or column-level UPDATE and no DELETE/TRUNCATE on `audit_log`; and `audit_log` has an enabled
  statement-level trigger covering UPDATE, DELETE and TRUNCATE.

A red check is fixed in the migration, never in the check (`CONSTRAINTS.md`). The same queries run in CI
through `scripts/checks/db-grants.mjs`, which calls `packages/db/check.mjs` (or `psql -tA` when `pg` is not
installed) and fails on any returned row. `npm test -w @codex-health/db` additionally proves, inside a rolled-back transaction,
that a cross-facility read returns zero rows for both roles, that audit rows cannot be changed, and that both
checks are clean. Without `DATABASE_URL` the database suites skip and only the unit tests run; Docker must be up and `scripts/dev/up.sh` run once before `npm test` proves anything about RLS, the audit chain or the decision guards. In the CI `db-checks` job the suites fail instead of skipping (`REQUIRE_DATABASE`).

To add a migration: create `packages/db/migrations/0002_<name>.sql`, give every new tenant table a
`facility_id` column plus ENABLE/FORCE RLS and the `tenant_isolation` policy, grant only what each role
needs, and run `npm run migrate -w @codex-health/db` then `npm run check -w @codex-health/db`. Changes to
`packages/db` get `doubt-driven-development` and a `security-auditor` review (`CLAUDE.md`).

## Reset

```sh
scripts/dev/reset.sh     # asks you to type "reset", then docker compose down -v
scripts/dev/up.sh        # fresh roles, database, migrations
```

Reset deletes the Postgres volume and LocalStack state. Nothing of value lives there; it is all synthetic.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Docker daemon is not running` / `Cannot connect to the Docker daemon` | Docker Desktop not started | Start Docker Desktop, wait for the whale icon, rerun `scripts/dev/up.sh` |
| `Bind for 127.0.0.1:5432 failed: port is already allocated` | Another Postgres (Homebrew, another project) on 5432 | Stop it (`brew services stop postgresql@16`) or change the host port in `docker-compose.yml` and `DATABASE_URL*` in `.env` |
| Same for 4566 | Another LocalStack | Stop it, or change the host port and `AWS_ENDPOINT_URL`, `SQS_*_URL` |
| `services did not become healthy` | Slow first image pull, or a container crashed | `docker compose ps`, `docker compose logs postgres` / `logs localstack`; rerun `up.sh` |
| `role "codex_migrator" does not exist` / `database "codex_health" does not exist` | The init scripts run only on an empty volume; volume predates them | `scripts/dev/reset.sh` then `scripts/dev/up.sh` |
| `password authentication failed` | `.env` edited away from the local placeholders | Compare with `.env.example`; passwords are set in `packages/db/sql/init/001_roles_and_database.sql` |
| `migration 0001_init.sql failed: ...` | A migration was edited after being applied, or a half-applied manual change | Migrations are transactional, so the DB is unchanged; fix the SQL, or `reset.sh` if `schema_migrations` already lists it |
| `DATABASE_URL is not set` | Running a db script outside `up.sh` without the env loaded | `set -a; . ./.env; set +a` in your shell, or prefix the command with `DATABASE_URL=...` |
| `Cannot find package 'pg'` | `npm install` not run at the root | `npm install` at the repo root (never inside a package) |
| `npm run check` returns rows for a new table | New tenant table without FORCE RLS or a policy | Add them to the migration; do not edit the check |
| LocalStack bucket or queues missing | `ready.d` hook failed or the volume mount is wrong | `docker compose logs localstack`; `docker compose restart localstack` reruns the hook |

## Manual fact entry (M2): run the API and the web form

The first reviewer-facing screen runs entirely on your machine, against the local database, with a local
sign-in stub: a header carrying a seeded user id, accepted only when `CODEX_ENV` is `development` or `test`.
The API refuses to start the stub under any other value. Nothing here is deployable; Cognito replaces the stub
when a sandbox exists.

```sh
scripts/dev/up.sh                       # Postgres + LocalStack, migrations, synthetic seed
CODEX_ENV=development DATABASE_URL_APP=postgres://codex_app:app-local-only@127.0.0.1:5432/codex_health \
S3_DOCUMENTS_BUCKET=codex-health-documents-local AWS_ENDPOINT_URL=http://127.0.0.1:4566 \
AWS_REGION=us-east-1 AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test \
  npm run dev -w @codex-health/api      # API on 127.0.0.1:3000, as codex_app under RLS; uploads go to LocalStack
npm run dev -w @codex-health/web        # form on http://127.0.0.1:5173, proxies /api to the API
```

Pick "ZZTEST Reviewer", press **New referral**, enter facts with a note, and the recommendation re-evaluates
after each one. Or add synthetic PDF or image files under **Documents**: the browser uploads them straight to the
LocalStack bucket on a five-minute signed URL, and the API checks each file's hash, size and type before it counts.
**Submit for processing** then hands the referral to the pipeline, which arrives at M4: until then a processing
referral stays there. The LocalStack credentials are its fixed local placeholders, not secrets. The Viewer can open a referral but not change it. Every write and every read is audited.

#!/usr/bin/env bash
# Start the local stack (Postgres + LocalStack), wait until healthy, run migrations, print next steps.
set -euo pipefail
cd "$(dirname "$0")/../.."

if ! docker info >/dev/null 2>&1; then
  echo "Docker daemon is not running. Start Docker Desktop and retry." >&2
  exit 1
fi

if [ ! -f .env ]; then
  cp .env.example .env
  echo "created .env from .env.example (local placeholders only; never put real credentials or patient data in it)"
fi
set -a; . ./.env; set +a

docker compose up -d

echo -n "waiting for services to be healthy"
ready=0
for _ in $(seq 1 60); do
  statuses=$(docker inspect -f '{{.State.Health.Status}}' $(docker compose ps -q) 2>/dev/null || true)
  if [ -n "$statuses" ] && ! echo "$statuses" | grep -qv '^healthy$'; then ready=1; echo " ok"; break; fi
  echo -n "."; sleep 2
done
if [ "$ready" != "1" ]; then
  echo; echo "services did not become healthy; see: docker compose ps && docker compose logs" >&2
  exit 1
fi

npm run migrate -w @codex-health/db

cat <<'EOF'

Local stack is up.
  Postgres : 127.0.0.1:5432  database codex_health  (roles: codex_migrator, codex_app, codex_worker)
  LocalStack: 127.0.0.1:4566  bucket codex-health-documents-local, queues codex-healthcessing(-dlq)

Next steps:
  node scripts/dev/seed-synthetic.mjs   # 2 orgs x 2 facilities x 3 users, obviously fake
  npm run check -w @codex-health/db        # RLS enumeration + grants checks (must print "all pass")
  npm test -w @codex-health/db             # cross-facility and audit immutability tests
  scripts/dev/reset.sh                  # wipe everything and start over
Synthetic data only. Never load a real referral packet or any real patient data locally.
EOF

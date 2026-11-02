#!/usr/bin/env bash
# The whole product on this machine: scripts/dev/stack.sh [up|down|logs]. No cloud account. Synthetic data only.
set -euo pipefail
cd "$(dirname "$0")/../.."
compose() { docker compose -f docker-compose.yml -f docker-compose.stack.yml "$@"; }
case "${1:-up}" in
  up) compose up -d --build --wait --wait-timeout 180 postgres localstack api worker web; echo "Open http://127.0.0.1:5173" ;;
  down) compose down ;;
  logs) compose logs -f api worker ;;
  *) echo "usage: stack.sh [up|down|logs]" >&2; exit 2 ;;
esac

#!/usr/bin/env bash
# Stop the local stack and delete its volumes (database contents and LocalStack state). Asks first.
set -euo pipefail
cd "$(dirname "$0")/../.."

echo "This removes the local containers AND their data volumes (postgres data, localstack bucket/queues)."
read -r -p "Type 'reset' to continue: " answer
if [ "$answer" != "reset" ]; then
  echo "aborted"
  exit 1
fi

docker compose down -v --remove-orphans
echo "done. Run scripts/dev/up.sh to start fresh."

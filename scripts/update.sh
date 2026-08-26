#!/usr/bin/env bash
# Update Arihant MIS to the latest code.
#
#   ./scripts/update.sh
#
# Backs up first, then pulls, rebuilds and restarts. Database migrations run
# automatically on start via `prisma migrate deploy`, which only applies
# committed migrations and never drops or resets anything.
#
# The PostgreSQL volume is a named volume and is never touched here, so the
# financial data survives every update.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> 1/5  Backing up before changing anything"
./scripts/backup.sh

echo
echo "==> 2/5  Fetching the latest code"
git pull --ff-only

echo
echo "==> 3/5  Building the new image"
docker compose build app

echo
echo "==> 4/5  Restarting (migrations run automatically on start)"
docker compose up -d

echo
echo "==> 5/5  Waiting for the application to report healthy"
for i in $(seq 1 60); do
  if curl -fsS "http://localhost:${APP_PORT:-3000}/api/health" >/dev/null 2>&1; then
    echo "Healthy."
    curl -sS "http://localhost:${APP_PORT:-3000}/api/health"; echo
    echo
    echo "Update complete."
    exit 0
  fi
  sleep 2
done

echo
echo "ERROR: the application did not become healthy within 2 minutes." >&2
echo "Check the logs:  docker compose logs --tail=100 app" >&2
echo "The database was backed up in step 1 and has not been modified." >&2
exit 1

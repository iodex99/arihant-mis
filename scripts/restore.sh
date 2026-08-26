#!/usr/bin/env bash
# Restore the Arihant MIS database from a dump.
#
#   ./scripts/restore.sh backups/arihant-mis-20260826-101500.sql.gz
#
# This REPLACES the current database. It takes a safety dump first and asks for
# confirmation before doing anything destructive.
set -euo pipefail

cd "$(dirname "$0")/.."
[ -f .env ] && set -a && . ./.env && set +a

DUMP="${1:?Usage: ./scripts/restore.sh <dump.sql.gz>}"
DB_SERVICE="${DB_SERVICE:-postgres}"

[ -f "$DUMP" ] || { echo "ERROR: $DUMP does not exist." >&2; exit 1; }
gzip -t "$DUMP" || { echo "ERROR: $DUMP is not a valid gzip archive." >&2; exit 1; }

echo "About to restore:  $DUMP"
echo "Into database:     ${POSTGRES_DB:-arihant_mis}"
echo
echo "This will REPLACE all current data in that database."
read -r -p "Type the database name to confirm: " CONFIRM
if [ "$CONFIRM" != "${POSTGRES_DB:-arihant_mis}" ]; then
  echo "Cancelled. Nothing was changed."
  exit 1
fi

SAFETY="./backups/pre-restore-$(date +%Y%m%d-%H%M%S).sql.gz"
mkdir -p ./backups
echo "Taking a safety backup of the current database to $SAFETY ..."
docker compose exec -T "$DB_SERVICE" \
  pg_dump -U "${POSTGRES_USER:-arihant}" -d "${POSTGRES_DB:-arihant_mis}" --clean --if-exists \
  | gzip -9 > "$SAFETY"
echo "Safety backup written. If this restore goes wrong, restore that file."

echo "Stopping the application so nothing writes mid-restore ..."
docker compose stop app || true

echo "Restoring ..."
gunzip -c "$DUMP" | docker compose exec -T "$DB_SERVICE" \
  psql -U "${POSTGRES_USER:-arihant}" -d "${POSTGRES_DB:-arihant_mis}" -v ON_ERROR_STOP=1

echo "Bringing the application back up ..."
docker compose start app

echo "Restore complete. Check the dashboard, then confirm the figures reconcile."

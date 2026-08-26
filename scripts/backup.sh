#!/usr/bin/env bash
# Back up the Arihant MIS database and configuration.
#
#   ./scripts/backup.sh              # write a dump to $BACKUP_DIR
#   ./scripts/backup.sh /mnt/nas     # write it somewhere else
#
# Safe to run while the application is serving; pg_dump takes a consistent
# snapshot without locking writers.
set -euo pipefail

cd "$(dirname "$0")/.."
[ -f .env ] && set -a && . ./.env && set +a

BACKUP_DIR="${1:-${BACKUP_DIR:-./backups}}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
DB_SERVICE="${DB_SERVICE:-postgres}"
STAMP="$(date +%Y%m%d-%H%M%S)"

mkdir -p "$BACKUP_DIR"

DUMP="$BACKUP_DIR/arihant-mis-$STAMP.sql.gz"
echo "Backing up the database to $DUMP ..."

# -Fp + gzip keeps the dump readable and restorable with plain psql, which
# matters when the person restoring is not a Postgres specialist.
docker compose exec -T "$DB_SERVICE" \
  pg_dump -U "${POSTGRES_USER:-arihant}" -d "${POSTGRES_DB:-arihant_mis}" --clean --if-exists \
  | gzip -9 > "$DUMP"

if [ ! -s "$DUMP" ]; then
  echo "ERROR: the dump is empty. Nothing was backed up." >&2
  rm -f "$DUMP"
  exit 1
fi

# Verify the archive is intact before trusting it or pruning anything.
gzip -t "$DUMP"
echo "Database backup complete: $(du -h "$DUMP" | cut -f1)"

# Configuration, without secrets resolved — .env holds the passwords, so it is
# backed up separately and deliberately.
CONFIG="$BACKUP_DIR/arihant-mis-config-$STAMP.tar.gz"
tar -czf "$CONFIG" .env docker-compose.yml 2>/dev/null || true
echo "Configuration backup complete: $CONFIG"
echo "  NOTE: this archive contains .env and therefore your database password."
echo "  Store it with the same care as the database dump."

echo "Pruning backups older than $RETENTION_DAYS days ..."
find "$BACKUP_DIR" -name 'arihant-mis-*.gz' -type f -mtime "+$RETENTION_DAYS" -print -delete || true

echo
echo "Done. Backups in $BACKUP_DIR:"
ls -lh "$BACKUP_DIR" | tail -n +2

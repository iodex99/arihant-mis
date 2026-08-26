#!/bin/sh
# Apply pending migrations, then start the app.
#
# `migrate deploy` only applies committed migrations and never resets or drops
# anything, so an update cannot destroy production data.
set -e

echo "Waiting for the database ..."
for i in $(seq 1 60); do
  if npx prisma db execute --stdin <<< "SELECT 1" >/dev/null 2>&1; then
    echo "Database is reachable."
    break
  fi
  if [ "$i" = "60" ]; then
    echo "ERROR: the database was not reachable after 60 attempts." >&2
    echo "Check that the postgres service is running and DATABASE_URL is correct." >&2
    exit 1
  fi
  sleep 2
done

echo "Applying database migrations ..."
npx prisma migrate deploy

echo "Starting Arihant MIS ..."
exec "$@"

# Backup and Restore

Arihant's financial data lives in one PostgreSQL database. Backing that up is
the whole job; everything else in the deployment is reproducible from Git.

## What is worth backing up

| Item | Where | Backed up by |
|---|---|---|
| **All financial data** — facts, dimensions, imports, raw source rows, mappings, users, audit log | PostgreSQL | `scripts/backup.sh` |
| **Configuration** — `.env`, `docker-compose.yml` | Repository directory | `scripts/backup.sh` |
| Original uploaded files | `arihant-mis-uploads` volume | Optional (see below) |
| Application code | Git | GitHub |

The original uploaded files are **not** needed to restore the MIS. Every row of
every import is stored in the database verbatim, so the figures and their
provenance survive without them. They are kept for troubleshooting and pruned
after `UPLOAD_RETENTION_DAYS`.

## Taking a backup

```bash
./scripts/backup.sh
```

Writes to `$BACKUP_DIR` (default `./backups`):

```
arihant-mis-20260826-020000.sql.gz          the database
arihant-mis-config-20260826-020000.tar.gz   .env and docker-compose.yml
```

Safe to run while the application is serving — `pg_dump` takes a consistent
snapshot without blocking writers. The script verifies the archive with
`gzip -t` before trusting it, and refuses to prune anything if the dump came out
empty.

Backups older than `BACKUP_RETENTION_DAYS` (default 30) are pruned.

> The configuration archive contains `.env`, which holds the database password.
> Store it with the same care as the database dump.

### Nightly, unattended

```bash
crontab -e
0 2 * * * cd /opt/arihant-mis && ./scripts/backup.sh >> /var/log/arihant-mis-backup.log 2>&1
```

Windows Server, via Task Scheduler:

```powershell
docker compose exec -T postgres pg_dump -U arihant -d arihant_mis --clean --if-exists |
  Out-File -Encoding utf8 "C:\arihant-mis\backups\arihant-mis-$(Get-Date -f yyyyMMdd).sql"
```

### Off the server

A backup on the same disk as the database is not a backup. Copy the `backups/`
directory to a NAS, another machine or cloud storage on a schedule.

```bash
rsync -az --delete /opt/arihant-mis/backups/ backup-host:/backups/arihant-mis/
```

## Restoring

```bash
./scripts/restore.sh backups/arihant-mis-20260826-020000.sql.gz
```

The script:

1. verifies the archive is intact;
2. asks you to type the database name to confirm;
3. **takes a safety dump of the current database first**, so a mistaken restore
   is itself reversible;
4. stops the app so nothing writes mid-restore;
5. restores with `ON_ERROR_STOP=1`, so a partial restore fails loudly;
6. restarts the app.

Afterwards, open the dashboard and confirm the figures. **Imports → any import →
Figures** shows its reconciliation checks; those should still pass.

## Restoring onto a fresh machine

```bash
git clone https://github.com/iodex99/arihant-mis.git
cd arihant-mis
# restore .env from the config archive, or recreate it from .env.example
docker compose up -d postgres
./scripts/restore.sh /path/to/arihant-mis-YYYYMMDD-HHMMSS.sql.gz
docker compose up -d
```

The dump includes the schema, so no migration step is needed — the restored
database already carries the migration history it was taken with.

## Migrations and backups

`scripts/update.sh` and `update.ps1` **always back up before touching anything**.
That is the point at which schema changes are applied, and it is the one moment
where having a fresh dump matters most.

Migrations use `prisma migrate deploy`, which only applies committed migrations.
It never resets, drops or recreates tables. The PostgreSQL volume is a named
volume and is not removed by `docker compose down`.

## Testing a restore

An untested backup is a guess. Once a quarter:

```bash
# on a scratch machine
git clone https://github.com/iodex99/arihant-mis.git && cd arihant-mis
cp .env.example .env   # any password; this is throwaway
docker compose up -d postgres
./scripts/restore.sh /path/to/latest.sql.gz
docker compose up -d
curl -s localhost:3000/api/health
```

Sign in and check that the dashboard totals match the production dashboard.

## Retention

| What | Default | Setting |
|---|---|---|
| Database dumps | 30 days | `BACKUP_RETENTION_DAYS` |
| Original uploaded files | 180 days | `UPLOAD_RETENTION_DAYS` |
| Parsed rows, facts, import history, audit log | forever | not pruned |

Financial history is never pruned automatically. Deleting it is a deliberate act,
not a retention policy.

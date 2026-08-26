# Deployment

Target: **the Arihant 24×7 server**. No VPS is required — the application, the
API, the parser, the sync engine and the database all run on that one machine.

## What runs

| Container | Purpose |
|---|---|
| `arihant-mis-app` | Web application, API, parser, normalizer, MIS engine, Tally sync |
| `arihant-mis-db` | PostgreSQL 17 |

Two named Docker volumes hold state: `arihant-mis-postgres-data` (the database)
and `arihant-mis-uploads` (original source files). **Neither is removed by an
application update.**

## Prerequisites

* Docker Engine 24+ with the Compose plugin (Docker Desktop on Windows Server).
* 2 GB RAM and 10 GB free disk to start.
* Ports: one for the app (default 3000). PostgreSQL is not published to the host.

## First install

```bash
git clone https://github.com/iodex99/arihant-mis.git
cd arihant-mis
cp .env.example .env
```

Edit `.env`. Three values must change:

```bash
POSTGRES_PASSWORD=<a long random password>
AUTH_SECRET=<generate below>
APP_URL=https://mis.arihant.internal    # or http://<server-ip>:3000
```

Generate the auth secret:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Then:

```bash
docker compose up -d
docker compose logs -f app     # watch it migrate and start
```

Migrations run automatically on start. Create the first administrator:

```bash
docker compose exec app node scripts/seed-admin.js \
  --email admin@arihant.in \
  --password 'a-strong-password' \
  --name 'Administrator'
```

> If that script is not present in the image, run it from a checkout on the host
> with `DATABASE_URL` pointed at the container, or use
> `docker compose exec app npx tsx scripts/seed-admin.ts …`.

Open `http://<server>:3000`, sign in, and follow the first-run prompt: either
test the Tally connection or upload the Excel export.

## Verifying the install

```bash
curl -s http://localhost:3000/api/health
# {"status":"ok","version":"1.0.0","database":"connected","latencyMs":3}
```

`docker compose ps` should show both containers `healthy`.

## Loading data

**Via the browser:** *Imports → Upload a file*. The file is analysed and
validated; nothing is imported until you confirm.

**From the command line**, useful for the first bulk load:

```bash
docker compose exec app npx tsx scripts/import-file.ts /app/uploads/Arihant.xlsx --dry-run
docker compose exec app npx tsx scripts/import-file.ts /app/uploads/Arihant.xlsx
```

`--dry-run` prints the analysis, the reconciliation checks and the totals without
writing anything.

## Connecting Tally

See [`tally-integration.md`](./tally-integration.md). In short: configure and test
in *Admin → Connection*, and enable sync only after the test succeeds.

When Tally runs on the same server as Docker, the Tally host must be
`host.docker.internal` — `localhost` inside the container is the container.
`docker-compose.yml` maps that to the host gateway.

## Remote access

The application is a plain HTTP server on one port and sits behind any reverse
proxy. Nothing about it requires a particular one.

**Cloudflare Tunnel** works well when the server has no public IP and you would
rather not open a firewall port:

```yaml
# add to docker-compose.yml
  tunnel:
    image: cloudflare/cloudflared:latest
    restart: unless-stopped
    command: tunnel --no-autoupdate run --token ${CLOUDFLARE_TUNNEL_TOKEN}
    depends_on: [app]
```

Point the tunnel's public hostname at `http://app:3000` and set `APP_URL` to the
public URL so session cookies are marked `Secure`.

**Cloudflare is optional.** Nginx, Caddy, IIS or a plain LAN address work
identically. The only requirement is that `APP_URL` matches how users reach it.

Serve over HTTPS in production: `APP_URL` starting with `https://` is what makes
the session cookie `Secure`.

## Configuration reference

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | — | Set by Compose from the `POSTGRES_*` values |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | `arihant` / — / `arihant_mis` | Password is required |
| `AUTH_SECRET` | — | Required. Rotating it signs everyone out |
| `APP_URL` | `http://localhost:3000` | Must match the public URL |
| `APP_PORT` | `3000` | Host port |
| `UPLOAD_DIR` | `/app/uploads` | Original source files |
| `UPLOAD_RETENTION_DAYS` | `180` | Prunes original files only; parsed rows and MIS figures are kept indefinitely |
| `BACKUP_DIR` / `BACKUP_RETENTION_DAYS` | `./backups` / `30` | Used by `scripts/backup.sh` |
| `LOG_LEVEL` | `info` | `debug` logs Tally request timings |
| `TALLY_*` | disabled | See [`tally-integration.md`](./tally-integration.md) |

## Scheduling a nightly backup

```bash
crontab -e
0 2 * * * cd /opt/arihant-mis && ./scripts/backup.sh >> /var/log/arihant-mis-backup.log 2>&1
```

On Windows Server, use Task Scheduler to run
`powershell -File C:\arihant-mis\scripts\update.ps1` for updates, and a similar
task calling `docker compose exec -T postgres pg_dump …` for backups. See
[`backup-and-restore.md`](./backup-and-restore.md).

## Local development

Without Docker, on a machine with Node 20+:

```bash
npm install
node scripts/local-db.mjs start    # real PostgreSQL binaries, no Docker needed
```

In another terminal:

```bash
cp .env.example .env
# set DATABASE_URL to the line local-db.mjs printed
npx prisma migrate dev
npm run seed:admin -- --email you@example.com --password 'secret' --name 'You'
npm run import:file -- "for reference/Arihant.xlsx"
npm run dev
```

`scripts/local-db.mjs` is a development convenience only and is a devDependency.
Production always uses the PostgreSQL container.

## Verifying against the reference report

With the client workbook present at `for reference/Arihant.xlsx`:

```bash
npm run verify:reference
```

This runs the whole pipeline and asserts every figure in the supplied PDF —
grand totals, all six streams, the branch table and both months. `npm test` runs
the same assertions as part of the suite, skipping them when the file is absent.

## Resource notes

The supplied workbook produces 3,852 facts and imports in a few seconds. Growth
is roughly 2,000 facts per month at the current branch and account count, so
storage is measured in megabytes per year. The aggregate queries are indexed and
do not degrade with row count in any way that matters at this scale.

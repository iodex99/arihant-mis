# Arihant MIS

Self-hosted financial management information system for **Arihant Academy**.

Replaces the manual chain

```
Tally  →  export  →  Excel preparation  →  Looker Studio  →  MIS
```

with

```
Tally  →  Arihant MIS  →  MIS
```

and keeps a robust Excel/CSV upload path as the fallback — or as the primary
route, until Tally connectivity has been confirmed on Arihant's own server.

---

## What it does

* **Imports Excel or CSV** without depending on a fixed column layout. Columns
  can be reordered, renamed, added or removed; title rows, blank rows and total
  rows are handled; the operator confirms a preview before anything is saved.
* **Reconciles every import.** Revenue − Expense = Profit, component sums against
  reported totals, and roll-ups across branch, stream and period. An import that
  does not balance is flagged, never silently accepted.
* **Reproduces the existing MIS**: stream profitability, branch profitability,
  expense analysis, group analysis and the per-branch comparison matrix — with
  global filters, sortable tables and exports.
* **A management dashboard** with KPI cards, trends, composition and rankings,
  all driven by the same filters.
* **Six analytical reports** beyond the original MIS: period variance, centre
  and status, stream-by-branch margin, profit concentration, cost structure and
  scale-against-margin — with the accounting artefacts that would mislead you
  called out rather than left to be discovered.
* **Drill-down** from branch to expense group to expense head to the exact
  spreadsheet row a figure came from.
* **A Tally adapter** with a connection test and capability probe. Read-only by
  construction — there is no write path.

### Verified against the client's own report

The pipeline reproduces every figure in `Monthly_Arihant_lookers_Studio-MIS.pdf`
to the paisa:

| | |
|---|---|
| Total Income | ₹8,15,76,200.57 |
| Total Expense | ₹6,10,30,802.65 |
| Profit | ₹2,05,45,397.92 |
| Profit margin | 25.19 % |

All six streams, the full branch ranking and both months match. Run it yourself
with `npm run verify:reference`.

---

## Documentation

| | |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | How the pieces fit together and why |
| [`docs/data-dictionary.md`](docs/data-dictionary.md) | Every column of the source workbook, measured |
| [`docs/mis-specification.md`](docs/mis-specification.md) | The reverse-engineered reporting logic |
| [`docs/parser.md`](docs/parser.md) | How the universal importer works |
| [`docs/tally-integration.md`](docs/tally-integration.md) | What is confirmed, what depends on the environment, what is untested |
| [`docs/deployment.md`](docs/deployment.md) | Installing on the Arihant server |
| [`docs/backup-and-restore.md`](docs/backup-and-restore.md) | Backups, restores, retention |
| [`docs/update-process.md`](docs/update-process.md) | Updating without touching the data |
| [`docs/troubleshooting.md`](docs/troubleshooting.md) | Symptom → cause → fix |

---

## Architecture in one diagram

```
        ┌──────────┐
        │  TALLY   │
        └────┬─────┘
             │  Tally adapter (read-only)
             ▼
   ┌───────────────────┐
   │    NORMALIZER     │◀──── Excel / CSV ──── Universal importer
   └─────────┬─────────┘
             ▼
      ┌──────────────┐
      │  PostgreSQL  │   raw layer (verbatim) + canonical layer (facts)
      └──────┬───────┘
             ▼
      ┌──────────────┐
      │  MIS ENGINE  │   every calculation, aggregated in SQL
      └──────┬───────┘
      ┌──────┴───────┐
      ▼              ▼
  TABULAR MIS    DASHBOARD
```

Past the normalizer, nothing knows whether the data came from Tally or a
spreadsheet.

---

## Stack

Next.js 15 · TypeScript · React 19 · Tailwind CSS · PostgreSQL 17 · Prisma ·
Zod · ExcelJS · Papa Parse · Recharts · Vitest · Docker Compose

**No AI, no LLM, no external service.** The parser and normalizer are
deterministic: the same file always produces the same result, which is what makes
an import auditable. Financial data never leaves the server.

---

## Production deployment

Runs entirely on the Arihant server. No VPS required.

```bash
git clone https://github.com/iodex99/arihant-mis.git
cd arihant-mis
cp .env.example .env
```

Set three values in `.env`:

```bash
POSTGRES_PASSWORD=<a long random password>
AUTH_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")
APP_URL=http://<server-address>:3000
```

Then:

```bash
docker compose up -d

docker compose exec app node dist/cli/seed-admin.js \
  --email admin@arihant.in --password 'a-strong-password' --name 'Administrator'
```

Open `http://<server>:3000`. Full detail, including reverse proxy and Cloudflare
Tunnel notes, in [`docs/deployment.md`](docs/deployment.md).

---

## Local development

No Docker needed — `scripts/local-db.mjs` runs real PostgreSQL binaries.

```bash
npm install
npm run db:local                       # prints a DATABASE_URL
                                       # (alias for: node scripts/local-db.mjs start)
```

In a second terminal:

```bash
cp .env.example .env                   # paste in the DATABASE_URL it printed
npx prisma migrate dev
npm run seed:admin -- --email you@example.com --password 'secret' --name 'You'
npm run dev
```

### Loading the sample data

Place the client workbook at `for reference/Arihant.xlsx` (it is confidential and
is **not** in this repository), then:

```bash
npm run import:file -- "for reference/Arihant.xlsx" --dry-run   # analyse only
npm run import:file -- "for reference/Arihant.xlsx"             # import
```

---

## Environment variables

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | — | Required. Compose builds it from the `POSTGRES_*` values |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | `arihant` / — / `arihant_mis` | Password required |
| `AUTH_SECRET` | — | Required. Rotating it signs everyone out |
| `APP_URL` | `http://localhost:3000` | Must match the public URL; `https://` makes cookies `Secure` |
| `APP_PORT` | `3000` | Host port |
| `UPLOAD_DIR` | `./uploads` | Original source files |
| `UPLOAD_RETENTION_DAYS` | `180` | Prunes original files only — parsed rows and figures are kept forever |
| `BACKUP_DIR` / `BACKUP_RETENTION_DAYS` | `./backups` / `30` | Used by `scripts/backup.sh` |
| `LOG_LEVEL` | `info` | `debug` adds Tally request timings |
| `TALLY_ENABLED` | `false` | Leave off until the connection test passes |
| `TALLY_ADAPTER` / `TALLY_HOST` / `TALLY_PORT` / `TALLY_COMPANY_NAME` | `TALLY_XML_HTTP` / `localhost` / `9000` / — | Server-side only, never sent to the browser |
| `TALLY_USE_HTTPS` / `TALLY_TIMEOUT_MS` | `false` / `60000` | Transport and request timeout |
| `TALLY_SYNC_ENABLED` / `TALLY_SYNC_CRON` | `false` / hourly | Gate and suggested schedule for `npm run sync:tally`. The app has no in-process scheduler — see below |

Full reference in [`docs/deployment.md`](docs/deployment.md).

---

## Database and migrations

```bash
npx prisma migrate dev --name describe_the_change   # development
npx prisma migrate deploy                           # production (automatic on container start)
```

`migrate deploy` only applies committed migrations. It never resets, drops or
recreates tables, and the PostgreSQL volume is a named volume that updates do not
touch. See [`docs/update-process.md`](docs/update-process.md).

---

## Backups

```bash
./scripts/backup.sh                       # database + configuration, verified
./scripts/restore.sh backups/<file>.gz    # safety-dumps first, then restores
```

Schedule nightly; copy off the server. See
[`docs/backup-and-restore.md`](docs/backup-and-restore.md).

---

## Scheduled jobs

There is no in-process scheduler: the app is containerised, and a timer inside
it would fire once per running copy. Periodic work is a cron entry on the host.

```bash
npm run maintenance -- --dry-run   # show what housekeeping would remove
npm run maintenance                # prune expired source files, staging, sessions
npm run sync:tally                 # scheduled Tally sync (no-op unless enabled)
```

Maintenance touches only derived artefacts. Parsed rows, facts, imports and the
audit log are kept indefinitely. Cron examples in
[`docs/deployment.md`](docs/deployment.md).

## Updating

```bash
./scripts/update.sh          # Linux
.\scripts\update.ps1         # Windows Server
```

Backs up, pulls, rebuilds, migrates, restarts, and waits for `/api/health`. Each
step stops on failure with the data intact.

---

## Tally connectivity

The adapter interface, the XML/HTTP implementation, the connection test, the
capability probe and the sync engine are all built. **Whether Arihant's
particular Tally installation will accept a connection is a fact about that
machine, and this repository does not claim to know it.**

Configure and test in **Admin → Connection**. The test reports the Tally version,
round-trip time, and each capability probed independently, so a partly-working
environment is visible rather than reduced to a single tick. Enable sync only
after it succeeds.

The integration is **read-only by construction** — the `TallyAdapter` interface
has no write method, so there is no code path that could modify a voucher,
ledger or master.

See [`docs/tally-integration.md`](docs/tally-integration.md) for the confirmed /
environment-specific / untested breakdown.

---

## Tests

```bash
npm test           # 150 tests
npm run typecheck
npm run verify:reference   # asserts every figure in the supplied PDF
```

Covers the parser (reordered columns, renamed columns, title and total rows,
formatted numbers, CSV, malformed input), the financial calculations and Indian
fiscal-year logic, formatting, and — when the client workbook is present — the
full reference report. Import deletion and the analytical reports are covered by
database-backed suites that skip when no database is reachable and work in their
own throwaway organizations. A further suite checks the documentation itself
for drift — broken links, undocumented report sheets, environment variables
missing from the README, and references to scripts or files that no longer exist.

---

## Security

* Authenticated sessions; opaque token in an `httpOnly` cookie, only its hash
  stored.
* bcrypt password hashing at cost 12; constant-time login regardless of whether
  the account exists.
* Roles: `ADMIN`, `ANALYST`, `VIEWER`. Deleting an import is `ADMIN`-only, enforced in the API as well as the UI.
* Tally connection settings are server-side only; adapter credentials never
  reach the browser.
* Audit log for logins, imports, deletions, sync runs and mapping changes. A deletion's audit entry is written before the delete, so it survives it.
* Logs redact passwords, tokens, cookies, `AUTH_SECRET` and `DATABASE_URL`.
* No financial data is sent to any external service.

---

## Known limitations

* **Tally connectivity is unverified against Arihant's environment.** Everything
  around it is built and tested; the connection itself needs the machine.
* **Drill-down stops at the expense head** for file-imported data. The workbook
  is pre-aggregated by branch, stream and month and contains no vouchers.
  Fabricating a transaction level would be worse than saying so. Tally-sourced
  data carries voucher detail, and the columns for it already exist.
* **Legacy `.xls` is not supported** — save as `.xlsx`.
* **Cost centres are not modelled.** The workbook's `Centre` is a geographic
  region, not a Tally cost centre. The adapter can retrieve real cost centres
  when connected.
* **No zero-downtime deploy.** An update restarts the app for roughly 30
  seconds.

---

## Repository layout

```
docs/                 architecture, data dictionary, MIS spec, parser, Tally, ops
prisma/               schema and migrations
scripts/              seed, import, verify, backup, restore, update, maintenance,
                      scheduled sync, local DB
src/
  app/(app)/          dashboard, tabular MIS, analysis, drill-down, imports, admin
  app/api/            auth, imports (analyze/commit/delete), tally, mappings,
                      export, health
  components/         UI, tables, filters, charts (Charts, AnalysisCharts, palette)
  lib/
    parser/           readers, structure, mapping, subtotals, analyze
    normalization/    canonical model, periods, reconciliation
    mis/              engine (core reports), analysis (variance, concentration,
                      cross-tabs, cost structure, positioning), drill, filters
    tally/            adapter interface, XML/HTTP adapter, sync engine
    import/           persistence, staging, deletion
    api.ts            route error handling (401/403 rather than 500)
tests/                parser, finance, reference report, import deletion, analysis
docker-compose.yml    the whole deployment
```

# Tally Integration

This document separates three things that are easy to conflate:

1. **Confirmed** — verified in this codebase, in Tally's own documentation, or
   established about Arihant's actual environment.
2. **Environment-specific** — depends on Arihant's setup and must be checked there.
3. **Not yet tested** — explicitly unproven, and named so nobody assumes otherwise.

---

## 1. Arihant's environment — established

**Arihant does not run Tally on a machine we can reach.** Their Tally is a
**third-party hosted web application**: staff open it in a browser and work in a
web interface — clickable forms and pages, not the keyboard-driven Tally screens
— and the data lives on the hosting vendor's servers, not on any Arihant
machine.

This was established directly with the client, and it settles a question the
original build specification left open. It has one hard consequence:

> **The XML/HTTP adapter cannot apply here.** That adapter needs a Tally process
> listening on a port the MIS can reach. In this environment there is no such
> process on any machine Arihant controls, and no port to open. It is not a
> configuration problem to be solved; the premise does not hold.

Two things follow, and they are the shape of the integration:

* **The file path is not a fallback. It is the integration.** Everything the MIS
  does — parsing, reconciliation, the whole MIS — is driven by the export that
  comes out of that hosted product. This is fully built and verified against the
  real data.
* **Automation happens on our side of the export.** The MIS cannot pull from a
  product it cannot reach, so instead it accepts a delivered file without a
  person: see §2.

### What this changes about the original goal

The goal was to replace this:

```
Tally  →  export  →  Excel preparation  →  Looker Studio  →  MIS
```

The export step cannot be removed, because the data only leaves the vendor's
platform that way. Everything after it can, and has been:

```
Tally (hosted)  →  export  →  [ drop it in a folder ]  →  MIS
```

Excel preparation and Looker Studio are gone entirely. What remains is one
export, and even that becomes unattended if the vendor's platform can write to a
folder or POST on a schedule (§2).

---

## 2. How data actually gets in

Three doors, all using the same parser, the same reconciliation and the same
safety rule.

| Route | For | Command |
|---|---|---|
| **Browser upload** | Ad-hoc, and anything needing a decision | *Imports → Upload a file* |
| **Watched folder** | The routine monthly load | `npm run ingest` from cron |
| **Push endpoint** | A scheduler that can deliver the file itself | `POST /api/imports/ingest` |

### The safety rule

The unattended routes import a file **only when nothing about it needs a
person**: it parses without blockers, every column maps confidently, and all
five reconciliation identities hold. Anything else is held, with the reasons
written out.

This is not caution for its own sake. An unattended importer that silently
accepted a file whose totals did not balance would be worse than no automation —
it would put wrong figures in front of management with no one having looked.

### Watched folder

```bash
# .env
INGEST_DIR=./uploads/inbox
```

Drop the export in that folder. A scheduled run analyses it and either imports
it or moves it to `needs-review/` with a `.txt` beside it naming exactly what a
person needs to resolve. Files are **moved, never deleted**, and are timestamped
so re-dropping the same filename never overwrites anything.

```bash
npm run ingest -- --dry-run    # report only, change nothing
npm run ingest                 # do it
```

Exits non-zero when anything was held, so cron reports it rather than swallowing
it. Cron entry in [`deployment.md`](./deployment.md).

### Push endpoint

Off unless `INGEST_API_KEY` is set to at least 24 characters, and it returns 503
saying so rather than sitting open.

```bash
curl -X POST https://mis.arihant.internal/api/imports/ingest \
     -H "Authorization: Bearer $INGEST_API_KEY" \
     -F "file=@monthly-export.xlsx"
```

Returns `200` imported or duplicate, `202` held for review with the reasons, and
`422` when the file could not be read at all. The key permits **depositing a
file only** — it grants no read access to any figure and cannot delete anything.

---

## 3. What to ask the hosting vendor

Worth asking, in descending order of usefulness. Each turns the one remaining
manual step into nothing.

1. **Can the platform export on a schedule** to a folder, an email address, FTP,
   or a URL? If it can POST, point it at the ingest endpoint and the chain is
   fully automatic. If it can drop a file on a share the server can see, point
   `INGEST_DIR` at that share.
2. **Is there an API** for reports or vouchers? If so, it becomes a new adapter
   behind the existing `TallyAdapter` interface — nothing else in the
   application changes (§6).
3. **Is the underlying Tally reachable at all** — a VPN, a fixed IP, an opened
   port? Unlikely on a shared hosted plan, but if yes, the XML/HTTP adapter
   already exists and the connection test would confirm it.
4. **What formats can it export?** `.xlsx` and `.csv` both work. The parser does
   not depend on a fixed column layout, so a format change is not a rebuild.

Until one of those is answered, the watched folder is the automation, and it
works today.

---

## 4. How Tally data would map onto the MIS model

This section applies **only if** a direct connection ever becomes possible
(§3). It is not how data reaches the MIS today.

Tally has no notion of Arihant's *branch* and *stream*. Their chart of accounts
encodes those in the ledger-group caption:

```
Arihant Academy (CBSE) - Charkop (CKP)
                  ^^^^     ^^^^^^^^^^^^
                  stream   branch (code in brackets)
```

`parseLedgerContext` in `src/lib/tally/sync.ts` extracts them. **When a caption
does not match that shape, the entry is recorded against an explicit
`Unassigned` branch — never guessed and never dropped.** That is visible in the
MIS rather than hidden, so a chart-of-accounts change shows up as a growing
`Unassigned` figure instead of quietly distorting branch reports.

Tally-sourced facts carry detail the spreadsheet path cannot: voucher date,
type, number, ledger name, party and narration. Those columns already exist on
`FactEntry` and are null for file imports, so the drill-down gains a
voucher-level leaf with no schema change.

### Scheduling

There is no in-process scheduler. `npm run sync:tally` is a cron-able script
that refuses to run unless **both** `TALLY_SYNC_ENABLED=true` and the connection
is enabled in Admin → Connection — so the cron entry can be added before
connectivity has been confirmed without it doing anything. It exits non-zero on
failure, so cron reports the problem rather than swallowing it.

`TALLY_SYNC_CRON` in `.env` is documentation of the intended schedule; the
application does not read it.

### Incremental sync

Each run stores its window. The next run starts one day before the previous
run's end date, so vouchers back-dated after a sync are still picked up. A first
sync with no history looks back 400 days. Both are overridable per run.

---

## 5. The adapter interface, and why it stays

The interface stays because it costs nothing and it is the right shape for
whatever comes next. If the hosting vendor exposes an API, that becomes one new
class implementing `TallyAdapter` — the MIS engine, the database and the
dashboard do not change, because nothing above the normalizer knows where data
came from.

`ADAPTERS` in `src/lib/tally/index.ts` lists three, of which one is implemented.
The other two are listed, disabled, with the reason shown in the admin UI.

* **JSON over HTTP.** TallyPrime 7.0 documents it, but implementing an adapter
  against a version Arihant may not run would produce a connector that appears
  to work and returns wrong or empty data. It is a small addition once the
  version is known — the interface does not change.
* **ODBC.** Requires the Tally ODBC driver installed on the *MIS* host and is
  Windows-only, which conflicts with the Linux container deployment. Kept as a
  documented option for environments where the HTTP listener cannot be enabled.

Adding either means writing one class against `TallyAdapter`. Nothing else in
the application changes.

---

## 6. Read-only, by construction

The `TallyAdapter` interface has **no write method**. There is no code path
anywhere in this application that creates, alters or deletes a Tally voucher,
ledger, master or accounting entry.

```
TALLY  ──read──▶  MIS        (implemented)
MIS    ──write─▶  TALLY      (does not exist)
```

This is not a configuration setting that could be switched on by accident. Adding
write support would require changing the interface, which is the point.

---

## 7. Running the connection test

1. **Admin → Connection**.
2. Set the adapter (XML over HTTP), host, port and the Tally company name
   exactly as Tally shows it.
3. **Save settings**, then **Test connection**.

The test reports:

* whether Tally is reachable, and how long the round trip took;
* the Tally version, when Tally reports one;
* each capability probed **independently** — companies, groups, ledgers, cost
  centres, transactions, reports — so a partly-working environment is visible
  rather than reduced to a single pass/fail.

If it fails, the result names what to check, drawn from what actually went
wrong: a timeout suggests different causes from a refused connection. Only after
a successful test should **Enable Tally sync** be switched on.

### If the test fails

The failure is recorded, not worked around. Record what the test reported, work
through the checklist it shows, and keep using the file-import path meanwhile —
it is fully supported and produces the identical MIS.

---

## 8. Docker note

When the MIS runs in Docker on the same server as Tally, `localhost` inside the
container is the container, not the server. Use `host.docker.internal`, which
`docker-compose.yml` maps to the host gateway. That is the default in
`.env.example`.

---

## 9. Security

* Connection settings are stored server-side and read only by server code.
* `redactConnection` defines what may reach the browser: adapter, host, port,
  company name and timeout. Any adapter-specific `extra` config — where
  credentials would live — never leaves the server.
* No Tally credential is embedded in client-side JavaScript.
* Tally requests and responses are logged at `debug` with status, timing and
  size only. The logger redacts credential-shaped fields
  (`src/lib/logger.ts`).

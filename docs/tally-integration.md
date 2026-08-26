# Tally Integration

This document separates three things that are easy to conflate:

1. **Confirmed** — verified in this codebase or in Tally's own documentation.
2. **Environment-specific** — depends on Arihant's machine and must be checked there.
3. **Not yet tested** — explicitly unproven, and named so nobody assumes otherwise.

Nothing here claims a connection works. The connection test in
**Admin → Connection** is how that gets established, against the real machine.

---

## 1. Where the integration stands

| | Status |
|---|---|
| Adapter interface | **Implemented.** `src/lib/tally/types.ts` |
| XML/HTTP adapter | **Implemented.** `src/lib/tally/xml-http.ts` |
| Connection test + capability probe | **Implemented.** Admin → Connection |
| Sync engine (vouchers to canonical facts) | **Implemented.** `src/lib/tally/sync.ts` |
| Sync history and error log | **Implemented.** |
| Connection to Arihant's Tally | **Not yet tested.** Requires access to the machine. |
| JSON adapter | **Not implemented** — see §6. |
| ODBC adapter | **Not implemented** — see §6. |
| Writing back to Tally | **Not implemented, and deliberately absent** — see §7. |

The file-import path is complete and is the supported way to load data until
the connection test passes. The MIS cannot tell the two sources apart once the
data is normalized, so nothing about the dashboard changes when Tally is
connected.

---

## 2. Confirmed facts

* **Tally can act as an HTTP server.** Tally.ERP 9 and TallyPrime can open a
  listener on the machine running Tally, configured under
  *Help → Settings → Connectivity → Client/Server configuration*, with
  "TallyPrime acts as" set to **Server** or **Both** and a port (9000 by
  convention). Requests are XML envelopes POSTed to that port.

* **The request format this adapter uses** is Tally's documented "Export Data"
  envelope: `ENVELOPE > HEADER(TALLYREQUEST=Export) + BODY > DESC >
  STATICVARIABLES / TDL`. The adapter builds collection requests for companies,
  groups, ledgers and cost centres, and a Day Book request for vouchers.

* **Tally reports request-level errors inside an HTTP 200.** A malformed or
  unsupported request returns `<LINEERROR>` in the body rather than a non-2xx
  status. The adapter checks for this explicitly; treating HTTP 200 as success
  would silently produce empty reports.

* **TallyPrime 7.0 documents native JSON exchange** of masters, transactions and
  reports. That is a documented capability of that version — not a statement
  about which version Arihant runs.

## 3. Environment-specific — must be checked on Arihant's machine

None of these can be answered from here:

| Question | How to answer it |
|---|---|
| Which Tally product and version is installed? | The connection test reports it when it connects; otherwise read it from Tally's title bar. |
| Is the connectivity listener enabled? | *Help → Settings → Connectivity* in Tally. |
| Which host and port? | Same screen. The MIS defaults to `localhost:9000`. |
| Does the licence/edition permit the listener? | Tally support, or simply whether the test connects. |
| Is a company open? | Tally returns no data when no company is loaded. |
| Does the exact company name match? | The connection settings must use the name exactly as Tally shows it. |
| Can the MIS host reach the Tally host? | Firewall and network. When the MIS runs in Docker on the same server, use `host.docker.internal`. |

## 4. Not yet tested

* Whether Arihant's Tally answers the request envelopes this adapter sends.
* Whether the Day Book export includes cost-centre allocations for their chart
  of accounts.
* How long a full-month voucher export takes on their data volume.
* Whether their ledger names follow the
  `Arihant Academy (CBSE) - Charkop (CKP)` convention consistently enough to
  derive branch and stream from them (§5).

---

## 5. How Tally data maps onto the MIS model

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

### Incremental sync

Each run stores its window. The next run starts one day before the previous
run's end date, so vouchers back-dated after a sync are still picked up. A first
sync with no history looks back 400 days. Both are overridable per run.

---

## 6. Why the other adapters are declared but not implemented

`ADAPTERS` in `src/lib/tally/index.ts` lists three, of which one is available.
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

## 7. Read-only, by construction

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

## 8. Running the connection test

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

## 9. Docker note

When the MIS runs in Docker on the same server as Tally, `localhost` inside the
container is the container, not the server. Use `host.docker.internal`, which
`docker-compose.yml` maps to the host gateway. That is the default in
`.env.example`.

---

## 10. Security

* Connection settings are stored server-side and read only by server code.
* `redactConnection` defines what may reach the browser: adapter, host, port,
  company name and timeout. Any adapter-specific `extra` config — where
  credentials would live — never leaves the server.
* No Tally credential is embedded in client-side JavaScript.
* Tally requests and responses are logged at `debug` with status, timing and
  size only. The logger redacts credential-shaped fields
  (`src/lib/logger.ts`).

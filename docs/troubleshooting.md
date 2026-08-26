# Troubleshooting

Every error surface in this application aims to say three things: what happened,
why, and what to do next. If you hit one that doesn't, that's a bug worth
reporting.

---

## The application will not start

**`docker compose ps` shows `app` restarting.**

```bash
docker compose logs --tail=100 app
```

| Log says | Cause | Fix |
|---|---|---|
| `the database was not reachable after 60 attempts` | PostgreSQL is not up, or `DATABASE_URL` is wrong | `docker compose logs postgres`; check `POSTGRES_PASSWORD` matches in `.env` |
| `set AUTH_SECRET in .env` | Required variable missing | Generate one: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
| `Migration ... failed to apply` | A migration hit existing data it cannot transform | Do not retry blindly. Restore the pre-update backup and read the migration |
| `EADDRINUSE` | Another process holds the port | Change `APP_PORT` in `.env` |

**The login page says "Database unavailable".** The app is running but Postgres
is not answering. `curl localhost:3000/api/health` will show
`"database":"unreachable"`.

---

## Sign-in

**"Email or password is incorrect."** Deliberately identical for an unknown
account and a wrong password — it does not reveal which accounts exist. Check
the audit log:

```bash
docker compose exec postgres psql -U arihant -d arihant_mis \
  -c "SELECT \"createdAt\", action, metadata FROM audit_logs WHERE action LIKE 'LOGIN%' ORDER BY \"createdAt\" DESC LIMIT 10;"
```

**"No accounts yet."** A fresh install. Create the first administrator:

```bash
docker compose exec app npx tsx scripts/seed-admin.ts \
  --email you@arihant.in --password 'a-strong-password' --name 'Your Name'
```

**Everyone was signed out at once.** `AUTH_SECRET` changed, or the `sessions`
table was cleared. Sessions also expire after 7 days.

---

## Importing a file

### "The legacy .xls format is not supported."

Open in Excel, *Save As* → `.xlsx`, upload again.

### "No sheet in this file contains recognisable financial data."

The importer looks for dimension columns (branch, month) alongside numeric
amount columns. Check the right file was uploaded. The message lists each sheet
and why it was rejected. If a sheet should have qualified, its header row may not
have been found — see below.

### "Sheet X has no branch or month column."

The MIS needs to place figures in time and place. Either map an existing column
to that field in the preview, or add it to the export.

### The header row was detected in the wrong place

The preview shows which row was chosen and which rows were skipped as
preamble. The detector wants a row that is dense, textual, has unique values, and
is followed by rows that look different from it. A header separated from its data
by several decorative rows, or a sheet where the first data rows are also text,
can mislead it. Deleting decorative rows from the export is the reliable fix.

### A column was mapped to the wrong field

Change it in the preview — the analysis re-runs and the totals update, so what
you see is what will be imported. Tick "Remember this column mapping" and future
uploads inherit the correction.

### "Column X is named like Y but contains Z values"

Not an error. The source file's header disagrees with its own contents, and the
importer trusted the contents. The client's workbook does exactly this: its
`Quater` column holds months and its `Month` column holds quarters. The mapping
shown is correct; fixing the source file's headers removes the warning.

### The figures do not reconcile

The preview names which identity failed and by how much:

| Check | Meaning |
|---|---|
| `Revenue components vs reported revenue` | Ingested revenue heads do not sum to the file's revenue total |
| `Expense components vs reported expense` | Same, for expense |
| `Revenue - Expense = Profit` | The file's own profit column disagrees |
| `Source expense subtotals agree` | The file's two expense totals disagree with each other |
| `Totals agree across branch, stream and period` | A fact escaped a dimension |

Usually the file itself is inconsistent — a stale formula, or a hand-edited
total. Import anyway if you have judged it acceptable; the import is flagged
`NEEDS_REVIEW` and the difference is recorded on the import detail page.

### An expense head is under "Unclassified"

The mapping sheet has no group for it. **Nothing is lost** — its amount is in
every total. Assign it in **Admin → Mappings**, and the assignment is remembered
for future imports.

### A whole sheet was skipped as "derived"

Deliberate. A sheet that is a subset or rollup of the main sheet would
double-count if imported too. The preview states the reason (for example
"covers 1 of the 2 periods in Main data"). The MIS regenerates that view from the
primary sheet, so nothing is lost.

### The import is slow

A 60 MB workbook takes a minute or two. `maxDuration` allows 300 seconds. Beyond
that, split the workbook by period.

---

## Tally

### "Could not reach Tally at http://host:9000"

Work through the checklist the connection test prints. In practice, in order of
likelihood:

1. Tally is not running, or no company is open.
2. The connectivity listener is off — *Help → Settings → Connectivity →
   Client/Server configuration*, "acts as" must be **Server** or **Both**.
3. Wrong port.
4. Firewall on the Tally machine.
5. **Running in Docker and using `localhost`** — inside the container that is
   the container. Use `host.docker.internal`.

### "Tally did not respond within N seconds"

Most often a modal dialog is open in Tally, which blocks the listener. Also check
the date range is not unreasonably large.

### "Tally rejected the request"

Tally returned `<LINEERROR>`. Usually the company name does not exactly match the
company open in Tally, or that Tally version does not support the requested
report.

### Sync says "Tally sync is disabled"

By design. Test the connection first, then tick **Enable Tally sync** in
**Admin → Connection**.

### Synced entries land under an "Unassigned" branch

Branch and stream are derived from the ledger caption
(`Arihant Academy (CBSE) - Charkop (CKP)`). Captions not following that shape
cannot be attributed, and are recorded as `Unassigned` rather than guessed. A
growing `Unassigned` figure means the chart of accounts has drifted from that
convention.

---

## The dashboard

**"No financial data available."** Nothing has been imported and no sync has
run. Upload a file or connect Tally.

**A branch shows "—" for margin.** It has no revenue in the current selection.
A margin needs revenue to divide by; showing 0 % would rank it alongside a
genuinely break-even branch. Those branches are listed separately under
"Cost-only branches".

**Percentages differ from the old Looker Studio report.** Expected, and
documented. The old report divided by a revenue figure repeated once per
expense-head row, so its percentages read low — its grand total showed 1.23 %
where expense was actually about 59 % of revenue. The **amounts are identical**
in both systems. See [`data-dictionary.md`](./data-dictionary.md) §5.

**The trend chart says "only one period is in view".** Only one month matches
the filters. Widen the month filter or import another period.

**A chart is blank.** Reload. If it persists in a specific browser, check the
console for an error and report it.

---

## Performance

**A page is slow.** Aggregation happens in PostgreSQL and returns tens of rows,
so slowness usually means the database, not the app.

```bash
docker compose exec postgres psql -U arihant -d arihant_mis -c "
  SELECT schemaname, relname, n_live_tup FROM pg_stat_user_tables ORDER BY n_live_tup DESC LIMIT 10;"
```

If `fact_entries` has grown into the millions and queries have slowed, refresh
the planner statistics:

```bash
docker compose exec postgres psql -U arihant -d arihant_mis -c "VACUUM ANALYZE;"
```

---

## Getting more detail

```bash
# turn on debug logging (includes Tally request timings)
# in .env:  LOG_LEVEL=debug
docker compose up -d app
docker compose logs -f app
```

The logger redacts passwords, tokens, cookies, `AUTH_SECRET` and `DATABASE_URL`,
so logs are safe to share.

## Checking the pipeline end to end

With the client workbook present:

```bash
npm run verify:reference
```

This runs analysis, normalization and reconciliation and asserts every figure in
the supplied PDF. If that passes and the dashboard still looks wrong, the problem
is in the query or display layer, not in the data.

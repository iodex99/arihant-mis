# Architecture

## The governing principle

Two interchangeable ingestion paths converge on one normalized model. Past that
point nothing knows or cares where the data came from.

```
        ┌──────────┐
        │  TALLY   │
        └────┬─────┘
             │  Tally adapter (read-only)
             ▼
   ┌───────────────────┐
   │                   │
   │    NORMALIZER     │◀──── Excel / CSV ──── Universal importer
   │                   │
   └─────────┬─────────┘
             │
             ▼
      ┌──────────────┐
      │  PostgreSQL  │   raw layer + canonical layer
      └──────┬───────┘
             │
             ▼
      ┌──────────────┐
      │  MIS ENGINE  │   aggregates in SQL
      └──────┬───────┘
             │
      ┌──────┴───────┐
      ▼              ▼
  TABULAR MIS    DASHBOARD
```

The dashboard has no notion of "file data" or "Tally data". Swapping the source
changes nothing above the normalizer.

## Layers

| Layer | Location | Responsibility |
|---|---|---|
| Readers | `src/lib/parser/readers.ts` | File bytes to a neutral grid |
| Structure | `src/lib/parser/structure.ts` | Header row, column profiles, total rows |
| Mapping | `src/lib/parser/mapping.ts`, `dictionary.ts` | Column meaning, with confidence |
| Subtotals | `src/lib/parser/subtotals.ts` | Arithmetic verification of total columns |
| Analysis | `src/lib/parser/analyze.ts` | Orchestrates the read-only pass |
| Normalization | `src/lib/normalization/` | Canonical facts, periods, reconciliation |
| Persistence | `src/lib/import/persist.ts` | Transactional write of an import |
| Tally | `src/lib/tally/` | Adapter interface, XML/HTTP adapter, sync engine |
| MIS engine | `src/lib/mis/` | Every financial calculation |
| UI | `src/app/`, `src/components/` | Presentation only |

**Financial logic lives in `src/lib/mis/`, never in a React component.** A
component asks for a computed dataset and renders it.

## Data model

Two clearly separated layers:

**Raw** — exactly what arrived. `Import`, `ImportFile`, `ImportSheet`,
`ImportRow` (verbatim cell values), `SourceRowSummary`. Never mutated after
write. This is the audit trail behind every number and the target of drill-down's
deepest level.

**Canonical** — what the MIS queries. `Period`, `Branch`, `Stream`, `Centre`,
`Account` and the single fact table `FactEntry`.

```
FactEntry = (periodId, branchId, streamId, centreId, accountId, kind, amount)
          + source (FILE_IMPORT | TALLY_SYNC)
          + importId / importRowId / syncRunId       ← provenance
          + voucherDate, voucherType, ledgerName …   ← null until Tally supplies them
```

One tidy fact table serves every report. There are no per-report tables to keep
in step, which is exactly the failure mode of the workbook this replaces: its
`Branch Data` and `Comparison` sheets are stale rollups of `Main data` that stopped
being regenerated and now disagree with it by a whole month.

The Tally-only columns exist and are nullable from day one, so connecting Tally
later adds detail without a migration that rewrites existing rows.

## Why re-importing replaces rather than appends

Committing an import deletes the file-sourced facts for the periods that import
covers, then writes the new ones — inside one transaction. A corrected file
supersedes the original instead of doubling every figure. Previous `Import`
records and their raw rows are never deleted, so history stays queryable.

## Performance

Reports are never computed from raw rows in the browser.

* Every aggregation is a `groupBy` in PostgreSQL, returning tens of rows.
* `FactEntry` carries a composite index for each aggregation path the engine
  uses (`companyId + periodId`, `+ branchId`, `+ streamId`, `+ accountId`,
  `+ centreId`, and `kind + periodId`).
* Filters are applied in SQL. A filtered dashboard transfers a few kilobytes
  regardless of how many facts exist.
* Tables paginate and sort client-side over an already-aggregated result set —
  at most a few dozen rows.

The supplied workbook produces 3,852 facts. The design holds at millions:
the per-request cost is the aggregate query, not the row count.

## Revenue is not filtered by expense-side filters

`buildRevenueWhere` strips `groups` and `accounts` before building the clause.
Selecting an expense group should narrow expense while leaving revenue as the
full revenue of the remaining scope. Without this, every percentage-of-revenue
divides by zero and the report becomes nonsense.

## Filter state lives in the URL

The filter bar is the only client component involved; it rewrites the query
string with `router.replace` inside a transition. The server components beneath
re-render with the new filters. A filtered view is therefore shareable, survives
reload, and needs no client-side state store.

## Authentication

Opaque random session token in an `httpOnly` cookie; only its SHA-256 hash is
stored, so a database dump yields no usable sessions. Passwords are bcrypt at
cost 12. Login runs a bcrypt comparison even for a non-existent account, so
timing does not reveal which accounts exist.

Three roles: `ADMIN` (everything), `ANALYST` (import, no admin), `VIEWER`
(read only).

## Single client, not single-tenant-by-accident

`organizationId` and `companyId` are threaded through every query and every index
from the start. This is not a SaaS platform and nothing multi-tenant is built —
but a second company would not require touching the MIS engine, which is the
only part expensive to change later.

## What is deliberately not here

No AI or LLM anywhere. No external analytics. No subscriptions, billing,
multi-tenancy, CRM or mobile app. The parser and normalizer are deterministic:
the same file always yields the same result, which is what makes an import
auditable.

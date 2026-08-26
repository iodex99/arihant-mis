# MIS Specification

Reverse-engineered from `Monthly_Arihant_lookers_Studio-MIS.pdf` (3 pages) and
`Arihant.xlsx`. This is the contract the MIS engine (`src/lib/mis/`) implements.

## 1. Canonical fact grain

Everything the MIS computes derives from one tidy fact table, `FactEntry`:

```
FactEntry = (periodId, branchId, streamId, accountId, kind, amount)
```

* `kind` is `REVENUE` or `EXPENSE`.
* `amount` is a signed `Decimal(18,4)`. Negative values are legitimate
  (provision reversals, contra allocations) and are never filtered out.
* One `Main data` row expands into **55 facts**: 2 revenue accounts
  (`Sales`, `Other Income`) + 53 expense heads.
* The supplied workbook therefore yields **253 x 55 = 13,915** fact rows.

Subtotal columns from the source (`Total Income`, `Total Revenue`,
`Total Expense`, `Profit`, `Indirect Expenses`) are **not** ingested as facts.
They are stored on the source row and used only for reconciliation (§7).

## 2. Period model

Indian financial year, April to March.

| Derived field | Rule |
|---|---|
| `month` | `1..12` calendar month parsed from the source month token |
| `year` | calendar year |
| `quarter` | Apr–Jun = `Q1`, Jul–Sep = `Q2`, Oct–Dec = `Q3`, Jan–Mar = `Q4` |
| `financialYear` | month >= April: `FY <year>-<year+1 mod 100>`; else `FY <year-1>-<year mod 100>` |
| `label` | source token preserved verbatim, e.g. `Oct'25` |
| `sortKey` | `year * 100 + month`, for chronological ordering |

Quarter is **derived**, then cross-checked against the source quarter column.
Disagreement raises a `QUARTER_MISMATCH` warning naming both values; it does not
block the import. For the supplied workbook, derived and source quarters agree
(`Oct'25` and `Nov'25` both to `Q3`, FY 2025-26).

## 3. Core measures

For any filter scope `S`:

```
revenue(S)  = SUM(amount) WHERE kind = REVENUE
expense(S)  = SUM(amount) WHERE kind = EXPENSE
profit(S)   = revenue(S) - expense(S)
margin(S)   = revenue(S) = 0 ? null : profit(S) / revenue(S)
```

`margin` is **null**, not zero, when revenue is zero. Seventeen branches in the
supplied data are cost-only; showing them at "0 %" would rank them alongside
genuinely break-even branches. The UI renders null margin as an em dash with a
"no revenue" tooltip.

Expected values for the unfiltered supplied dataset:

| Measure | Value |
|---|---|
| revenue | 81,576,200.57 |
| expense | 61,030,802.65 |
| profit | 20,545,397.92 |
| margin | 0.251855 (25.19 %) |

## 4. Report A — Stream profitability

Group by `stream`. Columns: `Stream`, `Revenue`, `Expense`, `Profit`,
`Profit Margin`. Default sort: `Profit` descending — this reproduces the PDF's
row order (Science, Commerce, SSC, ICSE, CBSE, GMS).

Streams with no activity (GMS: all zeros) are retained, not hidden.

## 5. Report B — Branch profitability

Group by **`branch.abbreviation`**, not by branch label. The PDF groups this way
and the two are not 1:1 (see data-dictionary §2.5); grouping by label produces
a different, non-matching table.

Columns: `Branch`, `Revenue`, `Expense`, `Profit`, `Expense Ratio`, `Expense %`,
`Profit Margin`.

The PDF's `Expense Ratio` and `Expense %` columns are, despite their names, both
the **profit margin** — verified against every one of the 24 ranked rows
(e.g. CKP: `4,731,040.14 / 7,458,555.16` = `0.63` and `63.43 %`). We keep the
familiar column headings for continuity but additionally expose a genuine
`Expense Ratio = expense / revenue`, labelled distinctly, because that is what a
reader expects the column to mean.

Default sort: `Profit Margin` descending, matching the PDF.

## 6. Report C/D — Expense and Group analysis

* **Expense analysis** groups by `account` (the 53 expense heads).
* **Group analysis** groups by `account.groupHead` (the 10 group heads plus
  `Unclassified`).

Columns: `Category`, `Amount`, `% of Revenue`.

### Percentage-of-revenue semantics

```
pctOfRevenue = amount / revenue(S)
```

Revenue here is the revenue of the **same filter scope**, counted once per
branch-period. The previous Looker report divided by a revenue figure repeated
once per expense-head row, which is why its percentages are lower; see
data-dictionary §5 for the arithmetic and the proof.

A "Looker-compatible" toggle was considered and **deliberately not built**. The
old denominator cannot be reproduced faithfully, because it was computed over
the stale `Comparison` sheet, which covers only one of the two months and drops
₹6.55 L of expense into `#N/A` and `null` groups. A toggle would therefore
match neither the correct figure nor the historical one, which is worse than
having no toggle at all.

Instead, the change is made legible: the `% of Revenue` column carries an
inline explanation, and this document plus data-dictionary §5 record the
old and new figures side by side for the changeover.

Note the same `Total Amount` reconciles exactly in both systems — only the
denominator differed. Amounts were never wrong; percentages were.

## 7. Reconciliation

Run after every import and every sync. Four checks, each with a Rs 0.05 tolerance
scaled by row count:

| Check | Assertion |
|---|---|
| `PROFIT_IDENTITY` | `revenue - expense = profit` (source `Profit` column) |
| `REVENUE_COMPONENTS` | `SUM(revenue accounts) = source Total Revenue` |
| `EXPENSE_COMPONENTS` | `SUM(expense accounts) = source Total Expense` |
| `SUBTOTAL_AGREEMENT` | source `Indirect Expenses = Total Expense` |

Plus dimensional roll-up checks: the sum over branches, over streams and over
months must each equal the grand total.

A failing check sets the import's status to `NEEDS_REVIEW` and surfaces the
signed difference. Imports are **never** silently accepted with a broken
identity.

## 8. Comparison analysis (PDF page 3)

Per-branch expense-group intensity: for each branch abbreviation and each of the
10 group heads, `groupAmount / branchRevenue`.

The PDF renders this as a matrix with branches as columns and groups as rows,
plus a trailing profit-margin row. We reproduce the same matrix with branches as
rows (readable at any branch count) and offer a transpose control.

Note the PDF's `Director Remuneration, Depreciation & Income Tax Provision %`
row shows an identical `-38.03 %` for every branch. That is because those heads
sit in `Unallocated Expense` and are booked centrally, so Looker divides a
single company-wide figure by each branch's revenue slice. We label this row
**"Unallocated (company-wide)"** and show it once rather than repeating a
misleading per-branch figure.

## 9. Filters

Shared across dashboard, tabular MIS and exports:

| Filter | Source |
|---|---|
| Financial Year | derived period |
| Month | derived period (multi-select) |
| Quarter | derived period |
| Centre | dimension |
| Branch | dimension (by abbreviation) |
| Stream | dimension |
| Expense Group | account group head |
| Expense Head | account |
| Status | branch status (`Operating`, `Close`, ...) |

All filters are applied server-side in SQL. Filter state lives in the URL query
string so a filtered view is shareable and survives reload.

## 10. Drill-down

Supported path, limited to what the source actually contains:

```
Branch  ->  Expense Group  ->  Expense Head  ->  originating import row
```

The final level links to the raw `ImportRow` (sheet, row number, full original
cell values) — the true provenance of the number. **Voucher-level drill-down is
not implemented** because `Main data` is pre-aggregated and contains no voucher
data. The UI states this explicitly at the leaf rather than showing an empty
table. When a Tally sync supplies voucher data, the same drill component gains a
fifth level with no schema change.

## 11. Number formatting

| Context | Format |
|---|---|
| KPI cards | Indian short scale: `Rs 8.16 Cr`, `Rs 14.84 L`, `Rs 45.20 K` |
| Tables | full precision, Indian digit grouping: `Rs 81,576,200.57` |
| Percentages | 2 decimals: `25.19 %` |
| Negative | parenthesised and colour-coded: `(Rs 4,34,190.00)` |

Amounts are stored as `Decimal(18,4)` and formatted only at the presentation
layer. Currency is a per-company setting defaulting to `INR`; no currency symbol
is ever stored in a numeric column.

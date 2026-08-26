# The Universal Importer

The importer never assumes a fixed column layout. It reads a file into a neutral
grid, then reasons about that grid: where the table starts, what each column
means, which rows are aggregates, and whether the figures add up.

Everything is deterministic. No AI, no LLM, no external service — the parser is
pure code, and the same file always produces the same result.

```
file  ──▶  read  ──▶  find header  ──▶  profile columns  ──▶  map to fields
                                                                    │
        reconcile  ◀──  normalize  ◀──  detect subtotals  ◀─────────┘
             │
             ▼
        preview  ──(operator confirms)──▶  import
```

---

## 1. Reading (`readers.ts`)

`.xlsx` via ExcelJS, `.csv`/`.tsv` via Papa Parse with delimiter auto-detection.
Both produce the same `RawGrid`, so nothing downstream knows the format.

Legacy `.xls` is rejected with an instruction ("Save As .xlsx"), not a stack
trace — ExcelJS cannot read the BIFF compound-document format.

Two ExcelJS behaviours had to be handled to read the client's workbook at all:

* **A formula cell whose cached value is zero arrives with no `result` key.**
  Left alone it stringifies to `"[object Object]"`, which makes the whole column
  read as text — silently dropping `Total Income`, `Total Expense` and `Profit`.
  Verified against the raw sheet XML (`<f .../><v>0</v>`), so a formula cell with
  no result is read as zero.
* **A string-typed formula result is coerced through the cell's number format**,
  yielding `Invalid Date` (or `NaN`). An Invalid Date is neither blank nor
  parseable, so the column profiles as text and its dimension is lost. Where the
  file is a Google Sheets export, the true value is repeated verbatim as the
  `IFERROR(__xludf.DUMMYFUNCTION(...), <value>)` fallback and is recovered from
  the formula; otherwise the cell becomes null.

## 2. Finding the header (`structure.ts`)

Row 1 is not assumed. Each of the first 30 rows is scored on five signals:

| Signal | Weight | Why |
|---|---|---|
| Density across its own span | 0.22 | A header fills its row; a title occupies one cell |
| Text ratio | 0.24 | Headers are labels, not numbers |
| Uniqueness | 0.18 | Headers do not repeat |
| Label length | 0.10 | Headers are short, not sentences |
| **Contrast with the rows beneath** | 0.26 | The decisive one: data rows are more numeric than their header and keep filling the same span |

The best-scoring row wins if it clears 0.45; blank rows between it and the first
data row are skipped. This is what puts the client's `Group head` sheet at
row 2 and handles title/subtitle/preamble blocks generally.

## 3. Profiling columns

Each column is profiled **from its values only** — header text is not consulted
here. The profile records how many values look numeric, percentage-shaped,
date-shaped, month-token-shaped (`Oct'25`), quarter-shaped (`Q3`) or
financial-year-shaped (`FY 2025-26`), plus distinct count, sum, min/max, negative
count and samples.

A column is classified by whichever shape dominates, checking the specific token
shapes before the generic ones.

## 4. Value coercion (`values.ts`)

Every routine is pure and total — it returns null rather than throwing, so one
malformed cell can never abort an import.

`parseNumber` handles: currency symbols (`₹`, `Rs.`, `INR`), Western *and* Indian
digit grouping (`1,234,567.89` and `12,34,567.89`), parenthesised negatives,
trailing `CR`/`DR`, percentages, and Excel error tokens (`#N/A`, `#REF!`).

`parseMonthToken` handles `Oct'25`, `Oct-25`, `October 2025`, `2025-10`,
`10/2025` and real dates. Two-digit years resolve to 2000–2099 rather than being
inferred from the current date, so an import is reproducible.

`parseDate` reads `dd/mm/yyyy` as the Indian convention, which is what Tally
exports, and also handles `dd-MMM-yyyy` and Excel serials.

## 5. Mapping columns (`mapping.ts` + `dictionary.ts`)

Confidence combines two independent lines of evidence:

```
header evidence  — exact match, then fuzzy match against known synonyms
value evidence   — do the values actually contain what the field needs
```

**Value evidence can override header evidence.** This is the single most
important decision in the parser, and the reason it reads the client's workbook
correctly: their `Quater` column holds `Oct'25` and their `Month` column holds
`Q3`. A header-only parser silently swaps the two dimensions. Here the
month-token signal is decisive, the mapping is correct, and a
`HEADER_VALUE_MISMATCH` warning names both readings so the operator knows the
source file is mislabelled.

Fields are assigned globally one-to-one, best claim first, so two columns cannot
both claim `revenue`.

### Measure fields require an exact header match

`revenue`, `expense`, `profit`, `amount` and the two subtotal fields are marked
`strictHeader`. Substring matching is disabled for them, because a wide financial
sheet has dozens of account columns whose names embed those words —
`CSR EXPENDITURE`, `ADVERTISEMENT EXPENSE - OUTDOOR`,
`MEMBERSHIP & SUBSCRIPTION EXPENS`. Without this, each of those is claimed as
the sheet's total column and the real totals are lost.

Fuzzy matching is capped: `headerSimilarity` returns 0 beyond an edit distance of
6, because the early-exit distance would otherwise inflate similarity for long
strings (`FINANCIAL YEAR` vs `PROFESSIONAL CHARGES TEACHERS` scored 0.76 before
that guard). It still catches real typos — `Quater` matches `QUARTER` at 86%.

### Wide vs long layouts

* **Wide** — many unclaimed numeric columns, each an account head. The client's
  `Main data` is this shape: 55 account columns.
* **Long** — an account-name column paired with a single amount column. Revenue
  is repeated on every account row in this shape and is deduplicated per
  (period, branch, stream), or the total multiplies by the head count.

Unclaimed numeric columns in a wide sheet become account heads. Revenue-side
heads are recognised from a short known list; everything else is an expense,
matching how these workbooks are built.

## 6. Subtotals (`subtotals.ts`)

A column is a subtotal when it is *arithmetically* the sum or difference of other
columns — **not** when its header says "Total". Getting this wrong corrupts the
MIS in either direction:

```
ingesting a subtotal as a fact  ->  every amount double-counted
ingesting a fact as a subtotal  ->  that account silently vanishes
```

Header names are unreliable for this. The client's workbook has a `Total` column
that is entirely empty, and a `Total Amount` column that is the real measure of
its sheet.

Three relations are tested, then verified row by row over up to 200 rows:

| Relation | Example found in the real workbook |
|---|---|
| **sum** of a contiguous block | `Indirect Expenses` = the 53 columns that follow it |
| **difference** of two columns | `Profit` = `Total Income` − `Total Expense` |
| **duplicate** of a known subtotal | `Total Expense` repeats `Indirect Expenses` |

Subtraction is symmetric, so every verified sum produces spurious difference
findings for its own parts: given `Total Income = Sales + Other Income`, it is
equally true that `Sales = Total Income − Other Income`. Acting on that would
mark `Sales` a subtotal and **drop all revenue**. So a column that participates
in a verified sum is a component, and a component is never a total.

Verified subtotals are kept for reconciliation and excluded from the facts.

## 7. Total rows

A row is an aggregate when a dimension cell carries a total label (`Grand Total`,
`Subtotal`, `Overall Total`, …) or when its dimension cells are empty while its
measures are not — the shape a trailing grand-total row takes. Those rows are
excluded from the facts and used to validate the totals instead.

## 8. Sheet roles

A workbook usually holds one authoritative sheet plus derived views of it.
Importing the derived ones as well would double-count, so each sheet is
classified:

| Role | Meaning |
|---|---|
| `FACTS` | The primary sheet — the one covering the most periods, then the most account columns, then the most rows |
| `MAPPING` | A reference sheet (account → group) with no measures |
| `DERIVED` | A subset or rollup of the fact sheet |
| `SKIPPED` | Empty, or no header could be found |

In the client's workbook this correctly picks `Main data` (2 periods, 55 account
columns) over `Branch Data` and `Comparison`, which are stale Oct-only rollups.
The reason is shown in the preview, not just the verdict.

## 9. Normalization

Facts are emitted at one grain: `(period, branch, stream, account, kind, amount)`.
One wide row with 55 account columns becomes up to 55 facts.

* **Branches are keyed on their code**, because that is the reporting key and it
  is not one-to-one with the branch name. When a sheet has a code column but a
  row leaves it blank, all such rows form one `Unassigned` branch — falling back
  to the label would split them.
* **Zero amounts create no fact**, keeping the fact table proportional to real
  activity, but **every account column is registered as a dimension member**
  regardless, so a head that is zero this period still appears in the group
  analysis and can be pre-mapped.
* **Negative amounts are kept.** Provision reversals and contra allocations are
  legitimate; dropping them changes the client's total expense by ₹1.64 Cr.
* **Quarter and financial year are derived** from the month, then cross-checked
  against the source's own quarter column, with a `QUARTER_MISMATCH` warning on
  disagreement.

## 10. Reconciliation

See [`mis-specification.md`](./mis-specification.md) §7. An import that does not
reconcile is marked `NEEDS_REVIEW` with the signed difference and the offending
rows named. It is never silently accepted.

## 11. Preview and confirmation

Analysis writes nothing. The operator sees every sheet role and why, every column
mapping with its confidence and the reasons behind it, the detected subtotals and
total rows, the resulting totals, and every reconciliation check — then confirms.

Any column below 80% confidence blocks the import until it is confirmed or
corrected. Overriding a mapping re-runs the whole analysis, so the totals shown
always match what would be imported.

## 12. Saved mappings

On confirmation the mapping can be remembered as a `MappingProfile`, fingerprinted
by the normalized header sets of its sheets. A later upload is compared against
saved profiles and the best match above 60% similarity is reported in the preview.
A materially different structure creates a new version rather than overwriting
the old one.

## 13. What the parser will not do

* **Guess at an ambiguous column.** Below the confidence threshold it stops and
  asks.
* **Silently drop a row.** Every skipped row is counted, reported and reasoned.
* **Accept figures that do not reconcile** without an explicit acknowledgement.
* **Invent data.** Fields the source does not contain stay null — see
  [`data-dictionary.md`](./data-dictionary.md) §7.

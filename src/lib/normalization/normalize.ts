/**
 * Normalization — analyzed sheets become canonical facts.
 *
 * Pure and database-free so it can be tested against the real workbook without
 * a server. `persistImport` (src/lib/import/persist.ts) writes the result.
 */

import { isBlank, normalizeAccountName, parseNumber } from '../parser/values';
import { resolvePeriod, type NormalizedPeriod } from './periods';
import type { ParseWarning, SheetAnalysis, WorkbookAnalysis } from '../parser/types';

export const UNCLASSIFIED_GROUP = 'Unclassified';
/** Branch label used when a source row carries no branch at all. */
export const UNASSIGNED_BRANCH = 'Unassigned';

export interface NormalizedFact {
  /** Index into `rows`, for provenance. */
  rowRef: number;
  periodKey: string;
  branchKey: string;
  streamKey: string;
  centreKey: string | null;
  accountKey: string;
  accountName: string;
  kind: 'REVENUE' | 'EXPENSE';
  amount: number;
}

export interface NormalizedRow {
  /** 1-based row number in the source sheet. */
  rowNumber: number;
  sheetName: string;
  raw: Record<string, unknown>;
  periodKey: string;
  branchKey: string;
  streamKey: string;
  centreKey: string | null;
  /** Source subtotals, kept for reconciliation. */
  reported: {
    revenue: number | null;
    expense: number | null;
    profit: number | null;
    totalRevenue: number | null;
    indirectExpenses: number | null;
  };
}

export interface NormalizedDimensions {
  periods: Map<string, NormalizedPeriod>;
  branches: Map<string, { abbreviation: string; name: string; centreKey: string | null; status: string | null }>;
  streams: Map<string, { name: string }>;
  centres: Map<string, { name: string }>;
  accounts: Map<string, { name: string; kind: 'REVENUE' | 'EXPENSE'; groupHead: string; groupMapped: boolean; sortOrder: number }>;
}

export interface NormalizationResult {
  dimensions: NormalizedDimensions;
  rows: NormalizedRow[];
  facts: NormalizedFact[];
  /** Expense head -> group head, from any MAPPING sheet in the workbook. */
  accountGroups: Map<string, string>;
  warnings: ParseWarning[];
  skipped: { rowNumber: number; sheetName: string; reason: string }[];
}

export interface NormalizeOptions {
  /** Admin overrides applied on top of the workbook's own mapping sheet. */
  accountGroupOverrides?: Map<string, string>;
}

export function normalizeWorkbook(
  analysis: WorkbookAnalysis,
  grids: Map<number, unknown[][]>,
  options: NormalizeOptions = {},
): NormalizationResult {
  const warnings: ParseWarning[] = [];
  const skipped: NormalizationResult['skipped'] = [];

  // Mapping sheets first — fact sheets need the account→group lookup.
  const accountGroups = new Map<string, string>();
  for (const sheet of analysis.sheets) {
    if (sheet.role !== 'MAPPING') continue;
    collectAccountGroups(sheet, grids.get(sheet.sheetIndex) ?? [], accountGroups);
  }
  if (options.accountGroupOverrides) {
    for (const [k, v] of options.accountGroupOverrides) accountGroups.set(k, v);
  }

  const dimensions: NormalizedDimensions = {
    periods: new Map(),
    branches: new Map(),
    streams: new Map(),
    centres: new Map(),
    accounts: new Map(),
  };

  const rows: NormalizedRow[] = [];
  const facts: NormalizedFact[] = [];
  const quarterMismatches = new Map<string, { source: string; derived: string; count: number }>();

  for (const sheet of analysis.sheets) {
    if (sheet.role !== 'FACTS') continue;
    const grid = grids.get(sheet.sheetIndex) ?? [];

    normalizeFactSheet(sheet, grid, {
      dimensions,
      rows,
      facts,
      accountGroups,
      skipped,
      quarterMismatches,
    });
  }

  for (const [key, mm] of quarterMismatches) {
    warnings.push({
      code: 'QUARTER_MISMATCH',
      severity: 'warning',
      message: `Period "${key}" is labelled ${mm.source} in the source but falls in ${mm.derived} of the Indian financial year (April–March). ${mm.derived} was used.`,
      remedy: 'Check the source file if this is unexpected; the reported figures are unaffected.',
      context: { period: key, sourceQuarter: mm.source, derivedQuarter: mm.derived, rows: mm.count },
    });
  }

  const unmapped = [...dimensions.accounts.values()].filter(
    (a) => a.kind === 'EXPENSE' && !a.groupMapped,
  );
  if (unmapped.length > 0) {
    warnings.push({
      code: 'UNMAPPED_ACCOUNT',
      severity: 'warning',
      message: `${unmapped.length} expense head${unmapped.length === 1 ? ' has' : 's have'} no group mapping and ${unmapped.length === 1 ? 'was' : 'were'} placed under "${UNCLASSIFIED_GROUP}": ${unmapped.map((a) => a.name).join(', ')}.`,
      remedy: `Totals are unaffected — nothing is dropped. Assign ${unmapped.length === 1 ? 'it' : 'them'} to a group in Admin → Mappings so the group analysis is complete.`,
      context: { accounts: unmapped.map((a) => a.name) },
    });
  }

  if (skipped.length > 0) {
    warnings.push({
      code: 'ROWS_SKIPPED',
      severity: 'warning',
      message: `${skipped.length} row${skipped.length === 1 ? '' : 's'} could not be normalized and ${skipped.length === 1 ? 'was' : 'were'} excluded.`,
      remedy: 'Review the skipped rows listed in the import detail; each names the reason.',
      context: { rows: skipped.slice(0, 50) },
    });
  }

  return { dimensions, rows, facts, accountGroups, warnings, skipped };
}

function collectAccountGroups(
  sheet: SheetAnalysis,
  grid: unknown[][],
  into: Map<string, string>,
): void {
  const accountCol = sheet.mappings.find((m) => m.field === 'account')?.columnIndex;
  const groupCol = sheet.mappings.find((m) => m.field === 'groupHead')?.columnIndex;
  if (accountCol === undefined || groupCol === undefined) return;

  const start = (sheet.dataStartRow ?? 2) - 1;
  for (let i = start; i < grid.length; i++) {
    const row = grid[i];
    if (!row) continue;
    const account = row[accountCol];
    const group = row[groupCol];
    if (isBlank(account) || isBlank(group)) continue;

    const groupName = String(group).trim();
    // Spreadsheet lookup errors must not become group names.
    if (/^#(N\/A|REF!|VALUE!|NAME\?|DIV\/0!)$/i.test(groupName)) continue;

    into.set(normalizeAccountName(account), groupName);
  }
}

interface SheetContext {
  dimensions: NormalizedDimensions;
  rows: NormalizedRow[];
  facts: NormalizedFact[];
  accountGroups: Map<string, string>;
  skipped: NormalizationResult['skipped'];
  quarterMismatches: Map<string, { source: string; derived: string; count: number }>;
}

function normalizeFactSheet(sheet: SheetAnalysis, grid: unknown[][], ctx: SheetContext): void {
  const col = (field: string) => sheet.mappings.find((m) => m.field === field)?.columnIndex;

  const idx = {
    stream: col('stream'),
    branch: col('branch'),
    abbreviation: col('abbreviation'),
    centre: col('centre'),
    month: col('month'),
    quarter: col('quarter'),
    financialYear: col('financialYear'),
    status: col('status'),
    account: col('account'),
    amount: col('amount'),
    groupHead: col('groupHead'),
    revenue: col('revenue'),
    expense: col('expense'),
    profit: col('profit'),
    totalRevenue: col('totalRevenue'),
    indirectExpenses: col('indirectExpenses'),
  };

  const accountColumns = sheet.mappings.filter((m) => m.role === 'account-measure');
  const totalRows = new Set(sheet.totalRowNumbers);
  const start = (sheet.dataStartRow ?? 2) - 1;

  // In a LONG sheet, revenue is repeated on every account row; count it once
  // per (period, branch, stream) or the total multiplies by the head count.
  const seenLongRevenue = new Set<string>();

  for (let i = start; i < grid.length; i++) {
    const rowNumber = i + 1;
    const row = grid[i];
    if (!row || row.every((c) => isBlank(c))) continue;
    if (totalRows.has(rowNumber)) continue;

    const resolution = resolvePeriod(
      idx.month === undefined ? null : row[idx.month],
      idx.quarter === undefined ? undefined : row[idx.quarter],
      idx.financialYear === undefined ? undefined : row[idx.financialYear],
    );

    if (!resolution.period) {
      ctx.skipped.push({ rowNumber, sheetName: sheet.name, reason: resolution.error ?? 'unreadable period' });
      continue;
    }

    const period = resolution.period;
    const periodKey = `${period.year}-${String(period.month).padStart(2, '0')}`;
    if (!ctx.dimensions.periods.has(periodKey)) ctx.dimensions.periods.set(periodKey, period);

    if (resolution.quarterMismatch) {
      const existing = ctx.quarterMismatches.get(period.label);
      if (existing) existing.count++;
      else ctx.quarterMismatches.set(period.label, { ...resolution.quarterMismatch, count: 1 });
    }

    // --- dimensions ---
    const centreName = idx.centre === undefined ? null : cleanText(row[idx.centre]);
    const centreKey = centreName ? normalizeAccountName(centreName) : null;
    if (centreKey && !ctx.dimensions.centres.has(centreKey)) {
      ctx.dimensions.centres.set(centreKey, { name: centreName! });
    }

    const branchName = idx.branch === undefined ? null : cleanText(row[idx.branch]);
    const abbrRaw = idx.abbreviation === undefined ? null : cleanText(row[idx.abbreviation]);

    // Branches are keyed on abbreviation, because that is the reporting key and
    // it is not 1:1 with the branch label (docs/data-dictionary.md §2.5).
    //
    // When the sheet has an abbreviation column but this row leaves it blank,
    // all such rows form one "Unassigned" branch — falling back to the label
    // would split them, and the reference report treats them as a single line.
    // When there is no abbreviation column at all, the label is the key.
    const hasAbbrColumn = idx.abbreviation !== undefined;
    const abbreviation = abbrRaw ?? (hasAbbrColumn ? UNASSIGNED_BRANCH : (branchName ?? UNASSIGNED_BRANCH));
    const branchKey = normalizeAccountName(abbreviation);

    if (!ctx.dimensions.branches.has(branchKey)) {
      ctx.dimensions.branches.set(branchKey, {
        abbreviation,
        name:
          abbreviation === UNASSIGNED_BRANCH
            ? 'Unassigned (no branch code in source)'
            : (branchName ?? abbreviation),
        centreKey,
        status: idx.status === undefined ? null : cleanText(row[idx.status]),
      });
    }

    const streamName = idx.stream === undefined ? null : cleanText(row[idx.stream]);
    const streamKey = normalizeAccountName(streamName ?? 'Unspecified');
    if (!ctx.dimensions.streams.has(streamKey)) {
      ctx.dimensions.streams.set(streamKey, { name: streamName ?? 'Unspecified' });
    }

    const rowRef = ctx.rows.length;
    ctx.rows.push({
      rowNumber,
      sheetName: sheet.name,
      raw: buildRaw(sheet, row),
      periodKey,
      branchKey,
      streamKey,
      centreKey,
      reported: {
        revenue: numberAt(row, idx.revenue),
        expense: numberAt(row, idx.expense),
        profit: numberAt(row, idx.profit),
        totalRevenue: numberAt(row, idx.totalRevenue),
        indirectExpenses: numberAt(row, idx.indirectExpenses),
      },
    });

    // --- facts ---
    if (sheet.layout === 'LONG' && idx.account !== undefined) {
      emitLongFacts(row, idx, rowRef, { periodKey, branchKey, streamKey, centreKey }, sheet, ctx, seenLongRevenue);
    } else {
      emitWideFacts(row, accountColumns, rowRef, { periodKey, branchKey, streamKey, centreKey }, ctx);
      // A wide sheet with no per-account revenue column still reports revenue
      // as a single measure (e.g. the "Branch Data" layout).
      emitFallbackMeasures(row, idx, accountColumns, rowRef, { periodKey, branchKey, streamKey, centreKey }, ctx);
    }
  }
}

interface RowKeys {
  periodKey: string;
  branchKey: string;
  streamKey: string;
  centreKey: string | null;
}

function emitWideFacts(
  row: unknown[],
  accountColumns: { columnIndex: number; accountName?: string; accountKind?: 'REVENUE' | 'EXPENSE' }[],
  rowRef: number,
  keys: RowKeys,
  ctx: SheetContext,
): void {
  for (const acc of accountColumns) {
    const amount = parseNumber(row[acc.columnIndex] ?? null);
    // A blank cell is "no entry"; a zero is a real zero. Neither creates a
    // fact, but both are legitimate — only non-zero amounts are stored, which
    // keeps the fact table proportional to actual activity.
    if (amount === null || amount === 0) continue;

    const name = acc.accountName ?? 'Unknown';
    const kind = acc.accountKind ?? 'EXPENSE';
    const accountKey = registerAccount(ctx, name, kind);

    ctx.facts.push({
      rowRef,
      ...keys,
      accountKey,
      accountName: name,
      kind,
      amount,
    });
  }
}

function emitLongFacts(
  row: unknown[],
  idx: Record<string, number | undefined>,
  rowRef: number,
  keys: RowKeys,
  sheet: SheetAnalysis,
  ctx: SheetContext,
  seenRevenue: Set<string>,
): void {
  const accountName = idx.account === undefined ? null : cleanText(row[idx.account]);
  const amount = numberAt(row, idx.amount) ?? numberAt(row, idx.expense);

  if (accountName && amount !== null && amount !== 0) {
    const groupFromRow = idx.groupHead === undefined ? null : cleanText(row[idx.groupHead]);
    const accountKey = registerAccount(ctx, accountName, 'EXPENSE', groupFromRow);
    ctx.facts.push({ rowRef, ...keys, accountKey, accountName, kind: 'EXPENSE', amount });
  }

  // Revenue is denormalised across the account rows of a long sheet.
  const revenue = numberAt(row, idx.revenue) ?? numberAt(row, idx.totalRevenue);
  if (revenue !== null && revenue !== 0) {
    const dedupeKey = `${keys.periodKey}|${keys.branchKey}|${keys.streamKey}`;
    if (!seenRevenue.has(dedupeKey)) {
      seenRevenue.add(dedupeKey);
      const accountKey = registerAccount(ctx, 'Revenue', 'REVENUE');
      ctx.facts.push({ rowRef, ...keys, accountKey, accountName: 'Revenue', kind: 'REVENUE', amount: revenue });
    }
  }
}

/**
 * Emit revenue/expense from the summary columns when the sheet has no
 * per-account breakdown for that side. Skipped when account columns already
 * cover it, which would double-count.
 */
function emitFallbackMeasures(
  row: unknown[],
  idx: Record<string, number | undefined>,
  accountColumns: { accountKind?: 'REVENUE' | 'EXPENSE' }[],
  rowRef: number,
  keys: RowKeys,
  ctx: SheetContext,
): void {
  const hasRevenueAccounts = accountColumns.some((a) => a.accountKind === 'REVENUE');
  const hasExpenseAccounts = accountColumns.some((a) => a.accountKind === 'EXPENSE');

  if (!hasRevenueAccounts) {
    const revenue = numberAt(row, idx.revenue) ?? numberAt(row, idx.totalRevenue);
    if (revenue !== null && revenue !== 0) {
      const accountKey = registerAccount(ctx, 'Revenue', 'REVENUE');
      ctx.facts.push({ rowRef, ...keys, accountKey, accountName: 'Revenue', kind: 'REVENUE', amount: revenue });
    }
  }

  if (!hasExpenseAccounts) {
    const expense = numberAt(row, idx.expense) ?? numberAt(row, idx.indirectExpenses);
    if (expense !== null && expense !== 0) {
      const accountKey = registerAccount(ctx, 'Expense', 'EXPENSE');
      ctx.facts.push({ rowRef, ...keys, accountKey, accountName: 'Expense', kind: 'EXPENSE', amount: expense });
    }
  }
}

function registerAccount(
  ctx: SheetContext,
  name: string,
  kind: 'REVENUE' | 'EXPENSE',
  groupFromRow?: string | null,
): string {
  const key = normalizeAccountName(name);
  const existing = ctx.dimensions.accounts.get(key);
  if (existing) return key;

  const mapped = ctx.accountGroups.get(key) ?? (groupFromRow || null);
  const groupHead =
    kind === 'REVENUE'
      ? 'Revenue'
      : mapped && !/^#(N\/A|REF!|VALUE!)$/i.test(mapped)
        ? mapped.trim()
        : UNCLASSIFIED_GROUP;

  ctx.dimensions.accounts.set(key, {
    name: name.trim(),
    kind,
    groupHead,
    groupMapped: kind === 'REVENUE' || Boolean(mapped),
    sortOrder: ctx.dimensions.accounts.size,
  });

  return key;
}

function buildRaw(sheet: SheetAnalysis, row: unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  sheet.headers.forEach((h, c) => {
    const v = row[c];
    if (!isBlank(v)) out[h] = v instanceof Date ? v.toISOString() : v;
  });
  return out;
}

function numberAt(row: unknown[], index: number | undefined): number | null {
  if (index === undefined) return null;
  return parseNumber(row[index] ?? null);
}

function cleanText(value: unknown): string | null {
  if (isBlank(value)) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

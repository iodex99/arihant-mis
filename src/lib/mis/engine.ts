/**
 * MIS calculation layer.
 *
 * All financial logic lives here, never in React components (build spec §40).
 * Every function aggregates in the database and returns small, already-computed
 * result sets.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import {
  buildExpenseWhere,
  buildFactWhere,
  buildRevenueWhere,
  type MisFilters,
} from './filters';

export interface Kpis {
  revenue: number;
  expense: number;
  profit: number;
  /** null when revenue is zero — not the same as a 0 % margin. */
  margin: number | null;
  expenseRatio: number | null;
}

export interface DimensionRow {
  key: string;
  label: string;
  revenue: number;
  expense: number;
  profit: number;
  margin: number | null;
  expenseRatio: number | null;
  /** Share of total expense, for composition charts. */
  shareOfExpense: number | null;
}

export interface CategoryRow {
  key: string;
  label: string;
  amount: number;
  pctOfRevenue: number | null;
  shareOfExpense: number | null;
}

export interface TrendPoint {
  periodLabel: string;
  sortKey: number;
  financialYear: string;
  quarter: string;
  revenue: number;
  expense: number;
  profit: number;
  margin: number | null;
}

const dec = (v: Prisma.Decimal | null | undefined): number => (v ? Number(v) : 0);

function ratios(revenue: number, expense: number) {
  const profit = revenue - expense;
  return {
    revenue,
    expense,
    profit,
    margin: revenue === 0 ? null : profit / revenue,
    expenseRatio: revenue === 0 ? null : expense / revenue,
  };
}

// ---------------------------------------------------------------------------
// Headline KPIs
// ---------------------------------------------------------------------------

export async function getKpis(companyId: string, filters: MisFilters): Promise<Kpis> {
  const [revenueAgg, expenseAgg] = await Promise.all([
    prisma.factEntry.aggregate({ where: buildRevenueWhere(companyId, filters), _sum: { amount: true } }),
    prisma.factEntry.aggregate({ where: buildExpenseWhere(companyId, filters), _sum: { amount: true } }),
  ]);

  return ratios(dec(revenueAgg._sum.amount), dec(expenseAgg._sum.amount));
}

// ---------------------------------------------------------------------------
// Dimension breakdowns (stream, branch, centre)
// ---------------------------------------------------------------------------

type DimensionName = 'stream' | 'branch' | 'centre';

/**
 * Revenue and expense per dimension member.
 *
 * Done as two grouped queries plus a label lookup rather than a join-per-row.
 * Revenue deliberately ignores expense-side filters (see buildRevenueWhere).
 */
export async function getByDimension(
  companyId: string,
  filters: MisFilters,
  dimension: DimensionName,
): Promise<DimensionRow[]> {
  const idField = `${dimension}Id` as 'streamId' | 'branchId' | 'centreId';

  const [revenueRows, expenseRows] = await Promise.all([
    prisma.factEntry.groupBy({
      by: [idField],
      where: buildRevenueWhere(companyId, filters),
      _sum: { amount: true },
    }),
    prisma.factEntry.groupBy({
      by: [idField],
      where: buildExpenseWhere(companyId, filters),
      _sum: { amount: true },
    }),
  ]);

  const ids = new Set<string>();
  for (const r of [...revenueRows, ...expenseRows]) {
    const id = r[idField];
    if (id) ids.add(id);
  }

  // Include members with no activity in scope. A stream or branch that traded
  // nothing this period is a real, reportable zero — dropping it makes the
  // rows silently disagree with the dimension list and hides dormant branches
  // that still carry cost.
  for (const id of await memberIdsInScope(companyId, filters, dimension)) ids.add(id);

  const labels = await loadLabels(dimension, [...ids]);

  const revenueById = new Map(revenueRows.map((r) => [r[idField] ?? '', dec(r._sum.amount)]));
  const expenseById = new Map(expenseRows.map((r) => [r[idField] ?? '', dec(r._sum.amount)]));

  const totalExpense = [...expenseById.values()].reduce((s, v) => s + v, 0);

  const rows: DimensionRow[] = [...ids].map((id) => {
    const revenue = revenueById.get(id) ?? 0;
    const expense = expenseById.get(id) ?? 0;
    return {
      key: labels.get(id)?.key ?? id,
      label: labels.get(id)?.label ?? 'Unknown',
      ...ratios(revenue, expense),
      shareOfExpense: totalExpense === 0 ? null : expense / totalExpense,
    };
  });

  // Unassigned facts (a null centre) still hold money; surface them rather
  // than letting the rows silently fail to add up to the grand total.
  const nullRevenue = revenueById.get('') ?? 0;
  const nullExpense = expenseById.get('') ?? 0;
  if (nullRevenue !== 0 || nullExpense !== 0) {
    rows.push({
      key: '__unassigned__',
      label: 'Unassigned',
      ...ratios(nullRevenue, nullExpense),
      shareOfExpense: totalExpense === 0 ? null : nullExpense / totalExpense,
    });
  }

  return rows.sort((a, b) => b.profit - a.profit);
}

/**
 * All members of a dimension that the current filters permit. When a filter
 * names specific members, only those are listed — selecting one branch should
 * not repopulate the table with every other branch at zero.
 */
async function memberIdsInScope(
  companyId: string,
  filters: MisFilters,
  dimension: DimensionName,
): Promise<string[]> {
  if (dimension === 'branch') {
    const rows = await prisma.branch.findMany({
      where: {
        companyId,
        ...(filters.branches?.length ? { abbreviation: { in: filters.branches } } : {}),
        ...(filters.statuses?.length ? { status: { in: filters.statuses } } : {}),
        ...(filters.centres?.length ? { centre: { name: { in: filters.centres } } } : {}),
      },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  if (dimension === 'stream') {
    const rows = await prisma.stream.findMany({
      where: { companyId, ...(filters.streams?.length ? { name: { in: filters.streams } } : {}) },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  const rows = await prisma.centre.findMany({
    where: { companyId, ...(filters.centres?.length ? { name: { in: filters.centres } } : {}) },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

async function loadLabels(
  dimension: DimensionName,
  ids: string[],
): Promise<Map<string, { key: string; label: string }>> {
  const out = new Map<string, { key: string; label: string }>();
  if (ids.length === 0) return out;

  if (dimension === 'branch') {
    const rows = await prisma.branch.findMany({
      where: { id: { in: ids } },
      select: { id: true, abbreviation: true, name: true },
    });
    // Branches are reported by abbreviation (docs/data-dictionary.md §2.5).
    for (const r of rows) out.set(r.id, { key: r.abbreviation, label: r.abbreviation });
    return out;
  }

  const rows =
    dimension === 'stream'
      ? await prisma.stream.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
      : await prisma.centre.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });

  for (const r of rows) out.set(r.id, { key: r.name, label: r.name });
  return out;
}

/** Branch rows carry the source branch name alongside the abbreviation. */
export async function getBranchDetail(
  companyId: string,
  filters: MisFilters,
): Promise<(DimensionRow & { name: string; centre: string | null; status: string | null })[]> {
  const rows = await getByDimension(companyId, filters, 'branch');
  const branches = await prisma.branch.findMany({
    where: { companyId },
    select: { abbreviation: true, name: true, status: true, centre: { select: { name: true } } },
  });
  const byAbbr = new Map(branches.map((b) => [b.abbreviation, b]));

  return rows.map((r) => {
    const b = byAbbr.get(r.key);
    return { ...r, name: b?.name ?? r.label, centre: b?.centre?.name ?? null, status: b?.status ?? null };
  });
}

// ---------------------------------------------------------------------------
// Expense / group analysis
// ---------------------------------------------------------------------------

/**
 * Expense by account or by group head.
 *
 * `pctOfRevenue` divides by the revenue of the same filter scope. The previous
 * Looker report divided by a revenue figure that was repeated once per
 * expense-head row, which is why its percentages differ; see
 * docs/data-dictionary.md §5 for the reconciliation.
 */
export async function getExpenseAnalysis(
  companyId: string,
  filters: MisFilters,
  groupBy: 'account' | 'group',
): Promise<CategoryRow[]> {
  const where = buildExpenseWhere(companyId, filters);

  const rows = await prisma.factEntry.groupBy({
    by: ['accountId'],
    where,
    _sum: { amount: true },
  });

  const accounts = await prisma.account.findMany({
    where: { id: { in: rows.map((r) => r.accountId) } },
    select: { id: true, name: true, groupHead: true },
  });
  const byId = new Map(accounts.map((a) => [a.id, a]));

  const buckets = new Map<string, number>();
  for (const r of rows) {
    const a = byId.get(r.accountId);
    if (!a) continue;
    const key = groupBy === 'account' ? a.name : a.groupHead;
    buckets.set(key, (buckets.get(key) ?? 0) + dec(r._sum.amount));
  }

  const revenue = (await getKpis(companyId, filters)).revenue;
  const totalExpense = [...buckets.values()].reduce((s, v) => s + v, 0);

  return [...buckets.entries()]
    .map(([key, amount]) => {
      return {
        key,
        label: key,
        amount,
        pctOfRevenue: revenue === 0 ? null : amount / revenue,
        shareOfExpense: totalExpense === 0 ? null : amount / totalExpense,
      };
    })
    .sort((a, b) => b.amount - a.amount);
}

// ---------------------------------------------------------------------------
// Trends
// ---------------------------------------------------------------------------

export async function getTrend(companyId: string, filters: MisFilters): Promise<TrendPoint[]> {
  const [revenueRows, expenseRows] = await Promise.all([
    prisma.factEntry.groupBy({ by: ['periodId'], where: buildRevenueWhere(companyId, filters), _sum: { amount: true } }),
    prisma.factEntry.groupBy({ by: ['periodId'], where: buildExpenseWhere(companyId, filters), _sum: { amount: true } }),
  ]);

  const ids = [...new Set([...revenueRows, ...expenseRows].map((r) => r.periodId))];
  const periods = await prisma.period.findMany({
    where: { id: { in: ids } },
    select: { id: true, label: true, sortKey: true, financialYear: true, quarter: true },
  });

  const revenueById = new Map(revenueRows.map((r) => [r.periodId, dec(r._sum.amount)]));
  const expenseById = new Map(expenseRows.map((r) => [r.periodId, dec(r._sum.amount)]));

  return periods
    .map((p) => {
      const revenue = revenueById.get(p.id) ?? 0;
      const expense = expenseById.get(p.id) ?? 0;
      const { profit, margin } = ratios(revenue, expense);
      return {
        periodLabel: p.label,
        sortKey: p.sortKey,
        financialYear: p.financialYear,
        quarter: p.quarter,
        revenue,
        expense,
        profit,
        margin,
      };
    })
    .sort((a, b) => a.sortKey - b.sortKey);
}

/** Expense trend split by group head, for the stacked area chart. */
export async function getExpenseTrend(
  companyId: string,
  filters: MisFilters,
): Promise<{ periods: string[]; groups: string[]; series: Record<string, number>[] }> {
  const rows = await prisma.factEntry.groupBy({
    by: ['periodId', 'accountId'],
    where: buildExpenseWhere(companyId, filters),
    _sum: { amount: true },
  });

  const [periods, accounts] = await Promise.all([
    prisma.period.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.periodId))] } },
      select: { id: true, label: true, sortKey: true },
      orderBy: { sortKey: 'asc' },
    }),
    prisma.account.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.accountId))] } },
      select: { id: true, groupHead: true },
    }),
  ]);

  const groupById = new Map(accounts.map((a) => [a.id, a.groupHead]));
  const cell = new Map<string, number>();
  const groupTotals = new Map<string, number>();

  for (const r of rows) {
    const group = groupById.get(r.accountId) ?? 'Unclassified';
    const amount = dec(r._sum.amount);
    cell.set(`${r.periodId}|${group}`, (cell.get(`${r.periodId}|${group}`) ?? 0) + amount);
    groupTotals.set(group, (groupTotals.get(group) ?? 0) + amount);
  }

  // Largest groups first so the stack reads top-down by significance.
  const groups = [...groupTotals.entries()]
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .map(([g]) => g);

  const series = periods.map((p) => {
    const row: Record<string, number> = {};
    for (const g of groups) row[g] = cell.get(`${p.id}|${g}`) ?? 0;
    return { period: p.label, ...row } as unknown as Record<string, number>;
  });

  return { periods: periods.map((p) => p.label), groups, series };
}

// ---------------------------------------------------------------------------
// Comparison matrix (PDF page 3)
// ---------------------------------------------------------------------------

export interface ComparisonMatrix {
  branches: { key: string; revenue: number; margin: number | null }[];
  groups: string[];
  /** cells[branchKey][group] = group spend as a share of that branch's revenue. */
  cells: Record<string, Record<string, number | null>>;
  /** Groups booked centrally, which have no meaningful per-branch ratio. */
  unallocatedGroups: string[];
}

export async function getComparisonMatrix(
  companyId: string,
  filters: MisFilters,
): Promise<ComparisonMatrix> {
  const rows = await prisma.factEntry.groupBy({
    by: ['branchId', 'accountId'],
    where: buildExpenseWhere(companyId, filters),
    _sum: { amount: true },
  });

  const [branches, accounts] = await Promise.all([
    prisma.branch.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.branchId))] } },
      select: { id: true, abbreviation: true },
    }),
    prisma.account.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.accountId))] } },
      select: { id: true, groupHead: true },
    }),
  ]);

  const abbrById = new Map(branches.map((b) => [b.id, b.abbreviation]));
  const groupById = new Map(accounts.map((a) => [a.id, a.groupHead]));

  const branchRows = await getByDimension(companyId, filters, 'branch');
  const revenueByBranch = new Map(branchRows.map((b) => [b.key, b.revenue]));

  // Sum the amounts first, then divide once. Dividing per row and trying to
  // recover the running total from the ratio breaks whenever revenue is zero.
  const amounts = new Map<string, number>();
  const groupSet = new Set<string>();

  for (const r of rows) {
    const abbr = abbrById.get(r.branchId);
    if (!abbr) continue;
    const group = groupById.get(r.accountId) ?? 'Unclassified';
    groupSet.add(group);
    const key = `${abbr}|${group}`;
    amounts.set(key, (amounts.get(key) ?? 0) + dec(r._sum.amount));
  }

  const cells: Record<string, Record<string, number | null>> = {};
  for (const [key, amount] of amounts) {
    const [abbr, group] = key.split('|');
    const revenue = revenueByBranch.get(abbr) ?? 0;
    cells[abbr] ??= {};
    cells[abbr][group] = revenue === 0 ? null : amount / revenue;
  }

  // A group booked once company-wide produces an identical, meaningless ratio
  // for every branch — the reference report's repeated "-38.03%" row. Flag it
  // instead of repeating it (docs/mis-specification.md §8).
  const unallocatedGroups = [...groupSet].filter((g) => /unallocated/i.test(g));

  return {
    branches: branchRows.map((b) => ({ key: b.key, revenue: b.revenue, margin: b.margin })),
    groups: [...groupSet].sort(),
    cells,
    unallocatedGroups,
  };
}

// ---------------------------------------------------------------------------
// Filter option lists
// ---------------------------------------------------------------------------

export interface FilterOptions {
  financialYears: string[];
  months: { label: string; sortKey: number; financialYear: string; quarter: string }[];
  quarters: string[];
  centres: string[];
  branches: { abbreviation: string; name: string }[];
  streams: string[];
  groups: string[];
  accounts: string[];
  statuses: string[];
}

export async function getFilterOptions(companyId: string): Promise<FilterOptions> {
  const [periods, centres, branches, streams, accounts] = await Promise.all([
    prisma.period.findMany({
      where: { companyId },
      select: { label: true, sortKey: true, financialYear: true, quarter: true },
      orderBy: { sortKey: 'asc' },
    }),
    prisma.centre.findMany({ where: { companyId }, select: { name: true }, orderBy: { name: 'asc' } }),
    prisma.branch.findMany({
      where: { companyId },
      select: { abbreviation: true, name: true, status: true },
      orderBy: { abbreviation: 'asc' },
    }),
    prisma.stream.findMany({ where: { companyId }, select: { name: true }, orderBy: { name: 'asc' } }),
    prisma.account.findMany({
      where: { companyId, kind: 'EXPENSE' },
      select: { name: true, groupHead: true },
      orderBy: { name: 'asc' },
    }),
  ]);

  return {
    financialYears: [...new Set(periods.map((p) => p.financialYear))].sort().reverse(),
    months: periods.map((p) => ({ label: p.label, sortKey: p.sortKey, financialYear: p.financialYear, quarter: p.quarter })),
    quarters: [...new Set(periods.map((p) => p.quarter))].sort(),
    centres: centres.map((c) => c.name),
    branches: branches.map((b) => ({ abbreviation: b.abbreviation, name: b.name })),
    streams: streams.map((s) => s.name),
    groups: [...new Set(accounts.map((a) => a.groupHead))].sort(),
    accounts: accounts.map((a) => a.name),
    statuses: [...new Set(branches.map((b) => b.status).filter((s): s is string => Boolean(s)))].sort(),
  };
}

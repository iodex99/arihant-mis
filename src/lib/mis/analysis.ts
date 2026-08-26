/**
 * Analytical reports.
 *
 * These go beyond "what are the totals" to "what changed, where is the money
 * concentrated, and which parts of the business behave differently from the
 * rest". Everything is still aggregated in SQL and returns small result sets.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { buildExpenseWhere, buildFactWhere, buildRevenueWhere, type MisFilters } from './filters';

const dec = (v: Prisma.Decimal | null | undefined): number => (v ? Number(v) : 0);

/**
 * Groups booked centrally rather than per branch. Their movements swamp a
 * variance report and distort a like-for-like comparison, so every report here
 * separates them out rather than letting them silently dominate.
 */
export function isUnallocated(groupHead: string): boolean {
  return /unallocated/i.test(groupHead);
}

// ---------------------------------------------------------------------------
// Period-over-period variance
// ---------------------------------------------------------------------------

export interface VarianceLine {
  key: string;
  label: string;
  from: number;
  to: number;
  change: number;
  /** null when `from` is zero — a percentage change from nothing is undefined. */
  changePct: number | null;
  unallocated?: boolean;
}

export interface VarianceReport {
  available: boolean;
  reason?: string;
  fromPeriod: string;
  toPeriod: string;
  revenue: { from: number; to: number; change: number };
  expense: { from: number; to: number; change: number };
  profit: { from: number; to: number; change: number };
  /**
   * Expense excluding centrally-booked groups, which is the comparable figure.
   */
  operatingExpense: { from: number; to: number; change: number };
  operatingProfit: { from: number; to: number; change: number };
  byAccount: VarianceLine[];
  byBranch: VarianceLine[];
  byStream: VarianceLine[];
  /** Set when unallocated movements dominate the headline change. */
  distortion: {
    amount: number;
    groups: string[];
    note: string;
  } | null;
}

/** Compare the two most recent periods in scope. */
export async function getVariance(companyId: string, filters: MisFilters): Promise<VarianceReport> {
  const periods = await prisma.period.findMany({
    where: {
      companyId,
      ...(filters.financialYear ? { financialYear: filters.financialYear } : {}),
      ...(filters.quarter ? { quarter: filters.quarter } : {}),
      ...(filters.months?.length ? { label: { in: filters.months } } : {}),
    },
    orderBy: { sortKey: 'desc' },
    take: 2,
    select: { id: true, label: true },
  });

  const empty: VarianceReport = {
    available: false,
    fromPeriod: '',
    toPeriod: '',
    revenue: { from: 0, to: 0, change: 0 },
    expense: { from: 0, to: 0, change: 0 },
    profit: { from: 0, to: 0, change: 0 },
    operatingExpense: { from: 0, to: 0, change: 0 },
    operatingProfit: { from: 0, to: 0, change: 0 },
    byAccount: [],
    byBranch: [],
    byStream: [],
    distortion: null,
  };

  if (periods.length < 2) {
    return {
      ...empty,
      reason:
        periods.length === 0
          ? 'No periods match the current filters.'
          : 'Only one period is in scope, so there is nothing to compare it against. Widen the month filter.',
    };
  }

  // `periods` is newest-first.
  const [to, from] = periods;

  const facts = await prisma.factEntry.findMany({
    where: { ...buildFactWhere(companyId, filters), periodId: { in: [from.id, to.id] } },
    select: {
      periodId: true,
      kind: true,
      amount: true,
      account: { select: { name: true, groupHead: true } },
      branch: { select: { abbreviation: true } },
      stream: { select: { name: true } },
    },
  });

  const totals = {
    revenue: { from: 0, to: 0 },
    expense: { from: 0, to: 0 },
    unallocatedExpense: { from: 0, to: 0 },
  };

  const accounts = new Map<string, { from: number; to: number; unallocated: boolean }>();
  const branches = new Map<string, { from: number; to: number }>();
  const streams = new Map<string, { from: number; to: number }>();
  const unallocatedGroups = new Set<string>();

  for (const f of facts) {
    const side = f.periodId === from.id ? 'from' : 'to';
    const amount = dec(f.amount);

    if (f.kind === 'REVENUE') {
      totals.revenue[side] += amount;
    } else {
      totals.expense[side] += amount;
      if (isUnallocated(f.account.groupHead)) {
        totals.unallocatedExpense[side] += amount;
        unallocatedGroups.add(f.account.groupHead);
      }

      const acc = accounts.get(f.account.name) ?? { from: 0, to: 0, unallocated: isUnallocated(f.account.groupHead) };
      acc[side] += amount;
      accounts.set(f.account.name, acc);
    }

    // Branch and stream lines are profit movements, so revenue counts positive
    // and expense negative.
    const signed = f.kind === 'REVENUE' ? amount : -amount;

    const br = branches.get(f.branch.abbreviation) ?? { from: 0, to: 0 };
    br[side] += signed;
    branches.set(f.branch.abbreviation, br);

    const st = streams.get(f.stream.name) ?? { from: 0, to: 0 };
    st[side] += signed;
    streams.set(f.stream.name, st);
  }

  const line = (key: string, v: { from: number; to: number }, unallocated?: boolean): VarianceLine => ({
    key,
    label: key,
    from: v.from,
    to: v.to,
    change: v.to - v.from,
    changePct: v.from === 0 ? null : (v.to - v.from) / Math.abs(v.from),
    unallocated,
  });

  const operatingFrom = totals.expense.from - totals.unallocatedExpense.from;
  const operatingTo = totals.expense.to - totals.unallocatedExpense.to;

  const unallocatedSwing = totals.unallocatedExpense.to - totals.unallocatedExpense.from;
  const headlineSwing = totals.expense.to - totals.expense.from;

  // Flag when the centrally-booked groups account for most of the headline
  // movement — otherwise the report invites a wrong conclusion.
  const distortion =
    Math.abs(unallocatedSwing) > 0 && Math.abs(unallocatedSwing) >= Math.abs(headlineSwing) * 0.5
      ? {
          amount: unallocatedSwing,
          groups: [...unallocatedGroups].sort(),
          note:
            `${formatSigned(unallocatedSwing)} of the ${formatSigned(headlineSwing)} expense movement comes from ` +
            `${[...unallocatedGroups].join(', ')}, which ${unallocatedGroups.size === 1 ? 'is' : 'are'} booked centrally rather than by branch. ` +
            `Comparing the two months on operating expense alone gives ${formatSigned(operatingTo - operatingFrom)}.`,
        }
      : null;

  return {
    available: true,
    fromPeriod: from.label,
    toPeriod: to.label,
    revenue: { from: totals.revenue.from, to: totals.revenue.to, change: totals.revenue.to - totals.revenue.from },
    expense: { from: totals.expense.from, to: totals.expense.to, change: headlineSwing },
    profit: {
      from: totals.revenue.from - totals.expense.from,
      to: totals.revenue.to - totals.expense.to,
      change: totals.revenue.to - totals.expense.to - (totals.revenue.from - totals.expense.from),
    },
    operatingExpense: { from: operatingFrom, to: operatingTo, change: operatingTo - operatingFrom },
    operatingProfit: {
      from: totals.revenue.from - operatingFrom,
      to: totals.revenue.to - operatingTo,
      change: totals.revenue.to - operatingTo - (totals.revenue.from - operatingFrom),
    },
    byAccount: [...accounts.entries()]
      .map(([k, v]) => line(k, v, v.unallocated))
      .filter((l) => l.change !== 0)
      .sort((a, b) => Math.abs(b.change) - Math.abs(a.change)),
    byBranch: [...branches.entries()]
      .map(([k, v]) => line(k, v))
      .filter((l) => l.change !== 0)
      .sort((a, b) => a.change - b.change),
    byStream: [...streams.entries()]
      .map(([k, v]) => line(k, v))
      .sort((a, b) => a.change - b.change),
    distortion,
  };
}

function formatSigned(n: number): string {
  const abs = Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 0 });
  return `${n < 0 ? '-' : '+'}Rs ${abs}`;
}

// ---------------------------------------------------------------------------
// Concentration (Pareto)
// ---------------------------------------------------------------------------

export interface ConcentrationEntry {
  key: string;
  value: number;
  share: number;
  cumulativeShare: number;
}

export interface ConcentrationReport {
  metric: 'revenue' | 'profit';
  total: number;
  entries: ConcentrationEntry[];
  /** How many members make up 80 % of the total. */
  countTo80: number;
  totalCount: number;
  /** Share held by the top 5. */
  top5Share: number;
  /** Excluded because they are negative and have no share of a positive whole. */
  negativeCount: number;
  negativeTotal: number;
}

/**
 * How concentrated revenue or profit is across branches.
 *
 * Negative members are reported separately rather than mixed in: a loss has no
 * meaningful "share" of a positive total, and including it makes the cumulative
 * curve exceed 100 % and then come back down.
 */
export async function getConcentration(
  companyId: string,
  filters: MisFilters,
  metric: 'revenue' | 'profit' = 'profit',
): Promise<ConcentrationReport> {
  const [revenueRows, expenseRows] = await Promise.all([
    prisma.factEntry.groupBy({ by: ['branchId'], where: buildRevenueWhere(companyId, filters), _sum: { amount: true } }),
    prisma.factEntry.groupBy({ by: ['branchId'], where: buildExpenseWhere(companyId, filters), _sum: { amount: true } }),
  ]);

  const ids = [...new Set([...revenueRows, ...expenseRows].map((r) => r.branchId))];
  const branches = await prisma.branch.findMany({
    where: { id: { in: ids } },
    select: { id: true, abbreviation: true },
  });
  const abbr = new Map(branches.map((b) => [b.id, b.abbreviation]));

  const revenueById = new Map(revenueRows.map((r) => [r.branchId, dec(r._sum.amount)]));
  const expenseById = new Map(expenseRows.map((r) => [r.branchId, dec(r._sum.amount)]));

  const values = ids.map((id) => ({
    key: abbr.get(id) ?? 'Unknown',
    value:
      metric === 'revenue'
        ? (revenueById.get(id) ?? 0)
        : (revenueById.get(id) ?? 0) - (expenseById.get(id) ?? 0),
  }));

  const positive = values.filter((v) => v.value > 0).sort((a, b) => b.value - a.value);
  const negatives = values.filter((v) => v.value < 0);

  const total = positive.reduce((s, v) => s + v.value, 0);

  let running = 0;
  const entries: ConcentrationEntry[] = positive.map((v) => {
    running += v.value;
    return {
      key: v.key,
      value: v.value,
      share: total === 0 ? 0 : v.value / total,
      cumulativeShare: total === 0 ? 0 : running / total,
    };
  });

  const countTo80 = entries.findIndex((e) => e.cumulativeShare >= 0.8) + 1;

  return {
    metric,
    total,
    entries,
    countTo80: countTo80 === 0 ? entries.length : countTo80,
    totalCount: entries.length,
    top5Share: entries.slice(0, 5).reduce((s, e) => s + e.share, 0),
    negativeCount: negatives.length,
    negativeTotal: negatives.reduce((s, v) => s + v.value, 0),
  };
}

// ---------------------------------------------------------------------------
// Stream x Branch matrix
// ---------------------------------------------------------------------------

export interface CrossTab {
  rows: string[];
  columns: string[];
  /** cells[row][column] — absent when that combination has no activity. */
  cells: Record<string, Record<string, { revenue: number; expense: number; profit: number; margin: number | null }>>;
  rowTotals: Record<string, { revenue: number; profit: number; margin: number | null }>;
  columnTotals: Record<string, { revenue: number; profit: number; margin: number | null }>;
  populated: number;
  possible: number;
}

/** Revenue and margin for every branch/stream combination that trades. */
export async function getStreamBranchMatrix(companyId: string, filters: MisFilters): Promise<CrossTab> {
  const facts = await prisma.factEntry.groupBy({
    by: ['branchId', 'streamId', 'kind'],
    where: buildFactWhere(companyId, filters),
    _sum: { amount: true },
  });

  const [branches, streams] = await Promise.all([
    prisma.branch.findMany({
      where: { id: { in: [...new Set(facts.map((f) => f.branchId))] } },
      select: { id: true, abbreviation: true },
    }),
    prisma.stream.findMany({
      where: { id: { in: [...new Set(facts.map((f) => f.streamId))] } },
      select: { id: true, name: true },
    }),
  ]);

  const branchName = new Map(branches.map((b) => [b.id, b.abbreviation]));
  const streamName = new Map(streams.map((s) => [s.id, s.name]));

  const cells: CrossTab['cells'] = {};
  const rowAgg = new Map<string, { revenue: number; expense: number }>();
  const colAgg = new Map<string, { revenue: number; expense: number }>();

  for (const f of facts) {
    const branch = branchName.get(f.branchId);
    const stream = streamName.get(f.streamId);
    if (!branch || !stream) continue;

    const amount = dec(f._sum.amount);
    cells[branch] ??= {};
    cells[branch][stream] ??= { revenue: 0, expense: 0, profit: 0, margin: null };

    if (f.kind === 'REVENUE') cells[branch][stream].revenue += amount;
    else cells[branch][stream].expense += amount;

    const r = rowAgg.get(branch) ?? { revenue: 0, expense: 0 };
    const c = colAgg.get(stream) ?? { revenue: 0, expense: 0 };
    if (f.kind === 'REVENUE') { r.revenue += amount; c.revenue += amount; }
    else { r.expense += amount; c.expense += amount; }
    rowAgg.set(branch, r);
    colAgg.set(stream, c);
  }

  let populated = 0;
  for (const branch of Object.keys(cells)) {
    for (const stream of Object.keys(cells[branch])) {
      const cell = cells[branch][stream];
      cell.profit = cell.revenue - cell.expense;
      cell.margin = cell.revenue === 0 ? null : cell.profit / cell.revenue;
      if (cell.revenue !== 0 || cell.expense !== 0) populated++;
    }
  }

  const summarise = (m: Map<string, { revenue: number; expense: number }>) =>
    Object.fromEntries(
      [...m.entries()].map(([k, v]) => [
        k,
        {
          revenue: v.revenue,
          profit: v.revenue - v.expense,
          margin: v.revenue === 0 ? null : (v.revenue - v.expense) / v.revenue,
        },
      ]),
    );

  // Rows ordered by revenue, so the matrix reads top-down by significance.
  const rows = [...rowAgg.entries()].sort((a, b) => b[1].revenue - a[1].revenue).map(([k]) => k);
  const columns = [...colAgg.entries()].sort((a, b) => b[1].revenue - a[1].revenue).map(([k]) => k);

  return {
    rows,
    columns,
    cells,
    rowTotals: summarise(rowAgg),
    columnTotals: summarise(colAgg),
    populated,
    possible: rows.length * columns.length,
  };
}

// ---------------------------------------------------------------------------
// Cost structure
// ---------------------------------------------------------------------------

export interface CostStructureRow {
  key: string;
  revenue: number;
  total: number;
  /** group head -> amount */
  groups: Record<string, number>;
  /** group head -> share of that branch's own expense */
  shares: Record<string, number | null>;
}

export interface CostStructureReport {
  groups: string[];
  branches: CostStructureRow[];
  /** Company-wide totals, for the composition chart and the benchmark. */
  overall: { groups: Record<string, number>; total: number; revenue: number };
  /** Median share per group across branches with revenue — the benchmark line. */
  median: Record<string, number>;
}

/**
 * How each branch's cost is composed, and how that compares with the median.
 * Centrally-booked groups are excluded from the per-branch view, because
 * attributing one company-wide figure across branches invents a pattern.
 */
export async function getCostStructure(companyId: string, filters: MisFilters): Promise<CostStructureReport> {
  const rows = await prisma.factEntry.groupBy({
    by: ['branchId', 'accountId'],
    where: buildExpenseWhere(companyId, filters),
    _sum: { amount: true },
  });

  const revenueRows = await prisma.factEntry.groupBy({
    by: ['branchId'],
    where: buildRevenueWhere(companyId, filters),
    _sum: { amount: true },
  });

  const [branches, accounts] = await Promise.all([
    prisma.branch.findMany({
      where: { id: { in: [...new Set([...rows, ...revenueRows].map((r) => r.branchId))] } },
      select: { id: true, abbreviation: true },
    }),
    prisma.account.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.accountId))] } },
      select: { id: true, groupHead: true },
    }),
  ]);

  const abbr = new Map(branches.map((b) => [b.id, b.abbreviation]));
  const groupOf = new Map(accounts.map((a) => [a.id, a.groupHead]));
  // Keyed by abbreviation, since that is what the rows below are keyed on.
  const revenueByBranch = new Map(
    revenueRows.map((r) => [abbr.get(r.branchId) ?? '', dec(r._sum.amount)]),
  );

  const byBranch = new Map<string, Record<string, number>>();
  const overallGroups: Record<string, number> = {};
  const groupSet = new Set<string>();

  for (const r of rows) {
    const branch = abbr.get(r.branchId);
    const group = groupOf.get(r.accountId) ?? 'Unclassified';
    if (!branch) continue;

    const amount = dec(r._sum.amount);
    overallGroups[group] = (overallGroups[group] ?? 0) + amount;
    groupSet.add(group);

    if (isUnallocated(group)) continue; // company-wide; not a branch's structure

    const rec = byBranch.get(branch) ?? {};
    rec[group] = (rec[group] ?? 0) + amount;
    byBranch.set(branch, rec);
  }

  const perBranchGroups = [...groupSet].filter((g) => !isUnallocated(g)).sort();

  const branchRows: CostStructureRow[] = [...byBranch.entries()]
    .map(([key, groups]) => {
      const total = Object.values(groups).reduce((s, v) => s + v, 0);
      const shares: Record<string, number | null> = {};
      for (const g of perBranchGroups) {
        shares[g] = total === 0 ? null : (groups[g] ?? 0) / total;
      }
      return { key, revenue: revenueByBranch.get(key) ?? 0, total, groups, shares };
    })
    .sort((a, b) => b.total - a.total);

  // Median share per group, across branches that actually trade.
  const trading = branchRows.filter((b) => b.revenue > 0 && b.total > 0);
  const median: Record<string, number> = {};
  for (const g of perBranchGroups) {
    const values = trading.map((b) => b.shares[g] ?? 0).sort((a, b) => a - b);
    median[g] = values.length === 0 ? 0 : values[Math.floor(values.length / 2)];
  }

  const overallTotal = Object.values(overallGroups).reduce((s, v) => s + v, 0);
  const overallRevenue = [...revenueByBranch.values()].reduce((s, v) => s + v, 0);

  return {
    groups: perBranchGroups,
    branches: branchRows,
    overall: { groups: overallGroups, total: overallTotal, revenue: overallRevenue },
    median,
  };
}

// ---------------------------------------------------------------------------
// Scale vs efficiency
// ---------------------------------------------------------------------------

export interface PositionPoint {
  key: string;
  revenue: number;
  expense: number;
  profit: number;
  margin: number;
  /** Quadrant against the company medians. */
  quadrant: 'scale-and-margin' | 'scale-low-margin' | 'small-high-margin' | 'small-low-margin';
}

export interface PositioningReport {
  points: PositionPoint[];
  medianRevenue: number;
  medianMargin: number;
  excludedNoRevenue: number;
}

/**
 * Branch position on revenue against margin.
 *
 * Split at the medians rather than at zero or an arbitrary target: the useful
 * question is which branches are unlike their peers, and the peer group is the
 * rest of Arihant.
 */
export async function getBranchPositioning(companyId: string, filters: MisFilters): Promise<PositioningReport> {
  const [revenueRows, expenseRows] = await Promise.all([
    prisma.factEntry.groupBy({ by: ['branchId'], where: buildRevenueWhere(companyId, filters), _sum: { amount: true } }),
    prisma.factEntry.groupBy({ by: ['branchId'], where: buildExpenseWhere(companyId, filters), _sum: { amount: true } }),
  ]);

  const ids = [...new Set([...revenueRows, ...expenseRows].map((r) => r.branchId))];
  const branches = await prisma.branch.findMany({
    where: { id: { in: ids } },
    select: { id: true, abbreviation: true },
  });
  const abbr = new Map(branches.map((b) => [b.id, b.abbreviation]));
  const revenueById = new Map(revenueRows.map((r) => [r.branchId, dec(r._sum.amount)]));
  const expenseById = new Map(expenseRows.map((r) => [r.branchId, dec(r._sum.amount)]));

  const withRevenue = ids
    .map((id) => {
      const revenue = revenueById.get(id) ?? 0;
      const expense = expenseById.get(id) ?? 0;
      return { key: abbr.get(id) ?? 'Unknown', revenue, expense, profit: revenue - expense };
    })
    .filter((p) => p.revenue > 0);

  const excludedNoRevenue = ids.length - withRevenue.length;

  const medianOf = (values: number[]) => {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  };

  const medianRevenue = medianOf(withRevenue.map((p) => p.revenue));
  const medianMargin = medianOf(withRevenue.map((p) => p.profit / p.revenue));

  const points: PositionPoint[] = withRevenue.map((p) => {
    const margin = p.profit / p.revenue;
    const big = p.revenue >= medianRevenue;
    const good = margin >= medianMargin;
    return {
      ...p,
      margin,
      quadrant: big
        ? good ? 'scale-and-margin' : 'scale-low-margin'
        : good ? 'small-high-margin' : 'small-low-margin',
    };
  });

  return {
    points: points.sort((a, b) => b.revenue - a.revenue),
    medianRevenue,
    medianMargin,
    excludedNoRevenue,
  };
}

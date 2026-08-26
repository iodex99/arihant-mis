/**
 * Drill-down.
 *
 * Branch -> Expense Group -> Expense Head -> originating source row.
 *
 * The final level is the raw import row, which is the real provenance of the
 * number. Voucher-level detail is deliberately absent: the workbook is
 * pre-aggregated and contains none, and inventing it would be worse than
 * saying so (build spec §13).
 */

import { prisma } from '../db';
import { buildExpenseWhere, buildFactWhere, type MisFilters } from './filters';
import { getKpis } from './engine';

export type DrillLevel = 'branch' | 'group' | 'account' | 'source';

export interface DrillNode {
  key: string;
  label: string;
  amount: number;
  /** Share of the parent level's total. */
  share: number | null;
  /** False at the deepest level the source data supports. */
  drillable: boolean;
}

export interface DrillResult {
  level: DrillLevel;
  nextLevel: DrillLevel | null;
  path: { level: DrillLevel; key: string; label: string }[];
  header: {
    title: string;
    revenue: number;
    expense: number;
    profit: number;
    margin: number | null;
  };
  nodes: DrillNode[];
  /** Present at the leaf: why there is nothing deeper. */
  leafNote?: string;
}

export interface DrillQuery {
  branch?: string;
  group?: string;
  account?: string;
}

const NEXT: Record<DrillLevel, DrillLevel | null> = {
  branch: 'group',
  group: 'account',
  account: 'source',
  source: null,
};

export async function drill(
  companyId: string,
  filters: MisFilters,
  query: DrillQuery,
): Promise<DrillResult> {
  // Narrow the filters by the drill path, so the header KPIs match the level.
  const scoped: MisFilters = {
    ...filters,
    branches: query.branch ? [query.branch] : filters.branches,
    groups: query.group ? [query.group] : filters.groups,
    accounts: query.account ? [query.account] : filters.accounts,
  };

  const level: DrillLevel = query.account ? 'source' : query.group ? 'account' : query.branch ? 'group' : 'branch';

  const path: DrillResult['path'] = [];
  if (query.branch) path.push({ level: 'branch', key: query.branch, label: query.branch });
  if (query.group) path.push({ level: 'group', key: query.group, label: query.group });
  if (query.account) path.push({ level: 'account', key: query.account, label: query.account });

  const kpis = await getKpis(companyId, scoped);
  const header = {
    title: path.length > 0 ? path[path.length - 1].label : 'All branches',
    revenue: kpis.revenue,
    expense: kpis.expense,
    profit: kpis.profit,
    margin: kpis.margin,
  };

  if (level === 'source') {
    return {
      level,
      nextLevel: null,
      path,
      header,
      nodes: [],
      leafNote:
        'This is the deepest level the source data supports. The figures were imported pre-aggregated by branch, stream and month, so there are no individual vouchers behind them. Use "View source rows" to see the exact spreadsheet rows these amounts came from.',
    };
  }

  const nodes = await nodesForLevel(companyId, scoped, level);
  const total = nodes.reduce((s, n) => s + Math.abs(n.amount), 0);

  return {
    level,
    nextLevel: NEXT[level],
    path,
    header,
    nodes: nodes.map((n) => ({ ...n, share: total === 0 ? null : Math.abs(n.amount) / total })),
  };
}

async function nodesForLevel(
  companyId: string,
  filters: MisFilters,
  level: DrillLevel,
): Promise<Omit<DrillNode, 'share'>[]> {
  const where = buildExpenseWhere(companyId, filters);

  if (level === 'branch') {
    const rows = await prisma.factEntry.groupBy({ by: ['branchId'], where, _sum: { amount: true } });
    const branches = await prisma.branch.findMany({
      where: { id: { in: rows.map((r) => r.branchId) } },
      select: { id: true, abbreviation: true, name: true },
    });
    const byId = new Map(branches.map((b) => [b.id, b]));
    return rows
      .map((r) => ({
        key: byId.get(r.branchId)?.abbreviation ?? r.branchId,
        label: byId.get(r.branchId)?.name ?? 'Unknown',
        amount: Number(r._sum.amount ?? 0),
        drillable: true,
      }))
      .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
  }

  const rows = await prisma.factEntry.groupBy({ by: ['accountId'], where, _sum: { amount: true } });
  const accounts = await prisma.account.findMany({
    where: { id: { in: rows.map((r) => r.accountId) } },
    select: { id: true, name: true, groupHead: true },
  });
  const byId = new Map(accounts.map((a) => [a.id, a]));

  if (level === 'group') {
    const buckets = new Map<string, number>();
    for (const r of rows) {
      const g = byId.get(r.accountId)?.groupHead ?? 'Unclassified';
      buckets.set(g, (buckets.get(g) ?? 0) + Number(r._sum.amount ?? 0));
    }
    return [...buckets.entries()]
      .map(([key, amount]) => ({ key, label: key, amount, drillable: true }))
      .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
  }

  // level === 'account'
  return rows
    .map((r) => ({
      key: byId.get(r.accountId)?.name ?? r.accountId,
      label: byId.get(r.accountId)?.name ?? 'Unknown',
      amount: Number(r._sum.amount ?? 0),
      // Drillable only in the sense of showing provenance, not more detail.
      drillable: true,
    }))
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
}

export interface SourceRowRef {
  importId: string;
  filename: string;
  sheetName: string;
  rowNumber: number;
  amount: number;
  periodLabel: string;
  branch: string;
  stream: string;
  account: string;
  raw: Record<string, unknown>;
}

/** The exact source rows behind a filtered figure — the provenance leaf. */
export async function getSourceRows(
  companyId: string,
  filters: MisFilters,
  limit = 200,
): Promise<SourceRowRef[]> {
  const facts = await prisma.factEntry.findMany({
    where: buildFactWhere(companyId, filters),
    take: limit,
    orderBy: { amount: 'desc' },
    select: {
      amount: true,
      period: { select: { label: true } },
      branch: { select: { abbreviation: true } },
      stream: { select: { name: true } },
      account: { select: { name: true } },
      import: { select: { id: true, filename: true } },
      importRow: { select: { rowNumber: true, raw: true, sheet: { select: { name: true } } } },
    },
  });

  return facts
    .filter((f) => f.importRow !== null)
    .map((f) => ({
      importId: f.import?.id ?? '',
      filename: f.import?.filename ?? 'unknown',
      sheetName: f.importRow!.sheet.name,
      rowNumber: f.importRow!.rowNumber,
      amount: Number(f.amount),
      periodLabel: f.period.label,
      branch: f.branch.abbreviation,
      stream: f.stream.name,
      account: f.account.name,
      raw: (f.importRow!.raw ?? {}) as Record<string, unknown>,
    }));
}

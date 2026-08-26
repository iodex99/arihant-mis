/**
 * Global MIS filters.
 *
 * One filter object drives the dashboard, the tabular MIS, drill-down and
 * exports, so every surface always agrees. Filters are applied in SQL — the
 * browser never receives unfiltered rows (build spec §35).
 */

import { z } from 'zod';
import type { Prisma } from '@prisma/client';

export const filterSchema = z.object({
  financialYear: z.string().optional(),
  months: z.array(z.string()).optional(),
  quarter: z.string().optional(),
  centres: z.array(z.string()).optional(),
  branches: z.array(z.string()).optional(),
  streams: z.array(z.string()).optional(),
  groups: z.array(z.string()).optional(),
  accounts: z.array(z.string()).optional(),
  statuses: z.array(z.string()).optional(),
});

export type MisFilters = z.infer<typeof filterSchema>;

/** Parse filters out of a URL query string, ignoring anything unrecognised. */
export function parseFilters(params: URLSearchParams | Record<string, string | string[] | undefined>): MisFilters {
  const get = (key: string): string[] => {
    if (params instanceof URLSearchParams) return params.getAll(key).flatMap((v) => v.split(',')).filter(Boolean);
    const v = params[key];
    if (v === undefined) return [];
    return (Array.isArray(v) ? v : [v]).flatMap((x) => String(x).split(',')).filter(Boolean);
  };

  const single = (key: string): string | undefined => get(key)[0];

  return filterSchema.parse({
    financialYear: single('fy'),
    months: get('month'),
    quarter: single('quarter'),
    centres: get('centre'),
    branches: get('branch'),
    streams: get('stream'),
    groups: get('group'),
    accounts: get('account'),
    statuses: get('status'),
  });
}

/** Serialise filters back into a query string, omitting empties. */
export function serializeFilters(filters: MisFilters): string {
  const params = new URLSearchParams();
  if (filters.financialYear) params.set('fy', filters.financialYear);
  if (filters.quarter) params.set('quarter', filters.quarter);
  for (const [key, values] of [
    ['month', filters.months],
    ['centre', filters.centres],
    ['branch', filters.branches],
    ['stream', filters.streams],
    ['group', filters.groups],
    ['account', filters.accounts],
    ['status', filters.statuses],
  ] as const) {
    if (values && values.length > 0) params.set(key, values.join(','));
  }
  return params.toString();
}

/**
 * Build the Prisma `where` for FactEntry. Every branch of this is indexed —
 * see the `@@index` declarations on FactEntry in prisma/schema.prisma.
 */
export function buildFactWhere(companyId: string, filters: MisFilters): Prisma.FactEntryWhereInput {
  const where: Prisma.FactEntryWhereInput = { companyId };

  const period: Prisma.PeriodWhereInput = {};
  if (filters.financialYear) period.financialYear = filters.financialYear;
  if (filters.quarter) period.quarter = filters.quarter;
  if (filters.months?.length) period.label = { in: filters.months };
  if (Object.keys(period).length > 0) where.period = period;

  if (filters.branches?.length || filters.statuses?.length) {
    where.branch = {
      ...(filters.branches?.length ? { abbreviation: { in: filters.branches } } : {}),
      ...(filters.statuses?.length ? { status: { in: filters.statuses } } : {}),
    };
  }

  if (filters.streams?.length) where.stream = { name: { in: filters.streams } };
  if (filters.centres?.length) where.centre = { name: { in: filters.centres } };

  if (filters.groups?.length || filters.accounts?.length) {
    where.account = {
      ...(filters.groups?.length ? { groupHead: { in: filters.groups } } : {}),
      ...(filters.accounts?.length ? { name: { in: filters.accounts } } : {}),
    };
  }

  return where;
}

/**
 * Revenue must not be restricted by expense-side filters.
 *
 * Selecting "Rent Expense" should narrow the expense figures while leaving
 * revenue as the full revenue of the remaining scope — otherwise every
 * percentage-of-revenue is computed against zero and the report is nonsense.
 */
export function buildRevenueWhere(companyId: string, filters: MisFilters): Prisma.FactEntryWhereInput {
  const { groups: _groups, accounts: _accounts, ...rest } = filters;
  return { ...buildFactWhere(companyId, rest), kind: 'REVENUE' };
}

export function buildExpenseWhere(companyId: string, filters: MisFilters): Prisma.FactEntryWhereInput {
  return { ...buildFactWhere(companyId, filters), kind: 'EXPENSE' };
}

/** True when any filter is active, for empty-state messaging. */
export function hasActiveFilters(filters: MisFilters): boolean {
  return Boolean(
    filters.financialYear ||
      filters.quarter ||
      filters.months?.length ||
      filters.centres?.length ||
      filters.branches?.length ||
      filters.streams?.length ||
      filters.groups?.length ||
      filters.accounts?.length ||
      filters.statuses?.length,
  );
}

/** Human-readable summary of the active filters, used in exports. */
export function describeFilters(filters: MisFilters): string {
  const parts: string[] = [];
  if (filters.financialYear) parts.push(filters.financialYear);
  if (filters.quarter) parts.push(filters.quarter);
  if (filters.months?.length) parts.push(filters.months.join(', '));
  if (filters.centres?.length) parts.push(`Centre: ${filters.centres.join(', ')}`);
  if (filters.branches?.length) parts.push(`Branch: ${filters.branches.join(', ')}`);
  if (filters.streams?.length) parts.push(`Stream: ${filters.streams.join(', ')}`);
  if (filters.groups?.length) parts.push(`Group: ${filters.groups.join(', ')}`);
  if (filters.accounts?.length) parts.push(`Head: ${filters.accounts.join(', ')}`);
  if (filters.statuses?.length) parts.push(`Status: ${filters.statuses.join(', ')}`);
  return parts.length > 0 ? parts.join(' · ') : 'All data';
}

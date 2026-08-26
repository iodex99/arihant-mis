/**
 * Financial reconciliation.
 *
 * Correctness outranks appearance: an import that does not reconcile is marked
 * NEEDS_REVIEW and the operator is told exactly which identity failed and by
 * how much. Nothing is silently accepted (build spec §20).
 */

import { amountsAgree, round2 } from '../parser/values';
import type { NormalizationResult } from './normalize';

export type CheckStatus = 'PASS' | 'FAIL' | 'SKIPPED';

export interface ReconciliationCheck {
  code: string;
  label: string;
  status: CheckStatus;
  expected: number | null;
  actual: number | null;
  difference: number | null;
  /** Why the check was skipped, when it was. */
  note?: string;
  /** Up to 10 offending rows, for the operator to inspect. */
  offendingRows?: { rowNumber: number; sheetName: string; expected: number; actual: number; difference: number }[];
}

export interface ReconciliationResult {
  status: 'PASS' | 'FAIL';
  checks: ReconciliationCheck[];
  totals: {
    revenue: number;
    expense: number;
    profit: number;
    margin: number | null;
    factCount: number;
    rowCount: number;
  };
}

export function reconcile(result: NormalizationResult): ReconciliationResult {
  const revenue = sumFacts(result, 'REVENUE');
  const expense = sumFacts(result, 'EXPENSE');
  const profit = revenue - expense;

  const checks: ReconciliationCheck[] = [
    checkRevenueComponents(result, revenue),
    checkExpenseComponents(result, expense),
    checkProfitIdentity(result, revenue, expense),
    checkSubtotalAgreement(result),
    checkDimensionalRollups(result, revenue, expense),
  ];

  return {
    status: checks.some((c) => c.status === 'FAIL') ? 'FAIL' : 'PASS',
    checks,
    totals: {
      revenue: round2(revenue),
      expense: round2(expense),
      profit: round2(profit),
      margin: revenue === 0 ? null : profit / revenue,
      factCount: result.facts.length,
      rowCount: result.rows.length,
    },
  };
}

function sumFacts(result: NormalizationResult, kind: 'REVENUE' | 'EXPENSE'): number {
  let total = 0;
  for (const f of result.facts) if (f.kind === kind) total += f.amount;
  return total;
}

/** Ingested revenue facts must equal the revenue the source reported. */
function checkRevenueComponents(result: NormalizationResult, revenue: number): ReconciliationCheck {
  const reported = sumReported(result, (r) => r.reported.revenue ?? r.reported.totalRevenue);
  if (reported === null) {
    return skipped('REVENUE_COMPONENTS', 'Revenue components vs reported revenue', 'the source has no revenue total column');
  }
  return compare('REVENUE_COMPONENTS', 'Revenue components vs reported revenue', reported, revenue, result.rows.length);
}

function checkExpenseComponents(result: NormalizationResult, expense: number): ReconciliationCheck {
  const reported = sumReported(result, (r) => r.reported.expense ?? r.reported.indirectExpenses);
  if (reported === null) {
    return skipped('EXPENSE_COMPONENTS', 'Expense components vs reported expense', 'the source has no expense total column');
  }
  return compare('EXPENSE_COMPONENTS', 'Expense components vs reported expense', reported, expense, result.rows.length);
}

/** revenue - expense must equal the profit the source reported. */
function checkProfitIdentity(
  result: NormalizationResult,
  revenue: number,
  expense: number,
): ReconciliationCheck {
  const reported = sumReported(result, (r) => r.reported.profit);
  if (reported === null) {
    return skipped('PROFIT_IDENTITY', 'Revenue - Expense = Profit', 'the source has no profit column');
  }

  const check = compare('PROFIT_IDENTITY', 'Revenue - Expense = Profit', reported, revenue - expense, result.rows.length);

  // Point at the specific rows that break the identity.
  if (check.status === 'FAIL') {
    check.offendingRows = result.rows
      .map((r) => {
        const rev = r.reported.revenue ?? r.reported.totalRevenue;
        const exp = r.reported.expense ?? r.reported.indirectExpenses;
        const prof = r.reported.profit;
        if (rev === null || exp === null || prof === null) return null;
        const diff = round2(rev - exp - prof);
        if (amountsAgree(rev - exp, prof)) return null;
        return { rowNumber: r.rowNumber, sheetName: r.sheetName, expected: round2(prof), actual: round2(rev - exp), difference: diff };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .slice(0, 10);
  }

  return check;
}

/** The source's own two expense subtotals must agree with each other. */
function checkSubtotalAgreement(result: NormalizationResult): ReconciliationCheck {
  const rows = result.rows.filter(
    (r) => r.reported.expense !== null && r.reported.indirectExpenses !== null,
  );
  if (rows.length === 0) {
    return skipped('SUBTOTAL_AGREEMENT', 'Source expense subtotals agree', 'the source has only one expense total column');
  }

  const a = rows.reduce((s, r) => s + (r.reported.expense ?? 0), 0);
  const b = rows.reduce((s, r) => s + (r.reported.indirectExpenses ?? 0), 0);
  return compare('SUBTOTAL_AGREEMENT', 'Source expense subtotals agree', a, b, rows.length);
}

/**
 * Facts must roll up to the same grand total along every dimension. A
 * discrepancy means a fact escaped a dimension — e.g. a null branch key.
 */
function checkDimensionalRollups(
  result: NormalizationResult,
  revenue: number,
  expense: number,
): ReconciliationCheck {
  const dims: (keyof Pick<(typeof result.facts)[number], 'branchKey' | 'streamKey' | 'periodKey'>)[] = [
    'branchKey',
    'streamKey',
    'periodKey',
  ];

  const grand = revenue + expense;
  let worst = 0;
  let worstDim = '';

  for (const dim of dims) {
    const byKey = new Map<string, number>();
    for (const f of result.facts) {
      const k = String(f[dim] ?? '');
      byKey.set(k, (byKey.get(k) ?? 0) + f.amount);
    }
    const total = [...byKey.values()].reduce((s, v) => s + v, 0);
    const diff = Math.abs(total - grand);
    if (diff > worst) {
      worst = diff;
      worstDim = dim;
    }
  }

  const status: CheckStatus = amountsAgree(worst, 0, result.facts.length) ? 'PASS' : 'FAIL';
  return {
    code: 'DIMENSIONAL_ROLLUP',
    label: 'Totals agree across branch, stream and period',
    status,
    expected: round2(grand),
    actual: round2(grand - worst),
    difference: round2(worst),
    note: status === 'FAIL' ? `largest discrepancy on ${worstDim}` : undefined,
  };
}

function sumReported(
  result: NormalizationResult,
  pick: (r: NormalizationResult['rows'][number]) => number | null,
): number | null {
  let total = 0;
  let found = false;
  for (const r of result.rows) {
    const v = pick(r);
    if (v === null) continue;
    total += v;
    found = true;
  }
  return found ? total : null;
}

function compare(
  code: string,
  label: string,
  expected: number,
  actual: number,
  rowCount: number,
): ReconciliationCheck {
  const difference = round2(actual - expected);
  return {
    code,
    label,
    status: amountsAgree(expected, actual, rowCount) ? 'PASS' : 'FAIL',
    expected: round2(expected),
    actual: round2(actual),
    difference,
  };
}

function skipped(code: string, label: string, note: string): ReconciliationCheck {
  return { code, label, status: 'SKIPPED', expected: null, actual: null, difference: null, note };
}

/** One-line operator summary of a failed reconciliation. */
export function describeFailure(result: ReconciliationResult): string | null {
  const failed = result.checks.filter((c) => c.status === 'FAIL');
  if (failed.length === 0) return null;

  return failed
    .map((c) => `${c.label}: expected ${formatSigned(c.expected)}, got ${formatSigned(c.actual)} (off by ${formatSigned(c.difference)})`)
    .join('; ');
}

function formatSigned(n: number | null): string {
  if (n === null) return 'n/a';
  return n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

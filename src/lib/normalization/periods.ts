/**
 * Indian financial-year period logic (April–March).
 *
 * The quarter is always *derived* from the month and then cross-checked
 * against whatever the source claimed, so a mislabelled source column is
 * reported rather than trusted (docs/mis-specification.md §2).
 */

import { parseMonthToken, parseQuarterToken, parseFinancialYearToken } from '../parser/values';

export interface NormalizedPeriod {
  label: string;
  year: number;
  month: number;
  quarter: string;
  financialYear: string;
  sortKey: number;
  sourceQuarter: string | null;
}

/** First month of the Indian financial year. */
const FY_START_MONTH = 4;

export function quarterFromMonth(month: number): string {
  // Apr–Jun Q1, Jul–Sep Q2, Oct–Dec Q3, Jan–Mar Q4.
  const offset = (month - FY_START_MONTH + 12) % 12;
  return `Q${Math.floor(offset / 3) + 1}`;
}

export function financialYearFromMonth(year: number, month: number): string {
  const startYear = month >= FY_START_MONTH ? year : year - 1;
  return `FY ${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

export interface PeriodResolution {
  period: NormalizedPeriod | null;
  error: string | null;
  /** Set when the source quarter disagrees with the derived one. */
  quarterMismatch: { source: string; derived: string } | null;
}

export function resolvePeriod(
  monthValue: unknown,
  quarterValue?: unknown,
  financialYearValue?: unknown,
): PeriodResolution {
  const token = parseMonthToken(monthValue);

  if (!token) {
    return {
      period: null,
      error:
        monthValue === null || monthValue === undefined || String(monthValue).trim() === ''
          ? 'no month value'
          : `could not read "${String(monthValue)}" as a month`,
      quarterMismatch: null,
    };
  }

  const derivedQuarter = quarterFromMonth(token.month);
  const sourceQuarter = quarterValue === undefined ? null : parseQuarterToken(quarterValue);

  const derivedFy = financialYearFromMonth(token.year, token.month);
  const sourceFy = financialYearValue === undefined ? null : parseFinancialYearToken(financialYearValue);

  return {
    period: {
      label: token.label,
      year: token.year,
      month: token.month,
      quarter: derivedQuarter,
      // The source FY is honoured when present and well-formed; otherwise
      // derived. Some exports label a 15-month transition year explicitly.
      financialYear: sourceFy ?? derivedFy,
      sortKey: token.year * 100 + token.month,
      sourceQuarter,
    },
    error: null,
    quarterMismatch:
      sourceQuarter && sourceQuarter !== derivedQuarter
        ? { source: sourceQuarter, derived: derivedQuarter }
        : null,
  };
}

/** Chronological comparator for period-like objects. */
export function comparePeriods(a: { sortKey: number }, b: { sortKey: number }): number {
  return a.sortKey - b.sortKey;
}

/** All months of a financial year in order, as `{year, month}`. */
export function financialYearMonths(financialYear: string): { year: number; month: number }[] {
  const m = financialYear.match(/(\d{4})/);
  if (!m) return [];
  const startYear = Number(m[1]);
  const out: { year: number; month: number }[] = [];
  for (let i = 0; i < 12; i++) {
    const month = ((FY_START_MONTH - 1 + i) % 12) + 1;
    const year = month >= FY_START_MONTH ? startYear : startYear + 1;
    out.push({ year, month });
  }
  return out;
}

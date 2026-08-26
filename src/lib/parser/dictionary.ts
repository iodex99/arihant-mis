/**
 * Canonical data dictionary.
 *
 * Header synonyms plus value-shape expectations for every canonical field.
 * Header text alone is never decisive — see `scoreColumn` in mapping.ts, which
 * combines these with evidence from the actual values. That is what lets the
 * importer survive the Arihant workbook's swapped `Quater`/`Month` headers.
 */

import type { CanonicalField, ValueKind } from './types';

export interface FieldSpec {
  field: CanonicalField;
  role: 'dimension' | 'measure';
  /** Exact normalized-header matches. Highest header confidence. */
  exact: string[];
  /** Substring/token matches. Moderate header confidence. */
  contains: string[];
  /** Header patterns that positively rule the field out. */
  excludes?: RegExp[];
  /**
   * Require an exact or near-exact header match; ignore `contains`.
   * Set on every measure field: a wide financial sheet has dozens of account
   * columns whose names embed "expense", "income" or "profit"
   * ("CSR EXPENDITURE", "ADVERTISEMENT EXPENSE - OUTDOOR"), and substring
   * matching claims every one of them as the sheet's total column.
   */
  strictHeader?: boolean;
  /** Value kinds consistent with this field. */
  expectKinds: ValueKind[];
  /** Optional value-level predicate contributing independent evidence. */
  valueSignal?: (kind: ValueKind) => number;
  description: string;
}

export const FIELD_SPECS: FieldSpec[] = [
  {
    field: 'stream',
    role: 'dimension',
    exact: ['STREAM', 'STREAM NAME', 'COURSE', 'COURSE STREAM', 'BOARD', 'DIVISION', 'VERTICAL', 'SEGMENT'],
    contains: ['STREAM', 'BOARD'],
    expectKinds: ['text'],
    description: 'Academic stream (Science, Commerce, SSC, ICSE, CBSE, GMS)',
  },
  {
    field: 'branch',
    role: 'dimension',
    exact: ['BRANCH', 'BRANCH NAME', 'LOCATION', 'BRANCH LOCATION', 'CENTER NAME', 'UNIT'],
    contains: ['BRANCH'],
    // "Branch Code"/"Abbreviation" is a different field.
    excludes: [/\bCODE\b/, /\bABBR/, /\bSHORT\b/],
    expectKinds: ['text'],
    description: 'Branch / location name',
  },
  {
    field: 'abbreviation',
    role: 'dimension',
    exact: ['ABBREVIATION', 'ABBR', 'BRANCH CODE', 'CODE', 'SHORT NAME', 'SHORT CODE', 'BRANCH ABBR'],
    contains: ['ABBREV', 'SHORT CODE', 'BRANCH CODE'],
    expectKinds: ['text'],
    description: 'Short branch code used for reporting',
  },
  {
    field: 'centre',
    role: 'dimension',
    exact: ['CENTRE', 'CENTER', 'REGION', 'ZONE', 'AREA', 'CLUSTER'],
    contains: ['CENTRE', 'CENTER', 'REGION', 'ZONE'],
    excludes: [/\bCOST\b/, /\bNAME\b/],
    expectKinds: ['text'],
    description: 'Geographic region grouping branches',
  },
  {
    field: 'particulars',
    role: 'dimension',
    exact: ['PARTICULARS', 'PARTICULAR', 'DESCRIPTION', 'LEDGER GROUP', 'GROUP NAME', 'NARRATION'],
    contains: ['PARTICULAR'],
    expectKinds: ['text'],
    description: 'Source ledger-group caption',
  },
  {
    field: 'month',
    role: 'dimension',
    exact: ['MONTH', 'PERIOD', 'MONTH YEAR', 'MONTH-YEAR', 'MMM YY', 'MONTHNAME'],
    contains: ['MONTH', 'PERIOD'],
    expectKinds: ['monthToken', 'date'],
    // Decisive: a column of Oct'25 values IS the month column, whatever the
    // header says.
    valueSignal: (k) => (k === 'monthToken' ? 1 : k === 'date' ? 0.7 : 0),
    description: 'Reporting month',
  },
  {
    field: 'quarter',
    role: 'dimension',
    exact: ['QUARTER', 'QUATER', 'QTR', 'Q', 'FISCAL QUARTER'],
    contains: ['QUARTER', 'QUATER', 'QTR'],
    expectKinds: ['quarterToken'],
    valueSignal: (k) => (k === 'quarterToken' ? 1 : 0),
    description: 'Fiscal quarter (Q1..Q4)',
  },
  {
    field: 'financialYear',
    role: 'dimension',
    exact: ['FINANCIAL YEAR', 'FY', 'FISCAL YEAR', 'YEAR'],
    contains: ['FINANCIAL YEAR', 'FISCAL YEAR'],
    expectKinds: ['financialYearToken', 'text'],
    valueSignal: (k) => (k === 'financialYearToken' ? 1 : 0),
    description: 'Indian financial year (April–March)',
  },
  {
    field: 'status',
    role: 'dimension',
    exact: ['STATUS', 'BRANCH STATUS', 'STATE', 'OPERATIONAL STATUS'],
    contains: ['STATUS'],
    expectKinds: ['text'],
    description: 'Branch operating status',
  },
  {
    field: 'account',
    role: 'dimension',
    exact: ['EXPENSE', 'EXPENSE HEAD', 'ACCOUNT', 'ACCOUNT HEAD', 'LEDGER', 'LEDGER NAME', 'HEAD', 'EXPENSE CATEGORY', 'CATEGORY'],
    contains: ['EXPENSE HEAD', 'ACCOUNT HEAD', 'LEDGER'],
    expectKinds: ['text'],
    description: 'Expense/income head name (long-format sheets)',
  },
  {
    field: 'groupHead',
    role: 'dimension',
    exact: ['GROUP', 'GROUP HEAD', 'EXPENSE GROUP', 'PARENT GROUP', 'GROUP NAME'],
    contains: ['GROUP HEAD', 'GROUP'],
    expectKinds: ['text'],
    description: 'Roll-up group for an expense head',
  },
  {
    field: 'accountType',
    role: 'dimension',
    exact: ['TYPE', 'ACCOUNT TYPE', 'HEAD TYPE', 'NATURE'],
    contains: ['ACCOUNT TYPE'],
    expectKinds: ['text'],
    description: 'Revenue or Expense',
  },
  {
    field: 'date',
    role: 'dimension',
    exact: ['DATE', 'VOUCHER DATE', 'TXN DATE', 'TRANSACTION DATE', 'POSTING DATE'],
    contains: ['DATE'],
    expectKinds: ['date'],
    valueSignal: (k) => (k === 'date' ? 1 : 0),
    description: 'Transaction date',
  },

  // ---- measures ----
  {
    field: 'revenue',
    role: 'measure',
    strictHeader: true,
    exact: [
      'TOTAL INCOME', 'INCOME', 'TOTAL REVENUE', 'REVENUE', 'INCOME AMOUNT',
      'SALES', 'TURNOVER', 'GROSS REVENUE', 'GROSS INCOME', 'TOTAL SALES',
      'RECEIPTS', 'COLLECTION',
    ],
    contains: ['TOTAL INCOME', 'REVENUE', 'INCOME', 'TURNOVER', 'SALES'],
    excludes: [/\bOTHER\b/, /\bNET\b/, /%/, /\bRATIO\b/],
    expectKinds: ['number', 'currency'],
    description: 'Revenue / income for the row',
  },
  {
    field: 'expense',
    role: 'measure',
    strictHeader: true,
    exact: [
      'TOTAL EXPENSE', 'TOTAL EXPENSES', 'EXPENSE', 'EXPENSES', 'EXPENSE AMOUNT',
      'TOTAL COST', 'COST', 'EXPENDITURE', 'TOTAL EXPENDITURE', 'OUTGO',
      'INDIRECT EXPENSES',
    ],
    contains: ['TOTAL EXPENSE', 'EXPENDITURE', 'TOTAL COST'],
    excludes: [/%/, /\bRATIO\b/, /\bHEAD\b/, /\bCATEGORY\b/, /\bGROUP\b/],
    expectKinds: ['number', 'currency'],
    description: 'Expense for the row',
  },
  {
    field: 'profit',
    role: 'measure',
    strictHeader: true,
    exact: [
      'PROFIT', 'NET PROFIT', 'OPERATING PROFIT', 'PROFIT/LOSS', 'PROFIT LOSS',
      'NET PROFIT/LOSS', 'SURPLUS', 'PBT', 'NET RESULT', 'PROFIT OR LOSS',
    ],
    contains: ['PROFIT', 'SURPLUS'],
    excludes: [/%/, /\bMARGIN\b/, /\bRATIO\b/],
    expectKinds: ['number', 'currency'],
    description: 'Profit for the row',
  },
  {
    field: 'totalRevenue',
    role: 'measure',
    strictHeader: true,
    exact: ['TOTAL REVENUE'],
    contains: [],
    expectKinds: ['number', 'currency'],
    description: 'Revenue subtotal (validation only)',
  },
  {
    field: 'indirectExpenses',
    role: 'measure',
    strictHeader: true,
    exact: ['INDIRECT EXPENSES', 'INDIRECT EXPENSE'],
    contains: [],
    expectKinds: ['number', 'currency'],
    description: 'Expense subtotal (validation only)',
  },
  {
    field: 'amount',
    role: 'measure',
    strictHeader: true,
    exact: ['AMOUNT', 'TOTAL AMOUNT', 'VALUE', 'NET AMOUNT', 'DEBIT', 'CREDIT', 'BALANCE'],
    contains: ['AMOUNT'],
    excludes: [/%/],
    expectKinds: ['number', 'currency'],
    description: 'Generic amount (long-format sheets)',
  },
];

export const FIELD_SPEC_BY_NAME = new Map(FIELD_SPECS.map((s) => [s.field, s]));

/**
 * Columns that are row-level subtotals of other columns. Mapping them as facts
 * would double-count, so they are ingested for reconciliation only.
 */
export const SUBTOTAL_HEADERS = new Set([
  'TOTAL INCOME',
  'TOTAL REVENUE',
  'TOTAL EXPENSE',
  'TOTAL EXPENSES',
  'INDIRECT EXPENSES',
  'DIRECT EXPENSES',
  'PROFIT',
  'GROSS PROFIT',
  'NET PROFIT',
  'TOTAL',
  'GRAND TOTAL',
  'SUB TOTAL',
  'SUBTOTAL',
]);

/** Row labels that mark an aggregate row rather than a data row. */
export const TOTAL_ROW_LABELS = [
  'GRAND TOTAL', 'GRANDTOTAL', 'TOTAL', 'SUB TOTAL', 'SUBTOTAL', 'OVERALL TOTAL',
  'NET TOTAL', 'SUM', 'TOTAL:', 'ALL BRANCHES', 'ALL STREAMS', 'CUMULATIVE',
  'RUNNING TOTAL', 'TOTAL AMOUNT',
];

/**
 * Revenue-side account headers in wide layouts. Anything else in the measure
 * block is treated as an expense head — matching how the source workbook is
 * built (revenue is an explicit short list; expenses are open-ended).
 */
export const REVENUE_ACCOUNT_HEADERS = new Set([
  'SALES', 'OTHER INCOME', 'FEE INCOME', 'TUITION FEES', 'ADMISSION FEES',
  'INTEREST INCOME', 'MISC INCOME', 'MISCELLANEOUS INCOME', 'OTHER REVENUE',
]);

/** Levenshtein distance, capped for early exit. */
export function editDistance(a: string, b: string, cap = 6): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const prev = new Array<number>(b.length + 1);
  const cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > cap) return cap + 1;
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}

/** 0..1 similarity, tolerant of the typos real exports contain ("Quater"). */
export function headerSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const cap = 6;
  const d = editDistance(a, b, cap);
  // editDistance early-exits at cap+1; treating that as a real distance would
  // inflate similarity for long strings ("FINANCIAL YEAR" vs
  // "PROFESSIONAL CHARGES TEACHERS" scored 0.76 before this guard).
  if (d > cap) return 0;
  const maxLen = Math.max(a.length, b.length);
  if (d > maxLen) return 0;
  return 1 - d / maxLen;
}

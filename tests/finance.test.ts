import { describe, expect, it } from 'vitest';
import {
  amountsAgree,
  parseNumber,
  parseMonthToken,
  parseQuarterToken,
  parseFinancialYearToken,
  parseDate,
  normalizeHeader,
  normalizeAccountName,
} from '@/lib/parser/values';
import {
  quarterFromMonth,
  financialYearFromMonth,
  resolvePeriod,
} from '@/lib/normalization/periods';
import { formatCompactCurrency, formatCurrency, formatPercent } from '@/lib/format';
import { parseLedgerContext } from '@/lib/tally/sync';

describe('number parsing', () => {
  it.each([
    ['1234.56', 1234.56],
    ['1,234.56', 1234.56],
    ['12,34,567.89', 1234567.89],   // Indian grouping
    ['1,234,567.89', 1234567.89],   // Western grouping
    ['₹ 1,234.56', 1234.56],
    ['Rs. 1,234.56', 1234.56],
    ['INR 1234', 1234],
    ['(1,234.56)', -1234.56],       // accounting negative
    ['-1,234.56', -1234.56],
    ['+1234', 1234],
    ['1234 CR', -1234],
    ['1234 DR', 1234],
    ['25%', 0.25],
    ['  42  ', 42],
    [0, 0],
    [-15070223, -15070223],
  ])('parses %j as %j', (input, want) => {
    expect(parseNumber(input)).toBe(want);
  });

  it.each([['#N/A'], ['#REF!'], ['#DIV/0!'], ['—'], ['-'], ['abc'], [''], [null], [undefined]])(
    'returns null for %j',
    (input) => {
      expect(parseNumber(input)).toBeNull();
    },
  );

  it('scales the agreement tolerance with the number of rows summed', () => {
    expect(amountsAgree(100, 100.04)).toBe(true);
    expect(amountsAgree(100, 100.06)).toBe(false);
    // Summing 1000 rows accumulates more representation error.
    expect(amountsAgree(100, 100.5, 1000)).toBe(true);
  });
});

describe('period tokens', () => {
  it.each([
    ["Oct'25", 2025, 10],
    ['Oct-25', 2025, 10],
    ['October 2025', 2025, 10],
    ['2025-10', 2025, 10],
    ['10/2025', 2025, 10],
    ["Jan'26", 2026, 1],
  ])('parses %s', (input, year, month) => {
    const t = parseMonthToken(input);
    expect(t?.year).toBe(year);
    expect(t?.month).toBe(month);
  });

  it('preserves the source label verbatim', () => {
    expect(parseMonthToken("Oct'25")?.label).toBe("Oct'25");
  });

  it('rejects a bare month name, which carries no year', () => {
    expect(parseMonthToken('October')).toBeNull();
  });

  it.each([['Q3', 'Q3'], ['q3', 'Q3'], ['Quarter 3', 'Q3'], ['Q 2', 'Q2'], ['Q5', null], ['3', null]])(
    'parses quarter %s',
    (input, want) => {
      expect(parseQuarterToken(input)).toBe(want);
    },
  );

  it.each([
    ['FY 2025-26', 'FY 2025-26'],
    ['2025-26', 'FY 2025-26'],
    ['FY2025-2026', 'FY 2025-26'],
    ['FY 25-26', 'FY 2025-26'],
    ['2025-27', null],  // not consecutive
  ])('parses financial year %s', (input, want) => {
    expect(parseFinancialYearToken(input)).toBe(want);
  });

  it('parses dd-mm-yyyy as Indian convention, which is what Tally exports', () => {
    const d = parseDate('05-10-2025');
    expect(d?.getUTCDate()).toBe(5);
    expect(d?.getUTCMonth()).toBe(9); // October, not May
  });

  it('parses the dd-MMM-yyyy form Tally displays', () => {
    const d = parseDate('5-Oct-2025');
    expect(d?.getUTCFullYear()).toBe(2025);
    expect(d?.getUTCMonth()).toBe(9);
  });
});

describe('Indian financial year', () => {
  it.each([
    [4, 'Q1'], [5, 'Q1'], [6, 'Q1'],
    [7, 'Q2'], [8, 'Q2'], [9, 'Q2'],
    [10, 'Q3'], [11, 'Q3'], [12, 'Q3'],
    [1, 'Q4'], [2, 'Q4'], [3, 'Q4'],
  ])('month %i is %s', (month, quarter) => {
    expect(quarterFromMonth(month)).toBe(quarter);
  });

  it.each([
    [2025, 4, 'FY 2025-26'],
    [2025, 10, 'FY 2025-26'],
    [2026, 3, 'FY 2025-26'],   // March still belongs to the prior FY
    [2026, 4, 'FY 2026-27'],
    [2025, 1, 'FY 2024-25'],
  ])('%i-%i is %s', (year, month, fy) => {
    expect(financialYearFromMonth(year, month)).toBe(fy);
  });

  it('derives the quarter and agrees with a correct source quarter', () => {
    const r = resolvePeriod("Oct'25", 'Q3');
    expect(r.period?.quarter).toBe('Q3');
    expect(r.quarterMismatch).toBeNull();
  });

  it('flags a source quarter that disagrees, and uses the derived one', () => {
    const r = resolvePeriod("Oct'25", 'Q1');
    expect(r.period?.quarter).toBe('Q3');
    expect(r.quarterMismatch).toEqual({ source: 'Q1', derived: 'Q3' });
  });

  it('explains an unreadable period instead of silently skipping', () => {
    const r = resolvePeriod('not a month');
    expect(r.period).toBeNull();
    expect(r.error).toContain('not a month');
  });
});

describe('financial identities', () => {
  const cases = [
    { revenue: 81576200.57, expense: 61030802.65, profit: 20545397.92, margin: 0.251855 },
    { revenue: 7458555.16, expense: 2727515.02, profit: 4731040.14, margin: 0.634308 },
    { revenue: 968230.27, expense: 977640.9, profit: -9410.63, margin: -0.009720 },
    { revenue: 1141635.39, expense: -434190, profit: 1575825.39, margin: 1.380325 },
  ];

  it.each(cases)('revenue - expense = profit for $revenue', ({ revenue, expense, profit }) => {
    expect(revenue - expense).toBeCloseTo(profit, 2);
  });

  it.each(cases)('margin = profit / revenue for $revenue', ({ revenue, profit, margin }) => {
    expect(profit / revenue).toBeCloseTo(margin, 5);
  });

  it('leaves margin undefined when there is no revenue to divide by', () => {
    const revenue = 0;
    const expense = 245000;
    const margin = revenue === 0 ? null : (revenue - expense) / revenue;
    expect(margin).toBeNull();
  });
});

describe('formatting', () => {
  it.each([
    [81576200.57, '₹8.16 Cr'],
    [1484000, '₹14.84 L'],
    [45200, '₹45.20 K'],
    [523.4, '₹523.40'],
    [-9410.63, '-₹9.41 K'],
  ])('formats %i compactly as %s', (value, want) => {
    expect(formatCompactCurrency(value)).toBe(want);
  });

  it('groups full precision the Indian way and parenthesises negatives', () => {
    expect(formatCurrency(81576200.57)).toBe('₹8,15,76,200.57');
    expect(formatCurrency(-434190)).toBe('(₹4,34,190.00)');
  });

  it('renders a null margin as an em dash, never 0 %', () => {
    expect(formatPercent(null)).toBe('—');
    expect(formatPercent(0)).toBe('0.00%');
    expect(formatPercent(0.251855)).toBe('25.19%');
  });
});

describe('normalization keys', () => {
  it('matches account names across case and spacing differences', () => {
    expect(normalizeAccountName('  Professional  Charges Teachers ')).toBe('PROFESSIONAL CHARGES TEACHERS');
    expect(normalizeAccountName('Subject Head ')).toBe('SUBJECT HEAD');
  });

  it('strips punctuation from headers for matching', () => {
    expect(normalizeHeader('Total Income:')).toBe('TOTAL INCOME');
    expect(normalizeHeader('Profit / Loss')).toBe('PROFIT / LOSS');
  });
});

describe('Tally ledger captions', () => {
  it('extracts stream and branch code from the caption format Arihant uses', () => {
    expect(parseLedgerContext('Arihant Academy (CBSE) - Charkop (CKP)')).toEqual({
      stream: 'CBSE',
      branch: 'CKP',
    });
  });

  it('falls back to the branch text when there is no code', () => {
    expect(parseLedgerContext('Arihant Academy (Science) - Nashik')).toEqual({
      stream: 'Science',
      branch: 'Nashik',
    });
  });

  it('returns nulls rather than guessing when the caption does not match', () => {
    expect(parseLedgerContext('Bank Charges')).toEqual({ stream: null, branch: null });
  });
});

import { describe, expect, it } from 'vitest';
import { analyzeWorkbook } from '@/lib/parser/analyze';
import { readFile } from '@/lib/parser/readers';
import { trimGrid } from '@/lib/parser/structure';
import { normalizeWorkbook } from '@/lib/normalization/normalize';
import { reconcile } from '@/lib/normalization/reconcile';
import {
  expected,
  versionA,
  versionB,
  versionC,
  versionD,
  versionE,
} from './fixtures/build';

/** Run a buffer through the whole read-only pipeline. */
async function run(filename: string, buffer: Buffer) {
  const analysis = await analyzeWorkbook(filename, buffer);
  const grids = new Map<number, unknown[][]>();
  for (const g of await readFile(filename, buffer)) grids.set(g.sheetIndex, trimGrid(g).rows);
  const normalized = normalizeWorkbook(analysis, grids);
  return { analysis, normalized, reconciliation: reconcile(normalized) };
}

const TOTALS = expected();

describe('universal parser', () => {
  it('reads the baseline layout and reconciles', async () => {
    const { analysis, reconciliation } = await run('a.xlsx', await versionA());

    expect(analysis.blockers).toEqual([]);
    expect(reconciliation.status).toBe('PASS');
    expect(reconciliation.totals.revenue).toBeCloseTo(TOTALS.revenue, 2);
    expect(reconciliation.totals.expense).toBeCloseTo(TOTALS.expense, 2);
    expect(reconciliation.totals.profit).toBeCloseTo(TOTALS.profit, 2);
  });

  it('maps period columns from their values, not their headers', async () => {
    const { analysis, normalized } = await run('a.xlsx', await versionA());
    const sheet = analysis.sheets.find((s) => s.role === 'FACTS')!;

    // The fixture, like the real workbook, labels these the wrong way round.
    const monthColumn = sheet.mappings.find((m) => m.field === 'month');
    const quarterColumn = sheet.mappings.find((m) => m.field === 'quarter');

    expect(monthColumn?.header).toBe('Quater');
    expect(quarterColumn?.header).toBe('Month');

    // And the mismatch is reported rather than swallowed.
    expect(analysis.warnings.some((w) => w.code === 'HEADER_VALUE_MISMATCH')).toBe(true);

    // Periods resolve to real months, not to "Q3".
    expect([...normalized.dimensions.periods.keys()].sort()).toEqual(['2025-10', '2025-11']);
  });

  it('survives every column being reordered', async () => {
    const { analysis, reconciliation } = await run('b.xlsx', await versionB());

    expect(analysis.blockers).toEqual([]);
    expect(reconciliation.totals.revenue).toBeCloseTo(TOTALS.revenue, 2);
    expect(reconciliation.totals.expense).toBeCloseTo(TOTALS.expense, 2);
    expect(reconciliation.status).toBe('PASS');
  });

  it('survives every column being renamed to a synonym', async () => {
    const { analysis, reconciliation } = await run('c.xlsx', await versionC());

    expect(analysis.blockers).toEqual([]);
    expect(reconciliation.totals.revenue).toBeCloseTo(TOTALS.revenue, 2);
    expect(reconciliation.totals.expense).toBeCloseTo(TOTALS.expense, 2);
  });

  it('skips title, blank and grand-total rows, and reads formatted numbers', async () => {
    const { analysis, normalized, reconciliation } = await run('d.xlsx', await versionD());
    const sheet = analysis.sheets.find((s) => s.role === 'FACTS')!;

    expect(sheet.headerRow).toBe(5);
    expect(sheet.totalRowNumbers.length).toBeGreaterThan(0);

    // The grand-total row must not become a branch.
    expect([...normalized.dimensions.branches.values()].map((b) => b.abbreviation))
      .not.toContain('Grand Total');

    // Currency symbols, Indian grouping and parenthesised negatives all parse.
    expect(reconciliation.totals.revenue).toBeCloseTo(TOTALS.revenue, 2);
    expect(reconciliation.totals.expense).toBeCloseTo(TOTALS.expense, 2);
    expect(reconciliation.status).toBe('PASS');
  });

  it('reads CSV', async () => {
    const { analysis, reconciliation } = await run('e.csv', versionE());

    expect(analysis.blockers).toEqual([]);
    expect(reconciliation.totals.revenue).toBeCloseTo(TOTALS.revenue, 2);
  });

  it('produces identical totals across all layouts', async () => {
    const results = await Promise.all([
      run('a.xlsx', await versionA()),
      run('b.xlsx', await versionB()),
      run('c.xlsx', await versionC()),
      run('d.xlsx', await versionD()),
      run('e.csv', versionE()),
    ]);

    const revenues = results.map((r) => Math.round(r.reconciliation.totals.revenue * 100));
    const expenses = results.map((r) => Math.round(r.reconciliation.totals.expense * 100));

    expect(new Set(revenues).size).toBe(1);
    expect(new Set(expenses).size).toBe(1);
  });
});

describe('subtotal handling', () => {
  it('excludes verified subtotal columns from the facts', async () => {
    const { analysis } = await run('a.xlsx', await versionA());
    const sheet = analysis.sheets.find((s) => s.role === 'FACTS')!;
    const subtotals = sheet.mappings.filter((m) => m.role === 'subtotal').map((m) => m.header);

    expect(subtotals).toContain('Total Income');
    expect(subtotals).toContain('Indirect Expenses');
  });

  it('never treats a component column as a subtotal', async () => {
    // Sales = Total Income - Other Income is arithmetically true, so a naive
    // difference rule would mark Sales a subtotal and drop all revenue.
    const { analysis, reconciliation } = await run('a.xlsx', await versionA());
    const sheet = analysis.sheets.find((s) => s.role === 'FACTS')!;
    const subtotals = sheet.mappings.filter((m) => m.role === 'subtotal').map((m) => m.header);

    expect(subtotals).not.toContain('Sales');
    expect(subtotals).not.toContain('Other Income');
    expect(reconciliation.totals.revenue).toBeGreaterThan(0);
  });

  it('counts each expense head exactly once', async () => {
    const { normalized } = await run('a.xlsx', await versionA());
    const rent = normalized.facts.filter((f) => f.accountName === 'Rent');
    expect(rent.reduce((s, f) => s + f.amount, 0)).toBeCloseTo(310000, 2);
  });
});

describe('data integrity', () => {
  it('keeps negative expense amounts', async () => {
    const { normalized } = await run('a.xlsx', await versionA());
    const depreciation = normalized.facts.filter((f) => f.accountName === 'DEPRECIATION');

    expect(depreciation.length).toBeGreaterThan(0);
    expect(depreciation.every((f) => f.amount < 0)).toBe(true);
  });

  it('routes an unmapped expense head to Unclassified and warns, without losing it', async () => {
    const { normalized, reconciliation } = await run('a.xlsx', await versionA());

    const gateway = [...normalized.dimensions.accounts.values()]
      .find((a) => a.name === 'PAYMENT GATEWAY CHARGES');

    expect(gateway?.groupHead).toBe('Unclassified');
    expect(gateway?.groupMapped).toBe(false);
    expect(normalized.warnings.some((w) => w.code === 'UNMAPPED_ACCOUNT')).toBe(true);

    // Crucially, its amount is still inside the total.
    expect(reconciliation.totals.expense).toBeCloseTo(TOTALS.expense, 2);
  });

  it('applies the group mapping from the reference sheet', async () => {
    const { normalized } = await run('a.xlsx', await versionA());
    const accounts = normalized.dimensions.accounts;

    expect([...accounts.values()].find((a) => a.name === 'Rent')?.groupHead).toBe('Rent Expense');
    expect([...accounts.values()].find((a) => a.name === 'DEPRECIATION')?.groupHead).toBe('Unallocated Expense');
  });

  it('keeps a dormant all-zero branch as a dimension member', async () => {
    const { normalized } = await run('a.xlsx', await versionA());
    const codes = [...normalized.dimensions.branches.values()].map((b) => b.abbreviation);
    expect(codes).toContain('VR');
  });

  it('records provenance for every fact', async () => {
    const { normalized } = await run('a.xlsx', await versionA());
    expect(normalized.facts.every((f) => normalized.rows[f.rowRef] !== undefined)).toBe(true);
  });
});

describe('error handling', () => {
  it('blocks a file with no recognisable financial data', async () => {
    const nonsense = Buffer.from('hello,world\nfoo,bar\nbaz,qux', 'utf8');
    const { analysis } = await run('junk.csv', nonsense);

    expect(analysis.readyToImport).toBe(false);
    expect(analysis.blockers.length).toBeGreaterThan(0);
    // The message must say what to do, not just that it failed.
    expect(analysis.blockers[0].remedy).toBeTruthy();
  });

  it('reports a missing required dimension rather than importing partial data', async () => {
    const noBranch = Buffer.from(
      'Stream,Quater,Sales,Rent\nScience,Oct\'25,1000,100\nCommerce,Oct\'25,2000,200',
      'utf8',
    );
    const { analysis } = await run('nobranch.csv', noBranch);

    const blocker = analysis.blockers.find((b) => b.code === 'MISSING_REQUIRED_DIMENSION');
    expect(blocker).toBeTruthy();
    expect(blocker?.message).toContain('branch');
  });

  it('rejects the legacy .xls format with an actionable message', async () => {
    const { detectFormat, ImportFormatError } = await import('@/lib/parser/readers');
    expect(() => detectFormat('old.xls', Buffer.from('\xD0\xCF\x11\xE0'))).toThrow(ImportFormatError);

    try {
      detectFormat('old.xls', Buffer.from('\xD0\xCF\x11\xE0'));
    } catch (e) {
      expect((e as InstanceType<typeof ImportFormatError>).remedy).toContain('Save As');
    }
  });
});

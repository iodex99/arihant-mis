/**
 * Acceptance test against the client's real workbook.
 *
 * The file is confidential and is not committed, so these tests skip when it is
 * absent — but on any machine that has it (the developer's, the Arihant
 * server), they assert that the pipeline still reproduces every figure printed
 * in `Monthly_Arihant_lookers_Studio-MIS.pdf`.
 *
 * Place the workbook at `for reference/Arihant.xlsx`, or point
 * REFERENCE_WORKBOOK at it.
 */

import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyzeWorkbook } from '@/lib/parser/analyze';
import { readFile } from '@/lib/parser/readers';
import { trimGrid } from '@/lib/parser/structure';
import { normalizeWorkbook } from '@/lib/normalization/normalize';
import { reconcile } from '@/lib/normalization/reconcile';

const PATH = process.env.REFERENCE_WORKBOOK ?? 'for reference/Arihant.xlsx';
const available = existsSync(PATH);

/** Figures transcribed from the supplied PDF. */
const PDF = {
  revenue: 81576200.57,
  expense: 61030802.65,
  profit: 20545397.92,
  margin: 0.251855,
  streams: {
    Science: [34553279.19, 25198797.77],
    Commerce: [12918493.55, 7278494.31],
    SSC: [23525089.99, 20895401.81],
    ICSE: [7658864.95, 5401006.19],
    CBSE: [2920472.89, 2257102.57],
    GMS: [0, 0],
  } as Record<string, [number, number]>,
  branches: {
    CKP: [7458555.16, 2727515.02],
    AV: [8076495.12, 3243772.35],
    TC: [6714074.52, 3444135.9],
    BW: [6775791.37, 3671064.66],
    VS: [12342525.26, 6833074.5],
    DR: [4061337.15, 2281704.55],   // PDF prints 4,061,337.15; true sum 4,061,337.1452
    MTG: [3413604.29, 2068802.03],
    CMBR: [85792.9, 7240],
    SBN: [968230.27, 977640.9],
    VRST: [756023.88, 712729.71],
    // The blank-abbreviation rows, which the reference report shows as one line.
    UNASSIGNED: [1141635.39, -434190],
  } as Record<string, [number, number]>,
  periods: {
    "Oct'25": [39624883.74, 23529173.21],
    "Nov'25": [41951316.83, 37501629.44],
  } as Record<string, [number, number]>,
};

/**
 * Compare money at the tolerance the reconciliation layer itself uses
 * (docs/mis-specification.md §7). `toBeCloseTo(x, 2)` allows only 0.005, which
 * is tighter than summing thousands of floats can guarantee — DR's true revenue
 * is 4,061,337.1452, which the PDF prints rounded to 4,061,337.15.
 */
function expectMoney(actual: number, expected: number, label: string) {
  expect(Math.abs(actual - expected), `${label}: got ${actual}, expected ${expected}`)
    .toBeLessThanOrEqual(0.05);
}

const suite = available ? describe : describe.skip;

suite('reference workbook', () => {
  // Parsed once and shared: the workbook is 1.3 MB and every case would
  // otherwise re-read and re-analyse it.
  let cached: ReturnType<typeof parse> | null = null;

  function load() {
    cached ??= parse();
    return cached;
  }

  async function parse() {
    const buffer = readFileSync(PATH);
    const analysis = await analyzeWorkbook('Arihant.xlsx', buffer);
    const grids = new Map<number, unknown[][]>();
    for (const g of await readFile(PATH, buffer)) grids.set(g.sheetIndex, trimGrid(g).rows);
    const normalized = normalizeWorkbook(analysis, grids);
    return { analysis, normalized, reconciliation: reconcile(normalized) };
  }

  function aggregate(
    facts: { kind: string; amount: number }[],
  ): { revenue: number; expense: number } {
    return facts.reduce(
      (acc, f) => {
        if (f.kind === 'REVENUE') acc.revenue += f.amount;
        else acc.expense += f.amount;
        return acc;
      },
      { revenue: 0, expense: 0 },
    );
  }

  it('imports without blockers', async () => {
    const { analysis } = await load();
    expect(analysis.blockers).toEqual([]);
    expect(analysis.readyToImport).toBe(true);
  });

  it('identifies Main data as the source and skips the derived sheets', async () => {
    const { analysis } = await load();
    const byName = Object.fromEntries(analysis.sheets.map((s) => [s.name, s.role]));

    expect(byName['Main data']).toBe('FACTS');
    expect(byName['Group head']).toBe('MAPPING');
    // Branch Data and Comparison are stale rollups of Main data; importing them
    // as well would double-count Oct'25.
    expect(byName['Branch Data']).toBe('DERIVED');
    expect(byName['Comparison']).toBe('DERIVED');
  });

  it('reconciles every identity', async () => {
    const { reconciliation } = await load();
    for (const check of reconciliation.checks) {
      expect(check.status, `${check.label} (off by ${check.difference})`).not.toBe('FAIL');
    }
    expect(reconciliation.status).toBe('PASS');
  });

  it('reproduces the grand totals from the PDF', async () => {
    const { reconciliation } = await load();
    expectMoney(reconciliation.totals.revenue, PDF.revenue, 'revenue');
    expectMoney(reconciliation.totals.expense, PDF.expense, 'expense');
    expectMoney(reconciliation.totals.profit, PDF.profit, 'profit');
    expect(reconciliation.totals.margin!).toBeCloseTo(PDF.margin, 5);
  });

  it('reproduces every stream in the PDF', async () => {
    const { normalized } = await load();
    for (const [stream, [revenue, expense]] of Object.entries(PDF.streams)) {
      const facts = normalized.facts.filter((f) => f.streamKey === stream.toUpperCase());
      const got = aggregate(facts);
      expectMoney(got.revenue, revenue, `${stream} revenue`);
      expectMoney(got.expense, expense, `${stream} expense`);
    }
  });

  it('reproduces every branch in the PDF', async () => {
    const { normalized } = await load();
    for (const [branch, [revenue, expense]] of Object.entries(PDF.branches)) {
      const facts = normalized.facts.filter((f) => f.branchKey === branch.toUpperCase());
      const got = aggregate(facts);
      expectMoney(got.revenue, revenue, `${branch} revenue`);
      expectMoney(got.expense, expense, `${branch} expense`);
    }
  });

  it('splits both months correctly', async () => {
    const { normalized } = await load();
    const byLabel = new Map(
      [...normalized.dimensions.periods.entries()].map(([key, p]) => [p.label, key]),
    );

    for (const [label, [revenue, expense]] of Object.entries(PDF.periods)) {
      const key = byLabel.get(label)!;
      const got = aggregate(normalized.facts.filter((f) => f.periodKey === key));
      expectMoney(got.revenue, revenue, `${label} revenue`);
      expectMoney(got.expense, expense, `${label} expense`);
    }
  });

  it('maps the mislabelled period columns by their values', async () => {
    const { analysis, normalized } = await load();
    const sheet = analysis.sheets.find((s) => s.name === 'Main data')!;

    expect(sheet.mappings.find((m) => m.field === 'month')?.header).toBe('Quater');
    expect(sheet.mappings.find((m) => m.field === 'quarter')?.header).toBe('Month');

    for (const period of normalized.dimensions.periods.values()) {
      expect(period.quarter).toBe('Q3');
      expect(period.financialYear).toBe('FY 2025-26');
    }
  });

  it('ingests 53 expense heads and 2 revenue heads, and nothing else', async () => {
    const { normalized } = await load();
    const accounts = [...normalized.dimensions.accounts.values()];

    expect(accounts.filter((a) => a.kind === 'EXPENSE')).toHaveLength(53);
    expect(accounts.filter((a) => a.kind === 'REVENUE').map((a) => a.name).sort())
      .toEqual(['Other Income', 'Sales']);
  });

  it('reports the one unmapped expense head without losing its amount', async () => {
    const { normalized, reconciliation } = await load();
    const unmapped = [...normalized.dimensions.accounts.values()]
      .filter((a) => a.kind === 'EXPENSE' && !a.groupMapped);

    expect(unmapped.map((a) => a.name)).toEqual(['PAYMENT GATEWAY CHARGES']);
    // Still inside the reconciled total.
    expectMoney(reconciliation.totals.expense, PDF.expense, 'expense');
  });

  it('keeps the large negative provisions', async () => {
    const { normalized } = await load();
    const depreciation = normalized.facts
      .filter((f) => f.accountName === 'DEPRECIATION')
      .reduce((s, f) => s + f.amount, 0);

    expect(depreciation).toBeCloseTo(-15070223, 2);
  });
});

if (!available) {
  describe('reference workbook', () => {
    it.skip(`skipped — place the workbook at "${PATH}" to run these checks`, () => {});
  });
}

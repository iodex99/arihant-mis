/**
 * Reference verification.
 *
 * Runs the real workbook through analyze -> normalize -> reconcile and checks
 * the result against the figures printed in
 * `Monthly_Arihant_lookers_Studio-MIS.pdf`.
 *
 *   npm run verify:reference
 */

import { readFileSync } from 'node:fs';
import { analyzeWorkbook } from '../src/lib/parser/analyze';
import { readFile } from '../src/lib/parser/readers';
import { trimGrid } from '../src/lib/parser/structure';
import { normalizeWorkbook } from '../src/lib/normalization/normalize';
import { reconcile } from '../src/lib/normalization/reconcile';

const SOURCE = process.argv[2] ?? 'for reference/Arihant.xlsx';

/** Figures transcribed from the supplied PDF, used as expectations only. */
const PDF = {
  totalIncome: 81576200.57,
  totalExpense: 61030802.65,
  profit: 20545397.92,
  streams: [
    ['Science', 34553279.19, 25198797.77, 9354481.42],
    ['Commerce', 12918493.55, 7278494.31, 5639999.24],
    ['SSC', 23525089.99, 20895401.81, 2629688.18],
    ['ICSE', 7658864.95, 5401006.19, 2257858.76],
    ['CBSE', 2920472.89, 2257102.57, 663370.32],
    ['GMS', 0, 0, 0],
  ] as [string, number, number, number][],
  branches: [
    ['CMBR', 85792.9, 7240, 78552.9],
    ['CKP', 7458555.16, 2727515.02, 4731040.14],
    ['AV', 8076495.12, 3243772.35, 4832722.77],
    ['TC', 6714074.52, 3444135.9, 3269938.62],
    ['BW', 6775791.37, 3671064.66, 3104726.71],
    ['VS', 12342525.26, 6833074.5, 5509450.76],
    ['MTG', 3413604.29, 2068802.03, 1344802.26],
    ['SBN', 968230.27, 977640.9, -9410.63],
    ['VRST', 756023.88, 712729.71, 43294.17],
  ] as [string, number, number, number][],
};

const TOLERANCE = 0.05;

let failures = 0;

function check(label: string, actual: number, expected: number, tol = TOLERANCE): void {
  const diff = Math.abs(actual - expected);
  const ok = diff <= tol;
  if (!ok) failures++;
  console.log(
    `${ok ? '  PASS' : '  FAIL'}  ${label.padEnd(44)} ${fmt(actual).padStart(18)}  expected ${fmt(expected).padStart(18)}${ok ? '' : `   diff ${fmt(diff)}`}`,
  );
}

function fmt(n: number): string {
  return n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function main(): Promise<void> {
  const buffer = readFileSync(SOURCE);

  console.log(`\nSource: ${SOURCE}  (${buffer.byteLength.toLocaleString('en-IN')} bytes)\n`);
  console.log('=== 1. Analysis ===');

  const analysis = await analyzeWorkbook(SOURCE.split(/[\\/]/).pop()!, buffer);
  for (const s of analysis.sheets) {
    console.log(`  ${s.name.padEnd(14)} ${s.role.padEnd(8)} layout=${s.layout.padEnd(8)} header=row ${s.headerRow}  rows=${s.rowCount}`);
  }
  console.log(`  blockers=${analysis.blockers.length}  readyToImport=${analysis.readyToImport}`);
  if (analysis.blockers.length > 0) {
    for (const b of analysis.blockers) console.log(`  BLOCKER ${b.code}: ${b.message}`);
    process.exitCode = 1;
    return;
  }

  console.log('\n=== 2. Normalization ===');
  const grids = new Map<number, unknown[][]>();
  for (const g of await readFile(SOURCE, buffer)) {
    grids.set(g.sheetIndex, trimGrid(g).rows);
  }

  const normalized = normalizeWorkbook(analysis, grids);
  console.log(`  rows=${normalized.rows.length}  facts=${normalized.facts.length}`);
  console.log(
    `  dimensions: ${normalized.dimensions.periods.size} periods, ${normalized.dimensions.branches.size} branches, ` +
      `${normalized.dimensions.streams.size} streams, ${normalized.dimensions.centres.size} centres, ` +
      `${normalized.dimensions.accounts.size} accounts`,
  );
  for (const w of normalized.warnings) console.log(`  [${w.severity}] ${w.code}: ${w.message}`);

  console.log('\n=== 3. Reconciliation ===');
  const rec = reconcile(normalized);
  for (const c of rec.checks) {
    const detail =
      c.status === 'SKIPPED'
        ? c.note
        : `expected ${fmt(c.expected ?? 0)}  actual ${fmt(c.actual ?? 0)}  diff ${fmt(c.difference ?? 0)}`;
    console.log(`  ${c.status.padEnd(8)} ${c.label.padEnd(44)} ${detail}`);
  }
  if (rec.status === 'FAIL') failures++;

  console.log('\n=== 4. Grand totals vs PDF ===');
  check('Total Income', rec.totals.revenue, PDF.totalIncome);
  check('Total Expense', rec.totals.expense, PDF.totalExpense);
  check('Profit', rec.totals.profit, PDF.profit);
  check('Profit margin %', (rec.totals.margin ?? 0) * 100, 25.19, 0.005);

  console.log('\n=== 5. Stream analysis vs PDF ===');
  const byStream = aggregate(normalized, (f) => f.streamKey);
  for (const [name, inc, exp, prof] of PDF.streams) {
    const key = name.toUpperCase();
    const got = byStream.get(key) ?? { revenue: 0, expense: 0 };
    check(`${name} revenue`, got.revenue, inc);
    check(`${name} expense`, got.expense, exp);
    check(`${name} profit`, got.revenue - got.expense, prof);
  }

  console.log('\n=== 6. Branch analysis vs PDF ===');
  const byBranch = aggregate(normalized, (f) => f.branchKey);
  for (const [abbr, inc, exp, prof] of PDF.branches) {
    const got = byBranch.get(abbr.toUpperCase()) ?? { revenue: 0, expense: 0 };
    check(`${abbr} revenue`, got.revenue, inc);
    check(`${abbr} expense`, got.expense, exp);
    check(`${abbr} profit`, got.revenue - got.expense, prof);
  }

  console.log('\n=== 7. Period split ===');
  const byPeriod = aggregate(normalized, (f) => f.periodKey);
  for (const [key, v] of [...byPeriod].sort()) {
    console.log(`  ${key}  revenue ${fmt(v.revenue).padStart(16)}  expense ${fmt(v.expense).padStart(16)}  profit ${fmt(v.revenue - v.expense).padStart(16)}`);
  }

  console.log(
    failures === 0
      ? '\nAll reference checks passed.\n'
      : `\n${failures} reference check(s) FAILED.\n`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

function aggregate(
  normalized: ReturnType<typeof normalizeWorkbook>,
  keyOf: (f: (typeof normalized.facts)[number]) => string,
): Map<string, { revenue: number; expense: number }> {
  const out = new Map<string, { revenue: number; expense: number }>();
  for (const f of normalized.facts) {
    const k = keyOf(f);
    const cur = out.get(k) ?? { revenue: 0, expense: 0 };
    if (f.kind === 'REVENUE') cur.revenue += f.amount;
    else cur.expense += f.amount;
    out.set(k, cur);
  }
  return out;
}

main();

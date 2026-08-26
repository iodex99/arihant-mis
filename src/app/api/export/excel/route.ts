import { NextResponse, type NextRequest } from 'next/server';
import ExcelJS from 'exceljs';
import { requireUser } from '@/lib/auth';
import { requireCompany } from '@/lib/company';
import { parseFilters, describeFilters } from '@/lib/mis/filters';
import {
  getKpis,
  getByDimension,
  getBranchDetail,
  getExpenseAnalysis,
} from '@/lib/mis/engine';
import { toErrorResponse } from '@/lib/api';

/**
 * Excel export of the current MIS, honouring the active filters.
 * Numbers are written as numbers with Indian accounting formats, not as
 * pre-formatted strings, so the workbook stays usable for further analysis.
 */
export async function GET(request: NextRequest) {
  try {
    await requireUser();
    const company = await requireCompany();
    const filters = parseFilters(request.nextUrl.searchParams);

    const [kpis, streams, branches, accounts, groups] = await Promise.all([
      getKpis(company.id, filters),
      getByDimension(company.id, filters, 'stream'),
      getBranchDetail(company.id, filters),
      getExpenseAnalysis(company.id, filters, 'account'),
      getExpenseAnalysis(company.id, filters, 'group'),
    ]);

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Arihant MIS';
    wb.created = new Date();

    const MONEY = '#,##0.00;[Red](#,##0.00)';
    const PCT = '0.00%';

    // --- Summary ---
    const summary = wb.addWorksheet('Summary');
    summary.columns = [{ width: 26 }, { width: 22 }];
    summary.addRow(['Arihant Academy — Financial MIS']).font = { bold: true, size: 14 };
    summary.addRow(['Filters', describeFilters(filters)]);
    summary.addRow(['Generated', new Date().toLocaleString('en-IN')]);
    summary.addRow([]);
    addMeasure(summary, 'Revenue', kpis.revenue, MONEY);
    addMeasure(summary, 'Expense', kpis.expense, MONEY);
    addMeasure(summary, 'Profit', kpis.profit, MONEY);
    addMeasure(summary, 'Profit margin', kpis.margin, PCT);

    // --- Streams ---
    sheet(
      wb,
      'Stream profitability',
      ['Stream', 'Revenue', 'Expense', 'Profit', 'Profit margin'],
      streams.map((s) => [s.label, s.revenue, s.expense, s.profit, s.margin]),
      [null, MONEY, MONEY, MONEY, PCT],
      ['', kpis.revenue, kpis.expense, kpis.profit, kpis.margin],
    );

    // --- Branches ---
    sheet(
      wb,
      'Branch profitability',
      ['Branch', 'Branch name', 'Centre', 'Status', 'Revenue', 'Expense', 'Profit', 'Expense ratio', 'Profit margin'],
      branches.map((b) => [b.key, b.name, b.centre, b.status, b.revenue, b.expense, b.profit, b.expenseRatio, b.margin]),
      [null, null, null, null, MONEY, MONEY, MONEY, '0.00', PCT],
      ['', '', '', '', kpis.revenue, kpis.expense, kpis.profit, kpis.expenseRatio, kpis.margin],
    );

    // --- Expense heads ---
    sheet(
      wb,
      'Expense analysis',
      ['Expense head', 'Amount', '% of revenue', '% of total expense'],
      accounts.map((a) => [a.label, a.amount, a.pctOfRevenue, a.shareOfExpense]),
      [null, MONEY, PCT, PCT],
      ['', kpis.expense, kpis.revenue === 0 ? null : kpis.expense / kpis.revenue, 1],
    );

    // --- Groups ---
    sheet(
      wb,
      'Group analysis',
      ['Group', 'Amount', '% of revenue', '% of total expense'],
      groups.map((g) => [g.label, g.amount, g.pctOfRevenue, g.shareOfExpense]),
      [null, MONEY, PCT, PCT],
      ['', kpis.expense, kpis.revenue === 0 ? null : kpis.expense / kpis.revenue, 1],
    );

    const buffer = await wb.xlsx.writeBuffer();
    const stamp = new Date().toISOString().slice(0, 10);

    return new NextResponse(buffer as ArrayBuffer, {
      headers: {
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'content-disposition': `attachment; filename="arihant-mis-${stamp}.xlsx"`,
        'cache-control': 'no-store',
      },
    });
  } catch (error) {
    return toErrorResponse(error, 'export.excel');
  }
}

function addMeasure(ws: ExcelJS.Worksheet, label: string, value: number | null, format: string) {
  const row = ws.addRow([label, value]);
  row.getCell(2).numFmt = format;
  row.getCell(1).font = { bold: true };
}

function sheet(
  wb: ExcelJS.Workbook,
  name: string,
  headers: string[],
  rows: (string | number | null)[][],
  formats: (string | null)[],
  totals?: (string | number | null)[],
) {
  const ws = wb.addWorksheet(name);
  ws.columns = headers.map((h, i) => ({ header: h, width: i === 0 ? 30 : 18 }));

  const header = ws.getRow(1);
  header.font = { bold: true };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
  header.border = { bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } } };

  for (const r of rows) {
    const row = ws.addRow(r);
    formats.forEach((f, i) => { if (f) row.getCell(i + 1).numFmt = f; });
  }

  if (totals) {
    const row = ws.addRow(totals);
    row.font = { bold: true };
    row.border = { top: { style: 'thin', color: { argb: 'FF94A3B8' } } };
    formats.forEach((f, i) => { if (f) row.getCell(i + 1).numFmt = f; });
    row.getCell(1).value = 'Total';
  }

  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };
}

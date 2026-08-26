/**
 * File readers. Each produces the same neutral `RawGrid[]`, so everything
 * downstream is format-agnostic.
 */

import ExcelJS from 'exceljs';
import Papa from 'papaparse';
import type { RawGrid } from './types';

export type SupportedFormat = 'xlsx' | 'csv';

export function detectFormat(filename: string, buffer: Buffer): SupportedFormat {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  // XLSX is a ZIP: "PK\x03\x04".
  const isZip = buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;

  if (ext === 'xlsx' || ext === 'xlsm' || isZip) return 'xlsx';
  if (ext === 'csv' || ext === 'txt' || ext === 'tsv') return 'csv';

  // Legacy .xls is the BIFF compound-document format, which ExcelJS cannot
  // read. Fail with an instruction rather than a stack trace.
  if (ext === 'xls') {
    throw new ImportFormatError(
      'The legacy .xls format is not supported.',
      'Open the file in Excel and use "Save As" to save it as .xlsx, then upload it again.',
    );
  }

  throw new ImportFormatError(
    `Unrecognised file type ".${ext}".`,
    'Upload a .xlsx or .csv file.',
  );
}

export class ImportFormatError extends Error {
  constructor(message: string, readonly remedy: string) {
    super(message);
    this.name = 'ImportFormatError';
  }
}

/**
 * Read every worksheet into a grid.
 *
 * Cell *values* are taken, never formulas or cached display strings, so a
 * workbook whose formulas have not been recalculated still imports the numbers
 * Excel last computed. Merged cells yield the value in their top-left cell and
 * null elsewhere, which is what the header detector expects of title rows.
 */
export async function readXlsx(buffer: Buffer): Promise<RawGrid[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);

  const grids: RawGrid[] = [];
  let index = 0;

  wb.eachSheet((worksheet) => {
    const rows: unknown[][] = [];
    const rowCount = worksheet.rowCount;
    const colCount = worksheet.columnCount;

    for (let r = 1; r <= rowCount; r++) {
      const row = worksheet.getRow(r);
      const out = new Array<unknown>(colCount);
      for (let c = 1; c <= colCount; c++) {
        out[c - 1] = normalizeCell(row.getCell(c).value);
      }
      rows.push(out);
    }

    grids.push({ name: worksheet.name, sheetIndex: index++, rows });
  });

  return grids;
}

/** Flatten ExcelJS's rich cell union into a plain scalar. */
function normalizeCell(value: ExcelJS.CellValue): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') return Number.isNaN(value) ? null : value;
  if (typeof value === 'string' || typeof value === 'boolean') return value;

  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;

    // Formula cell: use the cached result.
    if ('result' in v) {
      const result = v.result;
      // ExcelJS coerces a string-typed formula result (`t="str"`) through the
      // cell's number format, so a text value in a date-formatted cell arrives
      // as an Invalid Date (and a numeric format yields NaN). Either way the
      // value is unusable and, left alone, poisons column profiling: an
      // Invalid Date is neither blank nor parseable, so the column reads as
      // text and its dimension is lost.
      //
      // For Google Sheets exports the true value is repeated verbatim as the
      // IFERROR fallback, so recover it from the formula instead.
      if (isUnusableResult(result)) {
        const recovered = recoverGoogleSheetsFallback(v.formula ?? v.sharedFormula);
        return recovered ?? null;
      }
      return normalizeCell(result as ExcelJS.CellValue);
    }
    // ExcelJS omits `result` entirely when the cached value is zero, so a
    // formula cell with no result is a zero, not an unknown. Verified against
    // the raw sheet XML for this workbook: `<f .../><v>0</v>` arrives here as
    // `{formula, ref, shareType}`. Without this branch the cell stringifies to
    // "[object Object]" and every formula column is misread as text — which
    // silently drops `Total Income`, `Total Expense` and `Profit`.
    // Reconciliation (docs/mis-specification.md §7) is the backstop: if this
    // assumption were ever wrong, the profit identity would fail loudly.
    if ('formula' in v || 'sharedFormula' in v) return 0;
    // Error cell (#N/A etc.) — keep the token so the profiler can see it.
    if ('error' in v) return String(v.error);
    // Rich text.
    if ('richText' in v && Array.isArray(v.richText)) {
      return (v.richText as { text: string }[]).map((t) => t.text).join('');
    }
    // Hyperlink.
    if ('text' in v) return normalizeCell(v.text as ExcelJS.CellValue);
    if ('hyperlink' in v) return String(v.hyperlink);
  }

  return String(value);
}

/** NaN or Invalid Date — a result that carries no information. */
function isUnusableResult(result: unknown): boolean {
  if (typeof result === 'number') return Number.isNaN(result);
  if (result instanceof Date) return Number.isNaN(result.getTime());
  return false;
}

/**
 * Recover a cell value from a Google Sheets `__xludf.DUMMYFUNCTION` formula.
 *
 * Sheets exports functions Excel does not have as
 * `IFERROR(__xludf.DUMMYFUNCTION("""COMPUTED_VALUE"""), <last computed value>)`,
 * so the fallback argument is the value the sheet last displayed. The Arihant
 * workbook's `Comparison` sheet is built this way.
 */
function recoverGoogleSheetsFallback(formula: unknown): string | number | null {
  if (typeof formula !== 'string') return null;
  if (!formula.includes('__xludf.DUMMYFUNCTION')) return null;

  // Take the final argument of the outer IFERROR.
  const match = formula.match(/,\s*(?:"((?:[^"]|"")*)"|(-?[\d.]+))\s*\)\s*$/);
  if (!match) return null;

  if (match[1] !== undefined) return match[1].replace(/""/g, '"');
  const n = Number(match[2]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Read a delimited text file. The delimiter is auto-detected by Papa Parse, so
 * comma, semicolon and tab files all work. Values stay as strings; coercion is
 * the profiler's job.
 */
export function readCsv(buffer: Buffer, sheetName = 'Sheet1'): RawGrid[] {
  // Strip a UTF-8 BOM, which otherwise corrupts the first header.
  let text = buffer.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const result = Papa.parse<string[]>(text, {
    header: false,
    skipEmptyLines: false,
    dynamicTyping: false,
  });

  const rows = (result.data as string[][]).map((r) => r.map((v) => (v === '' ? null : v)));

  return [{ name: sheetName, sheetIndex: 0, rows }];
}

export async function readFile(filename: string, buffer: Buffer): Promise<RawGrid[]> {
  const format = detectFormat(filename, buffer);
  if (format === 'xlsx') return readXlsx(buffer);
  return readCsv(buffer, filename.replace(/\.[^.]+$/, ''));
}

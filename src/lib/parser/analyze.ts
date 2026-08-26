/**
 * Workbook analysis — the read-only pass that produces the import preview.
 *
 * Nothing is written to the database here. The operator sees exactly what the
 * parser decided and why, and confirms before any fact is created
 * (build spec §21).
 */

import { createHash } from 'node:crypto';
import { readFile } from './readers';
import {
  detectHeaderRow,
  detectTotalRows,
  isRowBlank,
  profileColumn,
  resolveHeaders,
  trimGrid,
} from './structure';
import { mapColumns, sheetSignature, signatureSimilarity } from './mapping';
import { detectSubtotalColumns } from './subtotals';
import { normalizeHeader } from './values';
import type {
  ColumnMapping,
  ParseWarning,
  RawGrid,
  SheetAnalysis,
  SheetRole,
  WorkbookAnalysis,
} from './types';

export interface SavedProfile {
  id: string;
  name: string;
  version: number;
  signature: string;
  mapping: unknown;
}

export interface AnalyzeOptions {
  savedProfiles?: SavedProfile[];
  /** Operator overrides from the preview screen: `${sheetIndex}:${columnIndex}` -> field. */
  overrides?: Record<string, string | null>;
}

export async function analyzeWorkbook(
  filename: string,
  buffer: Buffer,
  options: AnalyzeOptions = {},
): Promise<WorkbookAnalysis> {
  const fileHash = createHash('sha256').update(buffer).digest('hex');
  const grids = await readFile(filename, buffer);

  const sheets: SheetAnalysis[] = [];
  for (const grid of grids) {
    sheets.push(analyzeSheet(grid, options));
  }

  assignSheetRoles(sheets);

  const signature = sheets
    .filter((s) => s.role !== 'SKIPPED')
    .map((s) => sheetSignature(s.name, s.headers))
    .join(' ## ');

  const matchedProfile = matchProfile(signature, options.savedProfiles ?? []);

  const warnings: ParseWarning[] = [];
  const blockers: ParseWarning[] = [];

  const factSheets = sheets.filter((s) => s.role === 'FACTS');
  if (factSheets.length === 0) {
    blockers.push({
      code: 'NO_FACT_SHEET',
      severity: 'error',
      message: 'No sheet in this file contains recognisable financial data.',
      remedy:
        'The importer looks for a sheet with dimension columns (branch, stream, month) alongside numeric amount columns. Check that the correct file was uploaded, or map the columns manually.',
      context: { sheets: sheets.map((s) => ({ name: s.name, role: s.role, reason: s.roleReason })) },
    });
  }

  for (const sheet of sheets) {
    if (sheet.role === 'SKIPPED') continue;
    for (const w of sheet.warnings) {
      (w.severity === 'error' ? blockers : warnings).push({
        ...w,
        context: { ...(w.context ?? {}), sheet: sheet.name },
      });
    }
  }

  // Every fact sheet needs the dimensions the MIS keys on.
  for (const sheet of factSheets) {
    const fields = new Set(sheet.mappings.map((m) => m.field).filter(Boolean));
    const missing = (['branch', 'month'] as const).filter((f) => !fields.has(f));
    if (missing.length > 0) {
      blockers.push({
        code: 'MISSING_REQUIRED_DIMENSION',
        severity: 'error',
        message: `Sheet "${sheet.name}" has no ${missing.join(' or ')} column, which the MIS needs to place these figures in time and place.`,
        remedy: `Map an existing column to ${missing.join(' / ')} in the preview below, or upload a file that includes ${missing.length > 1 ? 'those columns' : 'that column'}.`,
        context: { sheet: sheet.name, missing },
      });
    }
  }

  const needsConfirmation = sheets.some(
    (s) => s.role === 'FACTS' && s.mappings.some((m) => m.needsConfirmation),
  );

  return {
    filename,
    fileHash,
    fileSize: buffer.byteLength,
    sheets,
    signature,
    warnings,
    blockers,
    readyToImport: blockers.length === 0 && !needsConfirmation,
    matchedProfile,
  };
}

function analyzeSheet(rawGrid: RawGrid, options: AnalyzeOptions): SheetAnalysis {
  const grid = trimGrid(rawGrid);
  const warnings: ParseWarning[] = [];

  if (grid.rows.length === 0) {
    return emptySheet(grid, 'sheet is empty');
  }

  const detected = detectHeaderRow(grid.rows);
  if (!detected) {
    return emptySheet(grid, 'no header row could be identified');
  }

  const { headerRow, dataStartRow } = detected;
  const headerCells = grid.rows[headerRow - 1] ?? [];
  const columnCount = Math.max(...grid.rows.map((r) => r.length), headerCells.length);
  const headers = resolveHeaders(headerCells, columnCount);

  if (headerRow > 1) {
    warnings.push({
      code: 'HEADER_NOT_FIRST_ROW',
      severity: 'info',
      message: `Header detected on row ${headerRow}; rows 1–${headerRow - 1} were treated as title/preamble and skipped.`,
      context: { headerRow, skipped: grid.rows.slice(0, headerRow - 1).map((r) => r.filter((c) => c !== null && c !== '')) },
    });
  }

  const dataRows = grid.rows.slice(dataStartRow - 1);
  const columns = headers.map((header, c) =>
    profileColumn(c, header, dataRows.map((r) => r[c] ?? null)),
  );

  let { mappings, layout, warnings: mapWarnings } = mapColumns(columns);
  warnings.push(...mapWarnings);

  const textCols = mappings.filter((m) => m.role === 'dimension').map((m) => m.columnIndex);
  const numCols = mappings
    .filter((m) => m.role === 'measure' || m.role === 'account-measure' || m.role === 'subtotal')
    .map((m) => m.columnIndex);

  const totalRowSet = detectTotalRows(grid.rows, dataStartRow - 1, textCols, numCols);

  // Establish subtotal columns arithmetically, then demote them so they are
  // reconciled against rather than ingested as facts.
  const subtotals = detectSubtotalColumns(columns, dataRows, totalRowSet, dataStartRow);
  if (subtotals.length > 0) {
    const byColumn = new Map(subtotals.map((s) => [s.columnIndex, s]));
    mappings = mappings.map((m) => {
      const found = byColumn.get(m.columnIndex);
      if (!found) return m;
      return {
        ...m,
        role: 'subtotal' as const,
        needsConfirmation: false,
        reasons: [`${found.explanation} — kept for reconciliation, not ingested as a fact`],
      };
    });

    warnings.push({
      code: 'SUBTOTAL_COLUMNS_DETECTED',
      severity: 'info',
      message: `${subtotals.length} column${subtotals.length === 1 ? '' : 's'} verified as arithmetic totals of other columns and excluded from the imported figures, so nothing is double-counted.`,
      context: { columns: subtotals.map((s) => ({ column: headers[s.columnIndex], relation: s.relation, explanation: s.explanation })) },
    });
  }

  mappings = applyOverrides(mappings, grid.sheetIndex, options.overrides);

  const totalRowNumbers = [...totalRowSet];
  if (totalRowNumbers.length > 0) {
    warnings.push({
      code: 'TOTAL_ROWS_DETECTED',
      severity: 'info',
      message: `${totalRowNumbers.length} total/subtotal row${totalRowNumbers.length === 1 ? '' : 's'} detected and excluded from the imported figures; they will be used to validate the totals instead.`,
      context: { rows: totalRowNumbers.slice(0, 25) },
    });
  }

  const populatedRows = grid.rows
    .slice(dataStartRow - 1)
    .filter((r, i) => !isRowBlank(r) && !totalRowNumbers.includes(dataStartRow + i)).length;

  return {
    name: grid.name,
    sheetIndex: grid.sheetIndex,
    role: 'FACTS',
    roleReason: '',
    layout,
    headerRow,
    dataStartRow,
    rowCount: populatedRows,
    columnCount,
    headers,
    columns,
    mappings,
    totalRowNumbers,
    warnings,
  };
}

function applyOverrides(
  mappings: ColumnMapping[],
  sheetIndex: number,
  overrides?: Record<string, string | null>,
): ColumnMapping[] {
  if (!overrides) return mappings;

  return mappings.map((m) => {
    const key = `${sheetIndex}:${m.columnIndex}`;
    if (!(key in overrides)) return m;
    const field = overrides[key];
    return {
      ...m,
      field: (field as ColumnMapping['field']) ?? null,
      confidence: 1,
      needsConfirmation: false,
      reasons: ['set manually by an operator'],
      role: field === null ? 'ignored' : m.role === 'account-measure' ? 'measure' : m.role,
    };
  });
}

function emptySheet(grid: RawGrid, reason: string): SheetAnalysis {
  return {
    name: grid.name,
    sheetIndex: grid.sheetIndex,
    role: 'SKIPPED',
    roleReason: reason,
    layout: 'UNKNOWN',
    headerRow: null,
    dataStartRow: null,
    rowCount: 0,
    columnCount: 0,
    headers: [],
    columns: [],
    mappings: [],
    totalRowNumbers: [],
    warnings: [],
  };
}

/**
 * Decide what each sheet is for.
 *
 * A workbook typically holds one authoritative fact sheet plus derived views of
 * it. Importing the derived sheets as well would double-count, so we classify:
 *
 *   MAPPING — a small reference sheet (account -> group)
 *   FACTS   — the richest sheet at the finest grain
 *   DERIVED — a sheet whose figures are a subset/rollup of the fact sheet
 */
function assignSheetRoles(sheets: SheetAnalysis[]): void {
  const usable = sheets.filter((s) => s.role !== 'SKIPPED');

  for (const sheet of usable) {
    const fields = new Set(sheet.mappings.map((m) => m.field).filter(Boolean));
    const hasAccountAndGroup = fields.has('account') && fields.has('groupHead');
    const hasMeasures = sheet.mappings.some(
      (m) => m.role === 'measure' || m.role === 'account-measure',
    );

    if (hasAccountAndGroup && !hasMeasures) {
      sheet.role = 'MAPPING';
      sheet.roleReason = 'reference sheet: maps account heads to group heads';
    }
  }

  const factCandidates = usable.filter((s) => s.role === 'FACTS');
  if (factCandidates.length <= 1) {
    for (const s of factCandidates) {
      s.roleReason = 'primary financial data';
    }
    return;
  }

  // The richest sheet wins: most distinct accounts, then most rows.
  const scored = factCandidates.map((s) => ({
    sheet: s,
    accounts: s.mappings.filter((m) => m.role === 'account-measure').length,
    rows: s.rowCount,
    periods: periodBreadth(s),
  }));

  scored.sort(
    (a, b) =>
      b.periods - a.periods ||
      b.accounts - a.accounts ||
      b.rows - a.rows,
  );

  const winner = scored[0];
  winner.sheet.roleReason = `primary financial data: ${winner.accounts} account columns across ${winner.periods} period${winner.periods === 1 ? '' : 's'}, ${winner.rows} rows`;

  for (const other of scored.slice(1)) {
    other.sheet.role = 'DERIVED';
    other.sheet.roleReason =
      other.periods < winner.periods
        ? `derived view: covers ${other.periods} of the ${winner.periods} periods in "${winner.sheet.name}"`
        : `derived view: coarser than "${winner.sheet.name}" (${other.accounts} vs ${winner.accounts} account columns)`;

    other.sheet.warnings.push({
      code: 'DERIVED_SHEET_SKIPPED',
      severity: 'info',
      message: `Sheet "${other.sheet.name}" was not imported — ${other.sheet.roleReason}. Importing it as well would double-count these amounts.`,
      remedy: 'The MIS regenerates this view from the primary sheet, so nothing is lost.',
    });
  }
}

/** How many distinct periods a sheet covers, from its month column's values. */
function periodBreadth(sheet: SheetAnalysis): number {
  const monthMapping = sheet.mappings.find((m) => m.field === 'month');
  if (!monthMapping) return 0;
  const col = sheet.columns.find((c) => c.index === monthMapping.columnIndex);
  return col?.stats.distinct ?? 0;
}

function matchProfile(signature: string, profiles: SavedProfile[]): WorkbookAnalysis['matchedProfile'] {
  let best: { profile: SavedProfile; similarity: number } | null = null;

  for (const profile of profiles) {
    const sim = compareWorkbookSignatures(signature, profile.signature);
    if (!best || sim > best.similarity) best = { profile, similarity: sim };
  }

  if (!best || best.similarity < 0.6) return undefined;

  return {
    id: best.profile.id,
    name: best.profile.name,
    version: best.profile.version,
    similarity: best.similarity,
  };
}

function compareWorkbookSignatures(a: string, b: string): number {
  const sheetsA = a.split(' ## ');
  const sheetsB = b.split(' ## ');
  if (sheetsA.length === 0 || sheetsB.length === 0) return 0;

  // Best-match each sheet, then average.
  let total = 0;
  for (const sa of sheetsA) {
    let best = 0;
    for (const sb of sheetsB) best = Math.max(best, signatureSimilarity(sa, sb));
    total += best;
  }
  return total / sheetsA.length;
}

export { normalizeHeader };
export type { SheetRole };

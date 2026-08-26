/**
 * Structural analysis: where does the real table start, and what does each
 * column contain?
 *
 * Nothing here looks at business meaning — that is mapping.ts. This layer only
 * answers "which row is the header" and "what shape are these values", which is
 * what makes the parser survive title rows, blank rows and reordered columns.
 */

import {
  isBlank,
  normalizeHeader,
  parseDate,
  parseFinancialYearToken,
  parseMonthToken,
  parseNumber,
  parseQuarterToken,
  looksPercentage,
} from './values';
import { TOTAL_ROW_LABELS } from './dictionary';
import type { CellStats, ColumnProfile, RawGrid, ValueKind } from './types';

const MAX_HEADER_SCAN_ROWS = 30;
const SAMPLE_LIMIT = 12;

/**
 * Find the header row by scoring candidates rather than assuming row 1.
 *
 * A header row is short, dense, textual, unique, and — decisively — is followed
 * by rows that look *different* from it (data, not more prose). Title and
 * subtitle rows fail on density and on the contrast test.
 */
export function detectHeaderRow(rows: unknown[][]): { headerRow: number; dataStartRow: number } | null {
  const limit = Math.min(rows.length, MAX_HEADER_SCAN_ROWS);
  let best: { index: number; score: number } | null = null;

  for (let i = 0; i < limit; i++) {
    const row = rows[i] ?? [];
    const cells = row.map((c) => (isBlank(c) ? null : c));
    const filled = cells.filter((c) => c !== null);
    if (filled.length < 2) continue;

    // Density across the row's own span.
    const lastFilled = cells.reduce<number>((acc, c, idx) => (c !== null ? idx : acc), -1);
    const span = lastFilled + 1;
    const density = filled.length / Math.max(span, 1);

    // Headers are text, not numbers.
    const numericCount = filled.filter((c) => parseNumber(c) !== null).length;
    const textRatio = 1 - numericCount / filled.length;

    // Headers are distinct.
    const normalized = filled.map((c) => normalizeHeader(c)).filter((s) => s !== '');
    const uniqueRatio = normalized.length ? new Set(normalized).size / normalized.length : 0;

    // Headers are short labels, not sentences.
    const avgLen = normalized.reduce((s, v) => s + v.length, 0) / Math.max(normalized.length, 1);
    const lengthScore = avgLen === 0 ? 0 : avgLen <= 40 ? 1 : Math.max(0, 1 - (avgLen - 40) / 60);

    // Contrast: the rows beneath should be more numeric than this row.
    const contrast = contrastWithFollowing(rows, i, span);

    const score =
      density * 0.22 +
      textRatio * 0.24 +
      uniqueRatio * 0.18 +
      lengthScore * 0.10 +
      contrast * 0.26;

    if (!best || score > best.score) best = { index: i, score };
  }

  if (!best || best.score < 0.45) return null;

  // Skip any blank rows between the header and the first data row.
  let dataStart = best.index + 1;
  while (dataStart < rows.length && isRowBlank(rows[dataStart])) dataStart++;

  return { headerRow: best.index + 1, dataStartRow: dataStart + 1 };
}

function contrastWithFollowing(rows: unknown[][], headerIdx: number, span: number): number {
  const following = rows.slice(headerIdx + 1, headerIdx + 9).filter((r) => !isRowBlank(r));
  if (following.length === 0) return 0;

  let numericCells = 0;
  let totalCells = 0;
  for (const r of following) {
    for (let c = 0; c < span; c++) {
      const v = r[c];
      if (isBlank(v)) continue;
      totalCells++;
      if (parseNumber(v) !== null) numericCells++;
    }
  }
  if (totalCells === 0) return 0;

  const dataNumericRatio = numericCells / totalCells;

  // Also reward rows that keep filling the same span (a real table body).
  const spanConsistency =
    following.reduce((acc, r) => {
      const filled = r.slice(0, span).filter((c) => !isBlank(c)).length;
      return acc + filled / Math.max(span, 1);
    }, 0) / following.length;

  return dataNumericRatio * 0.6 + spanConsistency * 0.4;
}

export function isRowBlank(row: unknown[] | undefined): boolean {
  if (!row) return true;
  return row.every((c) => isBlank(c));
}

/**
 * Resolve duplicate/blank headers to stable unique names so downstream code can
 * key on them. Blank headers become `Column <letter>`.
 */
export function resolveHeaders(headerRow: unknown[], columnCount: number): string[] {
  const seen = new Map<string, number>();
  const out: string[] = [];
  for (let c = 0; c < columnCount; c++) {
    let name = isBlank(headerRow[c]) ? '' : String(headerRow[c]).trim();
    if (name === '') name = `Column ${columnLetter(c)}`;
    const key = name.toUpperCase();
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    out.push(n === 0 ? name : `${name} (${n + 1})`);
  }
  return out;
}

export function columnLetter(index: number): string {
  let s = '';
  let i = index;
  do {
    s = String.fromCharCode(65 + (i % 26)) + s;
    i = Math.floor(i / 26) - 1;
  } while (i >= 0);
  return s;
}

/** Profile a column from its values. Header text is not consulted here. */
export function profileColumn(
  index: number,
  header: string,
  values: unknown[],
): ColumnProfile {
  const stats: CellStats = {
    total: values.length,
    nonEmpty: 0,
    numericLike: 0,
    percentLike: 0,
    dateLike: 0,
    monthTokenLike: 0,
    quarterTokenLike: 0,
    fyTokenLike: 0,
    distinct: 0,
    samples: [],
    min: null,
    max: null,
    sum: 0,
    negatives: 0,
  };

  const distinct = new Set<string>();

  for (const v of values) {
    if (isBlank(v)) continue;
    stats.nonEmpty++;
    if (distinct.size < 5000) distinct.add(String(v));
    if (stats.samples.length < SAMPLE_LIMIT) stats.samples.push(v);

    if (looksPercentage(v)) stats.percentLike++;

    const n = parseNumber(v);
    if (n !== null) {
      stats.numericLike++;
      stats.sum += n;
      if (n < 0) stats.negatives++;
      stats.min = stats.min === null ? n : Math.min(stats.min, n);
      stats.max = stats.max === null ? n : Math.max(stats.max, n);
    } else {
      // Only test token shapes on non-numeric values; "3" is not a quarter.
      if (parseMonthToken(v)) stats.monthTokenLike++;
      if (parseQuarterToken(v)) stats.quarterTokenLike++;
      if (parseFinancialYearToken(v)) stats.fyTokenLike++;
    }
    if (parseDate(v) !== null && typeof v !== 'number') stats.dateLike++;
  }

  stats.distinct = distinct.size;

  return {
    index,
    header,
    normalizedHeader: normalizeHeader(header),
    kind: classifyKind(stats),
    stats,
  };
}

function classifyKind(s: CellStats): ValueKind {
  if (s.nonEmpty === 0) return 'empty';
  const r = (n: number) => n / s.nonEmpty;

  // Token shapes are checked before generic text and before numbers, because
  // they are far more specific.
  if (r(s.monthTokenLike) >= 0.8) return 'monthToken';
  if (r(s.quarterTokenLike) >= 0.8) return 'quarterToken';
  if (r(s.fyTokenLike) >= 0.8) return 'financialYearToken';
  if (r(s.percentLike) >= 0.6) return 'percentage';
  if (r(s.numericLike) >= 0.85) return 'number';
  if (r(s.dateLike) >= 0.8) return 'date';
  return 'text';
}

/**
 * Detect aggregate rows. A row is a total when a dimension cell carries a total
 * label, or when its dimension cells are empty while its measures are large —
 * the shape a trailing grand-total row takes.
 */
export function detectTotalRows(
  rows: unknown[][],
  dataStartIndex: number,
  textColumns: number[],
  numericColumns: number[],
): Set<number> {
  const totals = new Set<number>();

  for (let i = dataStartIndex; i < rows.length; i++) {
    const row = rows[i];
    if (isRowBlank(row)) continue;

    const labelHit = textColumns.some((c) => {
      const v = row[c];
      if (isBlank(v)) return false;
      const norm = normalizeHeader(v);
      return TOTAL_ROW_LABELS.some((t) => norm === t || norm.startsWith(`${t} `) || norm.endsWith(` ${t}`));
    });

    if (labelHit) {
      totals.add(i + 1);
      continue;
    }

    // Dimension-less rows carrying numbers are aggregates.
    if (textColumns.length > 0 && numericColumns.length > 0) {
      const dimsEmpty = textColumns.every((c) => isBlank(row[c]));
      const hasNumbers = numericColumns.some((c) => {
        const n = parseNumber(row[c]);
        return n !== null && n !== 0;
      });
      if (dimsEmpty && hasNumbers) totals.add(i + 1);
    }
  }

  return totals;
}

/** Trim trailing rows/columns that Excel leaves behind as empty padding. */
export function trimGrid(grid: RawGrid): RawGrid {
  const rows = grid.rows;
  let lastRow = -1;
  let lastCol = -1;

  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < (rows[r]?.length ?? 0); c++) {
      if (!isBlank(rows[r][c])) {
        if (r > lastRow) lastRow = r;
        if (c > lastCol) lastCol = c;
      }
    }
  }

  if (lastRow < 0) return { ...grid, rows: [] };

  const trimmed = rows.slice(0, lastRow + 1).map((r) => {
    const out = new Array<unknown>(lastCol + 1);
    for (let c = 0; c <= lastCol; c++) out[c] = r?.[c] ?? null;
    return out;
  });

  return { ...grid, rows: trimmed };
}

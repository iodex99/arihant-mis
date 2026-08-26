/**
 * Deterministic value coercion.
 *
 * Every routine here is pure and total: it returns null rather than throwing,
 * so a single malformed cell can never abort an import. No heuristics that
 * depend on locale settings or on the machine's clock.
 */

/** Uppercase, strip punctuation, collapse whitespace. Used for all matching. */
export function normalizeHeader(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/[ ​]/g, ' ')
    .replace(/[^\p{L}\p{N}\s%&/-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

/** Key used to match account names across imports (ignores case and spacing). */
export function normalizeAccountName(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/[ ​]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

export function isBlank(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  return false;
}

const CURRENCY_CHARS = /[₹$£€¥]|\bRS\.?\b|\bINR\b/gi;
const ERROR_TOKENS = new Set([
  '#N/A', '#REF!', '#VALUE!', '#DIV/0!', '#NAME?', '#NULL!', '#NUM!', 'NA', 'N/A', '-', '--',
]);

/**
 * Parse a number from anything a spreadsheet might hold.
 * Handles: currency symbols, thousands separators (Western and Indian
 * grouping), parenthesised negatives, trailing CR/DR, percentages, and
 * Excel error tokens.
 *
 * Returns null when the value is not a number. `1,23,456.78` (Indian
 * grouping) and `1,234,567.89` both parse.
 */
export function parseNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return null;
  if (value instanceof Date) return null;

  let s = String(value).trim();
  if (s === '') return null;
  if (ERROR_TOKENS.has(s.toUpperCase())) return null;

  let negative = false;

  // (1,234.00) => -1234.00
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1).trim();
  }

  s = s.replace(CURRENCY_CHARS, '').trim();

  // Trailing accounting markers: 1,234.00 CR / DR
  const crdr = s.match(/\b(CR|DR)\.?$/i);
  if (crdr) {
    if (crdr[1].toUpperCase() === 'CR') negative = !negative;
    s = s.slice(0, crdr.index).trim();
  }

  // Leading sign
  if (s.startsWith('+')) s = s.slice(1).trim();
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1).trim();
  }

  const hadPercent = s.endsWith('%');
  if (hadPercent) s = s.slice(0, -1).trim();

  // Strip grouping separators. Accept both 1,234,567.89 and 12,34,567.89.
  if (/^\d{1,3}(,\d{2,3})*(\.\d+)?$/.test(s)) {
    s = s.replace(/,/g, '');
  } else if (/^\d+(\.\d+)?$/.test(s)) {
    // already clean
  } else if (/^[\d,]+(\.\d+)?$/.test(s)) {
    // Irregular grouping — still unambiguous once separators are removed.
    s = s.replace(/,/g, '');
  } else {
    return null;
  }

  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  const signed = negative ? -n : n;
  return hadPercent ? signed / 100 : signed;
}

/** True when the raw value is written as a percentage. */
export function looksPercentage(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return /%\s*$/.test(value.trim());
}

const MONTH_NAMES: Record<string, number> = {
  JAN: 1, JANUARY: 1, FEB: 2, FEBRUARY: 2, MAR: 3, MARCH: 3, APR: 4, APRIL: 4,
  MAY: 5, JUN: 6, JUNE: 6, JUL: 7, JULY: 7, AUG: 8, AUGUST: 8,
  SEP: 9, SEPT: 9, SEPTEMBER: 9, OCT: 10, OCTOBER: 10, NOV: 11, NOVEMBER: 11,
  DEC: 12, DECEMBER: 12,
};

export interface MonthToken {
  year: number;
  month: number;
  /** Original text, preserved for display. */
  label: string;
}

/**
 * Parse a month token. Recognises the Arihant workbook's `Oct'25` alongside
 * the other forms an export might use: `Oct-25`, `October 2025`, `2025-10`,
 * `10/2025`, and real Date values.
 *
 * Two-digit years resolve to 2000..2099 — every Arihant fiscal year is in that
 * range, and guessing a century from the current date would make imports
 * non-reproducible.
 */
export function parseMonthToken(value: unknown): MonthToken | null {
  if (value === null || value === undefined) return null;

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return {
      year: value.getUTCFullYear(),
      month: value.getUTCMonth() + 1,
      label: `${Object.keys(MONTH_NAMES).find((k) => MONTH_NAMES[k] === value.getUTCMonth() + 1 && k.length === 3)}'${String(value.getUTCFullYear()).slice(-2)}`,
    };
  }

  const label = String(value).trim();
  if (label === '') return null;

  const s = label.toUpperCase().replace(/[‘’´`]/g, "'");

  // Oct'25 | Oct-25 | Oct 25 | Oct/2025 | October 2025
  let m = s.match(/^([A-Z]{3,9})\s*[''\-/\s]\s*(\d{2}|\d{4})$/);
  if (m && MONTH_NAMES[m[1]]) {
    return { year: expandYear(m[2]), month: MONTH_NAMES[m[1]], label };
  }

  // 2025-10 | 2025/10
  m = s.match(/^(\d{4})[-/](\d{1,2})$/);
  if (m) {
    const mo = Number(m[2]);
    if (mo >= 1 && mo <= 12) return { year: Number(m[1]), month: mo, label };
  }

  // 10-2025 | 10/2025
  m = s.match(/^(\d{1,2})[-/](\d{4})$/);
  if (m) {
    const mo = Number(m[1]);
    if (mo >= 1 && mo <= 12) return { year: Number(m[2]), month: mo, label };
  }

  // Bare month name — no year available, so not a usable period token.
  return null;
}

function expandYear(raw: string): number {
  const n = Number(raw);
  return raw.length === 4 ? n : 2000 + n;
}

/** `Q3`, `Q 3`, `QUARTER 3`, `Q3 2025-26`. */
export function parseQuarterToken(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim().toUpperCase();
  const m = s.match(/^Q(?:UARTER)?\s*([1-4])\b/);
  return m ? `Q${m[1]}` : null;
}

/** `FY 2025-26`, `2025-26`, `FY2025-2026`, `FY 25-26`. */
export function parseFinancialYearToken(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim().toUpperCase().replace(/\s+/g, '');
  const m = s.match(/^(?:FY)?(\d{4})[-/](\d{2}|\d{4})$/);
  if (m) {
    const start = Number(m[1]);
    const end = m[2].length === 4 ? Number(m[2]) : 2000 + Number(m[2]);
    if (end === start + 1) return `FY ${start}-${String(end).slice(-2)}`;
  }
  const short = s.match(/^(?:FY)?(\d{2})[-/](\d{2})$/);
  if (short) {
    const start = 2000 + Number(short[1]);
    const end = 2000 + Number(short[2]);
    if (end === start + 1) return `FY ${start}-${String(end).slice(-2)}`;
  }
  return null;
}

/** Excel serial dates and common written forms. */
export function parseDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') {
    // Excel serial: days since 1899-12-30. Reject values that are plainly
    // amounts rather than dates.
    if (value < 1 || value > 60000) return null;
    const ms = Math.round((value - 25569) * 86400 * 1000);
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (s === '') return null;

  // dd/mm/yyyy and dd-mm-yyyy — Indian convention, which is what Tally exports.
  const dmy = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (dmy) {
    const d = Number(dmy[1]);
    const mo = Number(dmy[2]);
    const y = expandYear(dmy[3]);
    if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12) {
      return new Date(Date.UTC(y, mo - 1, d));
    }
  }

  // ISO
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    return new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));
  }

  // dd-Mon-yyyy (Tally's default display format)
  const dMonY = s.toUpperCase().match(/^(\d{1,2})[-\s]([A-Z]{3,9})[-\s](\d{2,4})$/);
  if (dMonY && MONTH_NAMES[dMonY[2]]) {
    return new Date(Date.UTC(expandYear(dMonY[3]), MONTH_NAMES[dMonY[2]] - 1, Number(dMonY[1])));
  }

  return null;
}

/** Round to 2dp without accumulating binary float drift. */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Compare two money amounts. Tolerance scales with the number of rows summed,
 * because each row contributes up to half a paisa of representation error.
 */
export function amountsAgree(a: number, b: number, rowCount = 1): boolean {
  const tolerance = Math.max(0.05, rowCount * 0.005);
  return Math.abs(a - b) <= tolerance;
}

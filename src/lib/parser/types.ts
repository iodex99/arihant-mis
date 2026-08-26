/**
 * Universal importer — shared types.
 *
 * The parser never assumes a fixed column layout. It reads a workbook into a
 * neutral grid, then reasons about that grid: where the header is, what each
 * column means, which rows are totals. See docs/parser.md.
 */

/** Canonical fields the importer knows how to produce. */
export const CANONICAL_FIELDS = [
  'stream',
  'branch',
  'abbreviation',
  'centre',
  'particulars',
  'month',
  'quarter',
  'financialYear',
  'status',
  'revenue',
  'expense',
  'profit',
  'totalRevenue',
  'indirectExpenses',
  'account',
  'amount',
  'groupHead',
  'accountType',
  'date',
] as const;

export type CanonicalField = (typeof CANONICAL_FIELDS)[number];

/** How a column's values behave, inferred from the values themselves. */
export type ValueKind =
  | 'number'
  | 'currency'
  | 'percentage'
  | 'date'
  | 'monthToken'
  | 'quarterToken'
  | 'financialYearToken'
  | 'text'
  | 'empty';

export interface CellStats {
  total: number;
  nonEmpty: number;
  numericLike: number;
  percentLike: number;
  dateLike: number;
  monthTokenLike: number;
  quarterTokenLike: number;
  fyTokenLike: number;
  distinct: number;
  /** Up to 12 representative non-empty values, for the preview UI. */
  samples: unknown[];
  min: number | null;
  max: number | null;
  sum: number;
  negatives: number;
}

export interface ColumnProfile {
  index: number;
  /** Header exactly as it appears in the file. */
  header: string;
  /** Uppercased, punctuation-stripped, whitespace-collapsed. */
  normalizedHeader: string;
  kind: ValueKind;
  stats: CellStats;
}

export interface FieldCandidate {
  field: CanonicalField;
  confidence: number;
  /** Human-readable reasons, shown verbatim in the import preview. */
  reasons: string[];
}

export interface ColumnMapping {
  columnIndex: number;
  header: string;
  /** null when the column is intentionally unmapped (e.g. a subtotal column). */
  field: CanonicalField | null;
  confidence: number;
  reasons: string[];
  /** Ranked runners-up, offered in the UI when confirmation is needed. */
  alternatives: FieldCandidate[];
  /** True when confidence is below the auto-accept threshold. */
  needsConfirmation: boolean;
  /** Set when the column is a recognised subtotal, so it is excluded from facts. */
  role: 'dimension' | 'measure' | 'subtotal' | 'account-measure' | 'ignored';
  /**
   * For wide layouts: the account this measure column represents
   * (e.g. "ELECTRICITY EXPENSES").
   */
  accountName?: string;
  accountKind?: 'REVENUE' | 'EXPENSE';
}

export type SheetRole = 'FACTS' | 'MAPPING' | 'DERIVED' | 'SKIPPED';

/** How the facts are laid out in a sheet. */
export type SheetLayout = 'WIDE' | 'LONG' | 'UNKNOWN';

export interface SheetAnalysis {
  name: string;
  sheetIndex: number;
  role: SheetRole;
  roleReason: string;
  layout: SheetLayout;
  /** 1-based row number of the detected header. */
  headerRow: number | null;
  dataStartRow: number | null;
  rowCount: number;
  columnCount: number;
  headers: string[];
  columns: ColumnProfile[];
  mappings: ColumnMapping[];
  /** 1-based row numbers detected as total/subtotal rows. */
  totalRowNumbers: number[];
  warnings: ParseWarning[];
}

export interface ParseWarning {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  /** What the operator can do about it. */
  remedy?: string;
  context?: Record<string, unknown>;
}

export interface WorkbookAnalysis {
  filename: string;
  fileHash: string;
  fileSize: number;
  sheets: SheetAnalysis[];
  /** Structural fingerprint used to match a saved MappingProfile. */
  signature: string;
  warnings: ParseWarning[];
  /** Blocking issues; the import cannot proceed until resolved. */
  blockers: ParseWarning[];
  /** True when every mapping cleared the auto-accept threshold. */
  readyToImport: boolean;
  matchedProfile?: {
    id: string;
    name: string;
    version: number;
    /** 0..1 — how closely the file matches the saved profile. */
    similarity: number;
  };
}

/** A neutral in-memory grid; the only thing sheet readers must produce. */
export interface RawGrid {
  name: string;
  sheetIndex: number;
  /** rows[r][c]; r and c are 0-based. Values are raw (string|number|Date|null). */
  rows: unknown[][];
}

export const AUTO_ACCEPT_CONFIDENCE = 0.8;
export const SUGGEST_CONFIDENCE = 0.35;

/**
 * Column mapping — deciding what each column means.
 *
 * Confidence combines two independent lines of evidence:
 *
 *   header evidence  — exact match, then fuzzy match against known synonyms
 *   value evidence   — does the column actually contain what the field needs
 *
 * Value evidence can *override* header evidence. That is deliberate and is the
 * reason this importer reads the Arihant workbook correctly: its `Quater`
 * column holds `Oct'25` and its `Month` column holds `Q3`. A header-only parser
 * silently swaps the two dimensions; here the month-token signal wins and the
 * swap is reported as a warning rather than propagated into the MIS.
 */

import {
  FIELD_SPECS,
  REVENUE_ACCOUNT_HEADERS,
  SUBTOTAL_HEADERS,
  headerSimilarity,
  type FieldSpec,
} from './dictionary';
import { normalizeHeader } from './values';
import {
  AUTO_ACCEPT_CONFIDENCE,
  SUGGEST_CONFIDENCE,
  type CanonicalField,
  type ColumnMapping,
  type ColumnProfile,
  type FieldCandidate,
  type ParseWarning,
  type SheetLayout,
} from './types';

/** Header-only score for one field, 0..1. */
function headerScore(spec: FieldSpec, normalized: string): { score: number; reason: string | null } {
  if (!normalized) return { score: 0, reason: null };

  if (spec.excludes?.some((rx) => rx.test(normalized))) {
    return { score: 0, reason: null };
  }

  if (spec.exact.includes(normalized)) {
    return { score: 1, reason: `header "${normalized}" is an exact match` };
  }

  // Fuzzy — catches real-world typos such as "Quater" for "Quarter".
  let bestFuzzy = 0;
  let bestTarget = '';
  for (const target of spec.exact) {
    const sim = headerSimilarity(normalized, target);
    if (sim > bestFuzzy) {
      bestFuzzy = sim;
      bestTarget = target;
    }
  }
  if (bestFuzzy >= 0.86) {
    return { score: 0.9 * bestFuzzy, reason: `header resembles "${bestTarget}" (${Math.round(bestFuzzy * 100)}% similar)` };
  }

  // Measure fields stop here: substring and loose-fuzzy matching would claim
  // every account column whose name embeds "expense"/"income"/"profit".
  if (spec.strictHeader) return { score: 0, reason: null };

  for (const token of spec.contains) {
    if (normalized.includes(token)) {
      const coverage = token.length / normalized.length;
      return { score: 0.45 + 0.3 * Math.min(coverage, 1), reason: `header contains "${token}"` };
    }
  }

  if (bestFuzzy >= 0.7) {
    return { score: 0.5 * bestFuzzy, reason: `header loosely resembles "${bestTarget}"` };
  }

  return { score: 0, reason: null };
}

/** Value-shape score for one field, 0..1, plus whether it is decisive. */
function valueScore(spec: FieldSpec, col: ColumnProfile): { score: number; decisive: boolean; reason: string | null } {
  const { kind, stats } = col;

  if (kind === 'empty') return { score: 0, decisive: false, reason: 'column is empty' };

  if (spec.valueSignal) {
    const s = spec.valueSignal(kind);
    if (s >= 1) {
      return { score: 1, decisive: true, reason: `values are ${kind} (e.g. ${formatSample(stats.samples[0])})` };
    }
    if (s > 0) return { score: s, decisive: false, reason: `values look like ${kind}` };
  }

  if (spec.expectKinds.includes(kind)) {
    return { score: 0.7, decisive: false, reason: `values are ${kind}, consistent with ${spec.field}` };
  }

  // A measure field cannot be satisfied by a text column, and vice versa.
  const wantsNumber = spec.expectKinds.includes('number') || spec.expectKinds.includes('currency');
  const isNumber = kind === 'number' || kind === 'currency';
  if (wantsNumber !== isNumber) {
    return { score: 0, decisive: false, reason: `values are ${kind}, but ${spec.field} needs ${wantsNumber ? 'numbers' : 'text'}` };
  }

  return { score: 0.3, decisive: false, reason: null };
}

function formatSample(v: unknown): string {
  if (v === null || v === undefined) return 'blank';
  const s = String(v);
  return s.length > 24 ? `${s.slice(0, 24)}…` : s;
}

/** Rank every canonical field against one column. */
export function scoreColumn(col: ColumnProfile): FieldCandidate[] {
  const out: FieldCandidate[] = [];

  for (const spec of FIELD_SPECS) {
    const h = headerScore(spec, col.normalizedHeader);
    const v = valueScore(spec, col);

    if (h.score === 0 && !v.decisive) continue;
    // Header says yes but the values make it impossible.
    if (v.score === 0 && !v.decisive) continue;

    let confidence: number;
    const reasons: string[] = [];

    if (v.decisive && h.score >= 0.5) {
      // Both agree, and the values are unambiguous.
      confidence = Math.min(1, 0.9 + 0.1 * h.score);
    } else if (v.decisive) {
      // Values are unambiguous but the header disagrees or is unhelpful.
      // Trust the values — this is the swapped-header case.
      confidence = 0.88;
      reasons.push(`header "${col.header}" does not match, but the values are decisive`);
    } else {
      confidence = h.score * 0.6 + v.score * 0.4;
    }

    if (h.reason) reasons.unshift(h.reason);
    if (v.reason) reasons.push(v.reason);

    out.push({ field: spec.field, confidence: Math.min(1, confidence), reasons });
  }

  return out.sort((a, b) => b.confidence - a.confidence);
}

export interface MapSheetResult {
  mappings: ColumnMapping[];
  layout: SheetLayout;
  warnings: ParseWarning[];
}

/**
 * Map every column in a sheet, then resolve conflicts globally: each canonical
 * field may be claimed by at most one column, and the highest-confidence
 * claimant wins.
 */
export function mapColumns(columns: ColumnProfile[]): MapSheetResult {
  const warnings: ParseWarning[] = [];
  const candidatesByColumn = new Map<number, FieldCandidate[]>();

  for (const col of columns) {
    candidatesByColumn.set(col.index, scoreColumn(col));
  }

  // Resolve one-to-one field assignment, best claim first.
  type Claim = { columnIndex: number; candidate: FieldCandidate };
  const claims: Claim[] = [];
  for (const [columnIndex, cands] of candidatesByColumn) {
    for (const candidate of cands) claims.push({ columnIndex, candidate });
  }
  claims.sort((a, b) => b.candidate.confidence - a.candidate.confidence);

  const fieldTaken = new Map<CanonicalField, number>();
  const columnAssigned = new Map<number, FieldCandidate>();

  for (const { columnIndex, candidate } of claims) {
    if (candidate.confidence < SUGGEST_CONFIDENCE) continue;
    if (columnAssigned.has(columnIndex)) continue;
    if (fieldTaken.has(candidate.field)) continue;
    fieldTaken.set(candidate.field, columnIndex);
    columnAssigned.set(columnIndex, candidate);
  }

  const layout = detectLayout(columns, columnAssigned);
  const mappings: ColumnMapping[] = [];

  for (const col of columns) {
    const assigned = columnAssigned.get(col.index);
    const all = candidatesByColumn.get(col.index) ?? [];
    const alternatives = all.filter((c) => c.field !== assigned?.field).slice(0, 3);

    // Subtotal columns are recognised even when they also match a measure
    // field, so they are never ingested as facts.
    if (SUBTOTAL_HEADERS.has(col.normalizedHeader) && (col.kind === 'number' || col.kind === 'currency')) {
      mappings.push({
        columnIndex: col.index,
        header: col.header,
        field: assigned?.field ?? null,
        confidence: assigned?.confidence ?? 1,
        reasons: [`"${col.header}" is a row subtotal — kept for reconciliation, not ingested as a fact`],
        alternatives: [],
        needsConfirmation: false,
        role: 'subtotal',
      });
      continue;
    }

    if (assigned) {
      mappings.push({
        columnIndex: col.index,
        header: col.header,
        field: assigned.field,
        confidence: assigned.confidence,
        reasons: assigned.reasons,
        alternatives,
        needsConfirmation: assigned.confidence < AUTO_ACCEPT_CONFIDENCE,
        role: isMeasureField(assigned.field) ? 'measure' : 'dimension',
      });
      continue;
    }

    // Unclaimed numeric columns in a wide sheet are per-account measures.
    if (layout === 'WIDE' && (col.kind === 'number' || col.kind === 'currency') && col.stats.nonEmpty > 0) {
      const accountKind = REVENUE_ACCOUNT_HEADERS.has(col.normalizedHeader) ? 'REVENUE' : 'EXPENSE';
      mappings.push({
        columnIndex: col.index,
        header: col.header,
        field: null,
        confidence: 0.9,
        reasons: [`numeric column in a wide layout — treated as the "${col.header.trim()}" ${accountKind.toLowerCase()} head`],
        alternatives,
        needsConfirmation: false,
        role: 'account-measure',
        accountName: col.header.trim(),
        accountKind,
      });
      continue;
    }

    mappings.push({
      columnIndex: col.index,
      header: col.header,
      field: null,
      confidence: 0,
      reasons: [col.kind === 'empty' ? 'column is empty' : 'no confident match to a known field'],
      alternatives,
      needsConfirmation: alternatives.length > 0 && (alternatives[0]?.confidence ?? 0) >= SUGGEST_CONFIDENCE,
      role: 'ignored',
    });
  }

  warnings.push(...detectSwappedHeaders(columns, columnAssigned));
  warnings.push(...detectAmbiguities(mappings));

  return { mappings, layout, warnings };
}

function isMeasureField(field: CanonicalField): boolean {
  const spec = FIELD_SPECS.find((s) => s.field === field);
  return spec?.role === 'measure';
}

/**
 * A sheet is WIDE when it has many unclaimed numeric columns (each an account),
 * and LONG when it has an account-name column paired with a single amount
 * column.
 */
function detectLayout(
  columns: ColumnProfile[],
  assigned: Map<number, FieldCandidate>,
): SheetLayout {
  const assignedFields = new Set([...assigned.values()].map((c) => c.field));

  if (assignedFields.has('account') && (assignedFields.has('amount') || assignedFields.has('expense'))) {
    return 'LONG';
  }

  const unclaimedNumeric = columns.filter(
    (c) => !assigned.has(c.index) && (c.kind === 'number' || c.kind === 'currency') && c.stats.nonEmpty > 0,
  ).length;

  if (unclaimedNumeric >= 3) return 'WIDE';
  if (assignedFields.has('revenue') || assignedFields.has('expense')) return 'WIDE';
  return 'UNKNOWN';
}

/**
 * Report the case where two dimension columns each hold the other's data.
 * Non-blocking: the mapping is already correct, but the operator should know
 * the source file is mislabelled.
 */
function detectSwappedHeaders(
  columns: ColumnProfile[],
  assigned: Map<number, FieldCandidate>,
): ParseWarning[] {
  const warnings: ParseWarning[] = [];

  for (const [columnIndex, candidate] of assigned) {
    const col = columns.find((c) => c.index === columnIndex);
    if (!col) continue;
    const spec = FIELD_SPECS.find((s) => s.field === candidate.field);
    if (!spec) continue;

    const headerMatchesAssigned = headerScore(spec, col.normalizedHeader).score >= 0.6;
    if (headerMatchesAssigned) continue;

    // Which field does the header claim to be?
    let claimed: CanonicalField | null = null;
    for (const other of FIELD_SPECS) {
      if (other.field === candidate.field) continue;
      if (headerScore(other, col.normalizedHeader).score >= 0.85) {
        claimed = other.field;
        break;
      }
    }

    if (claimed) {
      warnings.push({
        code: 'HEADER_VALUE_MISMATCH',
        severity: 'warning',
        message: `Column "${col.header}" is named like "${claimed}" but contains ${candidate.field} values (e.g. ${formatSample(col.stats.samples[0])}). Mapped as ${candidate.field} based on its contents.`,
        remedy: `Confirm this is correct. If the source file is mislabelled, fixing it there will remove this warning.`,
        context: { column: col.header, headerSuggests: claimed, mappedAs: candidate.field, sample: col.stats.samples.slice(0, 3) },
      });
    }
  }

  return warnings;
}

function detectAmbiguities(mappings: ColumnMapping[]): ParseWarning[] {
  return mappings
    .filter((m) => m.needsConfirmation && m.role !== 'ignored')
    .map((m) => ({
      code: 'AMBIGUOUS_COLUMN',
      severity: 'warning' as const,
      message: `Column "${m.header}" was matched to "${m.field}" with only ${Math.round(m.confidence * 100)}% confidence.`,
      remedy: 'Confirm or correct this mapping before importing.',
      context: {
        column: m.header,
        proposed: m.field,
        confidence: m.confidence,
        alternatives: m.alternatives.map((a) => ({ field: a.field, confidence: a.confidence })),
      },
    }));
}

/** Stable fingerprint of a sheet's structure, for saved-mapping reuse. */
export function sheetSignature(name: string, headers: string[]): string {
  const normalized = headers.map((h) => normalizeHeader(h)).filter((h) => h !== '').sort();
  return `${normalizeHeader(name)}::${normalized.join('|')}`;
}

/** 0..1 overlap between two signatures' header sets. */
export function signatureSimilarity(a: string, b: string): number {
  const setA = new Set(a.split('::')[1]?.split('|') ?? []);
  const setB = new Set(b.split('::')[1]?.split('|') ?? []);
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const h of setA) if (setB.has(h)) shared++;
  return shared / Math.max(setA.size, setB.size);
}

/**
 * Numeric subtotal detection.
 *
 * A column is a subtotal when its values are *arithmetically* the sum or
 * difference of other columns — not merely when its header says "Total".
 * Getting this wrong in either direction corrupts the MIS:
 *
 *   ingesting a subtotal as a fact   -> every amount double-counted
 *   ingesting a fact as a subtotal   -> that account silently vanishes
 *
 * Header names are unreliable for this. The Arihant workbook has a `Total`
 * column that is entirely empty and a `Total Amount` column that is the real
 * measure of its sheet. So we verify row by row instead, which is deterministic
 * and explains itself to the operator.
 */

import { parseNumber, amountsAgree } from './values';
import type { ColumnProfile } from './types';

export interface SubtotalFinding {
  columnIndex: number;
  /** Column indices that add up to this one. */
  components: number[];
  relation: 'sum' | 'difference' | 'duplicate';
  /** Human-readable, shown in the import preview. */
  explanation: string;
}

/** Rows sampled for verification. Enough to make coincidence implausible. */
const VERIFY_ROWS = 200;

interface NumericColumn {
  index: number;
  header: string;
  values: (number | null)[];
  nonZero: number;
}

export function detectSubtotalColumns(
  columns: ColumnProfile[],
  dataRows: unknown[][],
  totalRowNumbers: Set<number>,
  dataStartRow: number,
): SubtotalFinding[] {
  const numeric = buildNumericColumns(columns, dataRows, totalRowNumbers, dataStartRow);
  if (numeric.length < 3) return [];

  const findings: SubtotalFinding[] = [];
  const byIndex = new Map(numeric.map((c) => [c.index, c]));

  for (const target of numeric) {
    // An all-zero column trivially equals any block of zeros; it carries no
    // evidence either way, so leave it alone.
    if (target.nonZero === 0) continue;

    const finding =
      findContiguousBlock(target, numeric) ??
      findDifference(target, numeric) ??
      findDuplicate(target, numeric, findings);

    if (finding) findings.push(finding);
  }

  return resolveOverlaps(findings, byIndex);
}

function buildNumericColumns(
  columns: ColumnProfile[],
  dataRows: unknown[][],
  totalRowNumbers: Set<number>,
  dataStartRow: number,
): NumericColumn[] {
  const usable = dataRows.filter((_, i) => !totalRowNumbers.has(dataStartRow + i)).slice(0, VERIFY_ROWS);

  return columns
    .filter((c) => c.kind === 'number' || c.kind === 'currency')
    .map((c) => {
      const values = usable.map((r) => parseNumber(r[c.index] ?? null));
      return {
        index: c.index,
        header: c.header,
        values,
        nonZero: values.filter((v) => v !== null && v !== 0).length,
      };
    });
}

/**
 * The commonest layout by far: a total sits immediately before or immediately
 * after the run of columns it sums.
 */
function findContiguousBlock(target: NumericColumn, all: NumericColumn[]): SubtotalFinding | null {
  const pos = all.findIndex((c) => c.index === target.index);
  if (pos < 0) return null;

  // Blocks extending right from the column after the target.
  for (let end = pos + 2; end < all.length + 1; end++) {
    const block = all.slice(pos + 1, end);
    if (block.length < 2) continue;
    if (verifySum(target, block)) {
      return {
        columnIndex: target.index,
        components: block.map((b) => b.index),
        relation: 'sum',
        explanation: `"${target.header}" equals the sum of the ${block.length} columns that follow it`,
      };
    }
  }

  // Blocks extending left, ending at the column before the target.
  for (let start = pos - 2; start >= 0; start--) {
    const block = all.slice(start, pos);
    if (block.length < 2) continue;
    if (verifySum(target, block)) {
      return {
        columnIndex: target.index,
        components: block.map((b) => b.index),
        relation: 'sum',
        explanation: `"${target.header}" equals the sum of the ${block.length} columns before it`,
      };
    }
  }

  return null;
}

/** Profit-style columns: target = A - B. */
function findDifference(target: NumericColumn, all: NumericColumn[]): SubtotalFinding | null {
  for (const a of all) {
    if (a.index === target.index) continue;
    for (const b of all) {
      if (b.index === target.index || b.index === a.index) continue;
      if (verifyDifference(target, a, b)) {
        return {
          columnIndex: target.index,
          components: [a.index, b.index],
          relation: 'difference',
          explanation: `"${target.header}" equals "${a.header}" minus "${b.header}"`,
        };
      }
    }
  }
  return null;
}

/** A column that merely repeats an already-identified subtotal. */
function findDuplicate(
  target: NumericColumn,
  all: NumericColumn[],
  found: SubtotalFinding[],
): SubtotalFinding | null {
  const knownSubtotals = new Set(found.map((f) => f.columnIndex));

  for (const other of all) {
    if (other.index === target.index) continue;
    if (!knownSubtotals.has(other.index)) continue;
    if (verifyEqual(target, other)) {
      return {
        columnIndex: target.index,
        components: [other.index],
        relation: 'duplicate',
        explanation: `"${target.header}" repeats "${other.header}", which is itself a subtotal`,
      };
    }
  }
  return null;
}

function verifySum(target: NumericColumn, block: NumericColumn[]): boolean {
  // The block must carry real signal, or zeros would match anything.
  const meaningful = block.filter((b) => b.nonZero > 0).length;
  if (meaningful < 2) return false;

  let compared = 0;
  for (let r = 0; r < target.values.length; r++) {
    const t = target.values[r];
    if (t === null) continue;
    let sum = 0;
    let any = false;
    for (const b of block) {
      const v = b.values[r];
      if (v !== null) {
        sum += v;
        any = true;
      }
    }
    if (!any) continue;
    if (!amountsAgree(t, sum)) return false;
    compared++;
  }

  // Require enough agreeing rows that coincidence is not a plausible
  // explanation.
  return compared >= Math.min(5, target.values.length);
}

function verifyDifference(target: NumericColumn, a: NumericColumn, b: NumericColumn): boolean {
  if (a.nonZero === 0 || b.nonZero === 0) return false;

  let compared = 0;
  for (let r = 0; r < target.values.length; r++) {
    const t = target.values[r];
    const av = a.values[r];
    const bv = b.values[r];
    if (t === null || av === null || bv === null) continue;
    if (!amountsAgree(t, av - bv)) return false;
    compared++;
  }
  return compared >= Math.min(5, target.values.length);
}

function verifyEqual(target: NumericColumn, other: NumericColumn): boolean {
  let compared = 0;
  for (let r = 0; r < target.values.length; r++) {
    const t = target.values[r];
    const o = other.values[r];
    if (t === null || o === null) continue;
    if (!amountsAgree(t, o)) return false;
    compared++;
  }
  return compared >= Math.min(5, target.values.length);
}

/**
 * Guard against classifying components as totals.
 *
 * Subtraction is symmetric, so every verified sum yields spurious difference
 * findings for its own parts: given `Total Income = Sales + Other Income`, it
 * is equally true that `Sales = Total Income - Other Income`. Acting on that
 * would mark `Sales` a subtotal and drop all revenue from the import.
 *
 * A column that participates in a verified *sum* is a component, and a
 * component is never a total.
 */
function resolveOverlaps(
  findings: SubtotalFinding[],
  byIndex: Map<number, NumericColumn>,
): SubtotalFinding[] {
  const sumComponents = new Set<number>();
  for (const f of findings) {
    if (f.relation === 'sum') {
      for (const c of f.components) sumComponents.add(c);
    }
  }

  const kept = findings.filter((f) => {
    if (sumComponents.has(f.columnIndex)) return false;

    // A sum whose target is itself part of a wider sum is an inner subtotal;
    // the outer total is the one to keep.
    if (f.relation === 'sum') {
      const wider = findings.find(
        (o) => o !== f && o.relation === 'sum' && o.components.includes(f.columnIndex),
      );
      if (wider && wider.components.length > f.components.length) return false;
    }

    return true;
  });

  // Report each column once, preferring the more informative relation.
  const rank = { sum: 0, difference: 1, duplicate: 2 } as const;
  const best = new Map<number, SubtotalFinding>();
  for (const f of kept) {
    const existing = best.get(f.columnIndex);
    if (!existing || rank[f.relation] < rank[existing.relation]) best.set(f.columnIndex, f);
  }

  return [...best.values()].sort((a, b) => a.columnIndex - b.columnIndex);
}

/**
 * Chart palette.
 *
 * Validated with the data-viz validator against this app's white chart surface
 * (`#ffffff`), light mode, categorical, adjacent pairlist:
 *
 *   Lightness band      PASS  all 8 inside L 0.43–0.77
 *   Chroma floor        PASS  all 8 >= 0.1
 *   CVD separation      PASS  worst adjacent ΔE 9.1 (protan)
 *   Normal-vision floor PASS  worst adjacent ΔE 19.6
 *   Contrast vs surface WARN  three slots below 3:1
 *
 * The contrast warning is relieved as the method requires: every chart carries
 * a legend and direct labels, and the full figures are available as text in the
 * Tabular MIS.
 *
 * Slots are assigned in fixed order and never cycled. A ninth category folds
 * into "Other" rather than repeating a hue — see `foldToTopN`.
 */

export const CATEGORICAL = [
  '#2a78d6', // blue
  '#eb6834', // orange
  '#1baf7a', // aqua
  '#eda100', // yellow
  '#e87ba4', // magenta
  '#008300', // green
  '#4a3aa7', // violet
  '#e34948', // red
] as const;

export const MAX_CATEGORIES = CATEGORICAL.length;

/** Colour for the "Other" bucket — deliberately neutral, not a ninth hue. */
export const OTHER_COLOR = '#94a3b8';

/**
 * Polarity. Blue/red poles with a neutral midpoint, per the diverging rule.
 * Used only where the sign carries meaning (profit, variance).
 */
export const DIVERGING = {
  positive: '#2a78d6',
  negative: '#e34948',
  neutral: '#f0efec',
} as const;

/** Single-hue ramp for magnitude. */
export const SEQUENTIAL = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95'] as const;

export const CHROME = {
  grid: '#e2e8f0',
  axis: '#94a3b8',
  text: '#475569',
  surface: '#ffffff',
} as const;

/**
 * Colour a category by its identity, so a filter that removes series does not
 * repaint the survivors.
 */
export function colorFor(key: string, orderedKeys: readonly string[]): string {
  const i = orderedKeys.indexOf(key);
  if (i < 0 || i >= MAX_CATEGORIES) return OTHER_COLOR;
  return CATEGORICAL[i];
}

export interface Folded<T> {
  items: (T & { __other?: boolean })[];
  otherCount: number;
}

/**
 * Keep the top N by magnitude and fold the remainder into a single "Other"
 * row. Never generate a new hue for an overflow category.
 */
export function foldToTopN<T extends { label: string; value: number }>(
  rows: T[],
  n = MAX_CATEGORIES,
  makeOther: (label: string, value: number) => T,
): Folded<T> {
  if (rows.length <= n) return { items: rows, otherCount: 0 };

  const sorted = [...rows].sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  const head = sorted.slice(0, n - 1);
  const tail = sorted.slice(n - 1);
  const otherValue = tail.reduce((s, r) => s + r.value, 0);

  return {
    items: [...head, { ...makeOther(`Other (${tail.length})`, otherValue), __other: true }],
    otherCount: tail.length,
  };
}

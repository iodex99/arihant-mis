'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { cn } from '@/lib/cn';
import { formatCurrency, formatNumber, formatPercent, formatRatio } from '@/lib/format';

export type CellFormat = 'text' | 'currency' | 'percent' | 'ratio' | 'number';

export interface Column<T> {
  key: keyof T & string;
  header: string;
  format?: CellFormat;
  /** Hidden by default; toggled from the column menu. */
  optional?: boolean;
  /** Colour by sign — only where a negative is meaningful. */
  signed?: boolean;
  /**
   * Turn the cell into a link. A template rather than a function, because this
   * component is rendered from server components and functions cannot cross
   * that boundary. "%s" is replaced with the URL-encoded cell value.
   */
  linkTemplate?: string;
  /** Explains the column in a tooltip and in the column menu. */
  note?: string;
  align?: 'left' | 'right';
  /**
   * How this column's footer cell is produced. Ratios are computed from the
   * column totals, never by summing the per-row ratios.
   */
  footer?:
    | { kind: 'sum' }
    | { kind: 'constant'; value: number }
    | { kind: 'ratio'; numerator: string; denominator?: string; denominatorValue?: number };
}

interface Props<T> {
  columns: Column<T>[];
  rows: T[];
  /** Which column to sort by initially. */
  initialSort?: { key: string; direction: 'asc' | 'desc' };
  /** Render a totals row. Each column's contribution comes from Column.footer. */
  showFooter?: boolean;
  searchKeys?: (keyof T & string)[];
  pageSize?: number;
  emptyMessage?: string;
  caption?: string;
}

/**
 * Tabular MIS table: sticky header, sortable columns, search, pagination and
 * column visibility. Rows arrive already aggregated by the MIS engine.
 */
export default function DataTable<T extends object>({
  columns,
  rows,
  initialSort,
  showFooter = false,
  searchKeys = [],
  pageSize = 25,
  emptyMessage = 'No rows match the current filters.',
  caption,
}: Props<T>) {
  const [sort, setSort] = useState(initialSort ?? null);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [hidden, setHidden] = useState<Set<string>>(
    () => new Set(columns.filter((c) => c.optional).map((c) => c.key)),
  );
  const [menuOpen, setMenuOpen] = useState(false);

  const visible = columns.filter((c) => !hidden.has(c.key));

  const filtered = useMemo(() => {
    if (!query.trim() || searchKeys.length === 0) return rows;
    const q = query.toLowerCase();
    return rows.filter((r) => searchKeys.some((k) => String(r[k] ?? '').toLowerCase().includes(q)));
  }, [rows, query, searchKeys]);

  const sorted = useMemo(() => {
    if (!sort) return filtered;
    const dir = sort.direction === 'asc' ? 1 : -1;
    const key = sort.key as keyof T;
    return [...filtered].sort((a, b) => {
      const av = a[key];
      const bv = b[key];
      // Nulls sort last regardless of direction — a missing margin is not
      // "worse than everything", it is unknown.
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
  }, [filtered, sort]);

  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  const current = Math.min(page, pageCount - 1);
  const pageRows = sorted.slice(current * pageSize, (current + 1) * pageSize);

  // Footer figures come from every filtered row, not just the visible page.
  const sums = useMemo(() => {
    if (!showFooter) return null;
    const out: Record<string, number> = {};
    for (const c of columns) {
      // Sum any numeric column, so a ratio can reference a column that is not
      // itself displayed as a total.
      if (c.format && c.format !== 'text' && c.format !== 'percent' && c.format !== 'ratio') {
        out[c.key] = filtered.reduce((acc, r) => acc + (Number(r[c.key as keyof T]) || 0), 0);
      }
    }
    return out;
  }, [filtered, columns, showFooter]);

  function toggleSort(key: string) {
    setSort((prev) =>
      prev?.key === key
        ? { key, direction: prev.direction === 'asc' ? 'desc' : 'asc' }
        : { key, direction: 'desc' },
    );
    setPage(0);
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2 no-print">
        {searchKeys.length > 0 && (
          <input
            value={query}
            onChange={(e) => { setQuery(e.target.value); setPage(0); }}
            placeholder="Search…"
            className="input max-w-xs py-1.5 text-sm"
            aria-label="Search rows"
          />
        )}

        <div className="relative ml-auto">
          <button type="button" onClick={() => setMenuOpen((v) => !v)} className="btn-secondary text-xs" aria-expanded={menuOpen}>
            Columns ({visible.length}/{columns.length})
          </button>
          {menuOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} aria-hidden />
              <div className="absolute right-0 z-50 mt-1 w-72 rounded-lg border border-line bg-surface p-2 shadow-pop">
                {columns.map((c) => (
                  <label key={c.key} className="flex cursor-pointer items-start gap-2 rounded px-2 py-1.5 text-sm hover:bg-canvas">
                    <input
                      type="checkbox"
                      checked={!hidden.has(c.key)}
                      onChange={() =>
                        setHidden((prev) => {
                          const next = new Set(prev);
                          if (next.has(c.key)) next.delete(c.key);
                          else next.add(c.key);
                          return next;
                        })
                      }
                      className="mt-0.5 rounded border-line text-accent focus:ring-accent"
                    />
                    <span>
                      <span className="block">{c.header}</span>
                      {c.note && <span className="block text-xs text-ink-faint">{c.note}</span>}
                    </span>
                  </label>
                ))}
              </div>
            </>
          )}
        </div>

        <span className="text-xs text-ink-faint">
          {sorted.length.toLocaleString('en-IN')} row{sorted.length === 1 ? '' : 's'}
        </span>
      </div>

      <div className="table-scroll max-h-[70vh] rounded-lg border border-line">
        <table className="mis-table">
          {caption && <caption className="sr-only">{caption}</caption>}
          <thead>
            <tr>
              {visible.map((c) => {
                const active = sort?.key === c.key;
                return (
                  <th
                    key={c.key}
                    scope="col"
                    className={c.align === 'right' || c.format !== 'text' ? 'text-right' : ''}
                    aria-sort={active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
                  >
                    <button
                      type="button"
                      onClick={() => toggleSort(c.key)}
                      title={c.note}
                      className={cn('inline-flex items-center gap-1 hover:text-ink', active && 'text-accent')}
                    >
                      {c.header}
                      <span aria-hidden className="text-[9px]">
                        {active ? (sort.direction === 'asc' ? '▲' : '▼') : '↕'}
                      </span>
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>

          <tbody>
            {pageRows.length === 0 && (
              <tr>
                <td colSpan={visible.length} className="py-10 text-center text-ink-faint">
                  {emptyMessage}
                </td>
              </tr>
            )}
            {pageRows.map((row, i) => (
              <tr key={i}>
                {visible.map((c) => {
                  const value = row[c.key];
                  const negative = c.signed && typeof value === 'number' && value < 0;
                  return (
                    <td
                      key={c.key}
                      className={cn(
                        c.format && c.format !== 'text' ? 'num' : '',
                        negative && 'text-negative',
                      )}
                    >
                      {c.linkTemplate ? (
                        <Link
                          href={c.linkTemplate.replace('%s', encodeURIComponent(String(value ?? '')))}
                          className="font-medium text-accent hover:underline"
                        >
                          {renderCell(value, c.format)}
                        </Link>
                      ) : (
                        renderCell(value, c.format)
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>

          {sums && (
            <tfoot>
              <tr>
                {visible.map((c, i) => {
                  if (i === 0) return <td key={c.key}>Total ({sorted.length})</td>;
                  const value = footerValue(c, sums);
                  return (
                    <td key={c.key} className={value === null ? undefined : 'num'}>
                      {value === null ? '' : renderCell(value, c.format)}
                    </td>
                  );
                })}
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {pageCount > 1 && (
        <div className="mt-3 flex items-center justify-between gap-3 text-sm no-print">
          <span className="text-xs text-ink-faint">
            Rows {current * pageSize + 1}–{Math.min((current + 1) * pageSize, sorted.length)} of{' '}
            {sorted.length.toLocaleString('en-IN')}
          </span>
          <div className="flex items-center gap-1">
            <button onClick={() => setPage(0)} disabled={current === 0} className="btn-secondary px-2 py-1 text-xs">First</button>
            <button onClick={() => setPage(current - 1)} disabled={current === 0} className="btn-secondary px-2 py-1 text-xs">Prev</button>
            <span className="px-2 text-xs text-ink-muted">{current + 1} / {pageCount}</span>
            <button onClick={() => setPage(current + 1)} disabled={current >= pageCount - 1} className="btn-secondary px-2 py-1 text-xs">Next</button>
            <button onClick={() => setPage(pageCount - 1)} disabled={current >= pageCount - 1} className="btn-secondary px-2 py-1 text-xs">Last</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Resolve one footer cell from the column totals. */
function footerValue<T>(column: Column<T>, sums: Record<string, number>): number | null {
  const spec = column.footer;
  if (!spec) return null;

  if (spec.kind === 'constant') return spec.value;
  if (spec.kind === 'sum') return sums[column.key] ?? 0;

  // Ratios divide the totals — summing per-row ratios would be meaningless.
  const numerator = sums[spec.numerator] ?? 0;
  const denominator =
    spec.denominatorValue !== undefined ? spec.denominatorValue : (sums[spec.denominator ?? ''] ?? 0);

  return denominator === 0 ? null : numerator / denominator;
}

function renderCell(value: unknown, format: CellFormat = 'text'): string {
  if (value === null || value === undefined) return '—';
  switch (format) {
    case 'currency':
      return formatCurrency(Number(value));
    case 'percent':
      return formatPercent(Number(value));
    case 'ratio':
      return formatRatio(Number(value));
    case 'number':
      return formatNumber(Number(value), 0);
    default:
      return String(value);
  }
}

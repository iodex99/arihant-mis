'use client';

import { useState } from 'react';
import Link from 'next/link';
import { cn } from '@/lib/cn';
import { formatCompactCurrency, formatCurrency, formatPercent } from '@/lib/format';
import { DIVERGING } from '@/components/charts/palette';
import type { CrossTab } from '@/lib/mis/analysis';

type Measure = 'margin' | 'revenue' | 'profit';

/**
 * Branch by stream.
 *
 * Built as a table rather than a chart so every cell keeps its label and the
 * figures stay readable and copyable. Margin is polarity, so it takes the
 * diverging pair with a neutral midpoint at zero; revenue and profit are
 * magnitude, so they take a single-hue ramp.
 */
export default function MarginMatrix({ matrix }: { matrix: CrossTab }) {
  const [measure, setMeasure] = useState<Measure>('margin');
  const [showAll, setShowAll] = useState(false);

  if (matrix.rows.length === 0) {
    return <p className="py-10 text-center text-sm text-ink-faint">No data in this selection.</p>;
  }

  const rows = showAll ? matrix.rows : matrix.rows.slice(0, 18);

  const values: number[] = [];
  for (const r of matrix.rows) {
    for (const c of matrix.columns) {
      const cell = matrix.cells[r]?.[c];
      if (!cell) continue;
      const v = measure === 'margin' ? cell.margin : measure === 'revenue' ? cell.revenue : cell.profit;
      if (v !== null && Number.isFinite(v)) values.push(v);
    }
  }

  /**
   * Scale the ramp to the 90th percentile, not the maximum.
   *
   * One extreme cell otherwise flattens the whole grid: a branch with a few
   * hundred rupees of revenue and a real cost base produces a margin in the
   * thousands of percent, and every other cell then renders as near-white.
   * Values past the cap saturate rather than being hidden, and the figure
   * itself is always printed in the cell.
   */
  const sorted = values.map(Math.abs).sort((a, b) => a - b);
  const percentile90 = sorted.length === 0 ? 1 : sorted[Math.floor(sorted.length * 0.9)] || 1;
  const cap = measure === 'margin' ? Math.min(percentile90, 1) : percentile90;
  const outliers = values.filter((v) => Math.abs(v) > cap).length;

  function background(value: number | null): string | undefined {
    if (value === null || cap === 0) return undefined;
    const intensity = Math.min(Math.abs(value) / cap, 1);
    if (intensity < 0.02) return undefined;
    const rgb = value < 0 ? '227,73,72' : '42,120,214';
    return `rgba(${rgb},${(intensity * 0.55).toFixed(3)})`;
  }

  const render = (value: number | null) =>
    measure === 'margin' ? formatPercent(value, 0) : formatCompactCurrency(value ?? 0);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2 no-print">
        <div className="flex rounded-lg border border-line p-0.5">
          {(['margin', 'revenue', 'profit'] as Measure[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMeasure(m)}
              className={cn(
                'rounded px-2.5 py-1 text-xs font-medium capitalize transition-colors',
                measure === m ? 'bg-accent text-white' : 'text-ink-muted hover:text-ink',
              )}
            >
              {m}
            </button>
          ))}
        </div>
        {matrix.rows.length > 18 && (
          <button type="button" onClick={() => setShowAll((v) => !v)} className="btn-secondary text-xs">
            {showAll ? 'Show top 18' : `Show all ${matrix.rows.length}`}
          </button>
        )}
        <span className="ml-auto text-xs text-ink-faint">
          Blank means that stream does not trade at that branch
        </span>
      </div>

      <div className="table-scroll max-h-[600px] rounded-lg border border-line">
        <table className="mis-table">
          <thead>
            <tr>
              <th className="sticky left-0 z-20 bg-surface">Branch</th>
              {matrix.columns.map((c) => (
                <th key={c} className="text-right">{c}</th>
              ))}
              <th className="text-right">All streams</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const total = matrix.rowTotals[r];
              return (
                <tr key={r}>
                  <th
                    scope="row"
                    className="sticky left-0 z-10 whitespace-nowrap border-b border-line/60 bg-surface px-3 py-2.5 text-left text-sm font-medium"
                  >
                    <Link href={`/drill?branch=${encodeURIComponent(r)}`} className="text-accent hover:underline">
                      {r}
                    </Link>
                  </th>

                  {matrix.columns.map((c) => {
                    const cell = matrix.cells[r]?.[c];
                    if (!cell) return <td key={c} className="num text-ink-faint">·</td>;
                    const value =
                      measure === 'margin' ? cell.margin : measure === 'revenue' ? cell.revenue : cell.profit;
                    return (
                      <td
                        key={c}
                        className={cn('num', (value ?? 0) < 0 && 'text-negative')}
                        style={{ background: background(value) }}
                        title={`${r} · ${c}\nRevenue ${formatCurrency(cell.revenue)}\nExpense ${formatCurrency(cell.expense)}\nProfit ${formatCurrency(cell.profit)}\nMargin ${formatPercent(cell.margin)}`}
                      >
                        {render(value)}
                      </td>
                    );
                  })}

                  <td className={cn('num font-medium', (total?.profit ?? 0) < 0 && 'text-negative')}>
                    {measure === 'margin'
                      ? formatPercent(total?.margin ?? null, 0)
                      : formatCompactCurrency(measure === 'revenue' ? (total?.revenue ?? 0) : (total?.profit ?? 0))}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td className="sticky left-0 z-10 bg-canvas">All branches</td>
              {matrix.columns.map((c) => {
                const t = matrix.columnTotals[c];
                return (
                  <td key={c} className={cn('num', (t?.profit ?? 0) < 0 && 'text-negative')}>
                    {measure === 'margin'
                      ? formatPercent(t?.margin ?? null, 0)
                      : formatCompactCurrency(measure === 'revenue' ? (t?.revenue ?? 0) : (t?.profit ?? 0))}
                  </td>
                );
              })}
              <td />
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-ink-faint">
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="h-3 w-6 rounded-sm" style={{ background: `rgba(42,120,214,0.55)` }} />
          higher
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="h-3 w-6 rounded-sm border border-line" style={{ background: DIVERGING.neutral }} />
          near zero
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="h-3 w-6 rounded-sm" style={{ background: `rgba(227,73,72,0.55)` }} />
          negative
        </span>
        {outliers > 0 && (
          <span>
            {outliers} cell{outliers === 1 ? '' : 's'} exceed the shading range and show at full
            intensity — the figure in the cell is always the real one.
          </span>
        )}
        <span className="ml-auto">Hover a cell for its full revenue, expense and profit.</span>
      </div>
    </div>
  );
}

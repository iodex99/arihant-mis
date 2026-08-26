'use client';

import { useState } from 'react';
import { cn } from '@/lib/cn';
import { formatPercent } from '@/lib/format';
import type { ComparisonMatrix as Matrix } from '@/lib/mis/engine';

/**
 * Per-branch expense intensity (PDF page 3).
 *
 * The reference report put branches in columns, which stops working past a
 * dozen or so. Branches are rows here, with a transpose control for anyone who
 * prefers the old orientation.
 */
export default function ComparisonMatrix({ matrix }: { matrix: Matrix }) {
  const [transposed, setTransposed] = useState(false);

  const branches = matrix.branches.filter((b) => b.revenue > 0);
  const groups = matrix.groups.filter((g) => !matrix.unallocatedGroups.includes(g));

  if (branches.length === 0) {
    return <p className="py-8 text-center text-sm text-ink-faint">No branches with revenue in this selection.</p>;
  }

  const cell = (branch: string, group: string) => matrix.cells[branch]?.[group] ?? null;

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3 no-print">
        <p className="text-xs text-ink-faint">
          Each cell is that group’s spend divided by the branch’s own revenue.
        </p>
        <button type="button" onClick={() => setTransposed((v) => !v)} className="btn-secondary text-xs">
          {transposed ? 'Branches as rows' : 'Branches as columns'}
        </button>
      </div>

      <div className="table-scroll max-h-[70vh] rounded-lg border border-line">
        <table className="mis-table">
          <thead>
            <tr>
              <th className="sticky left-0 z-20 bg-surface">{transposed ? 'Group' : 'Branch'}</th>
              {(transposed ? branches.map((b) => b.key) : groups).map((h) => (
                <th key={h} className="text-right">{h}</th>
              ))}
              {!transposed && <th className="text-right">Profit margin</th>}
            </tr>
          </thead>
          <tbody>
            {transposed
              ? groups.map((g) => (
                  <tr key={g}>
                    <th scope="row" className="sticky left-0 z-10 whitespace-nowrap border-b border-line/60 bg-surface px-3 py-2.5 text-left text-sm font-medium">
                      {g}
                    </th>
                    {branches.map((b) => (
                      <Cell key={b.key} value={cell(b.key, g)} />
                    ))}
                  </tr>
                ))
              : branches.map((b) => (
                  <tr key={b.key}>
                    <th scope="row" className="sticky left-0 z-10 whitespace-nowrap border-b border-line/60 bg-surface px-3 py-2.5 text-left text-sm font-medium">
                      {b.key}
                    </th>
                    {groups.map((g) => (
                      <Cell key={g} value={cell(b.key, g)} />
                    ))}
                    <td className={cn('num font-medium', (b.margin ?? 0) < 0 && 'text-negative')}>
                      {formatPercent(b.margin)}
                    </td>
                  </tr>
                ))}
          </tbody>
        </table>
      </div>

      {matrix.unallocatedGroups.length > 0 && (
        <p className="mt-3 rounded-lg bg-canvas px-3 py-2 text-xs text-ink-muted">
          <strong>{matrix.unallocatedGroups.join(', ')}</strong>{' '}
          {matrix.unallocatedGroups.length === 1 ? 'is' : 'are'} booked centrally rather than per
          branch, so dividing by each branch’s revenue would repeat one company-wide figure down
          the column and read as though every branch carried it. Those groups are excluded here and
          reported in the group analysis above.
        </p>
      )}
    </div>
  );
}

/** Shade by magnitude so heavy cost centres stand out without a rainbow. */
function Cell({ value }: { value: number | null }) {
  if (value === null) return <td className="num text-ink-faint">—</td>;

  const intensity = Math.min(Math.abs(value) / 0.4, 1);
  const negative = value < 0;

  return (
    <td
      className={cn('num', negative && 'text-negative')}
      style={
        intensity > 0.05
          ? { background: negative ? `rgba(227,73,72,${intensity * 0.16})` : `rgba(42,120,214,${intensity * 0.16})` }
          : undefined
      }
    >
      {formatPercent(value, 1)}
    </td>
  );
}

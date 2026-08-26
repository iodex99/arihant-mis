'use client';

import { Fragment, useState } from 'react';
import { formatCurrency } from '@/lib/format';
import type { SourceRowRef } from '@/lib/mis/drill';

/**
 * The provenance leaf: the exact spreadsheet rows behind a figure.
 * Expanding a row shows every original cell value, unchanged.
 */
export default function SourceRows({ rows }: { rows: SourceRowRef[] }) {
  const [open, setOpen] = useState<number | null>(null);

  if (rows.length === 0) {
    return <p className="py-8 text-center text-sm text-ink-faint">No source rows in this selection.</p>;
  }

  return (
    <div className="table-scroll max-h-[420px] rounded-lg border border-line">
      <table className="mis-table">
        <thead>
          <tr>
            <th>Source</th>
            <th>Period</th>
            <th>Branch</th>
            <th>Stream</th>
            <th>Head</th>
            <th className="num">Amount</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <Fragment key={i}>
              <tr>
                <td>
                  <button
                    type="button"
                    onClick={() => setOpen(open === i ? null : i)}
                    className="text-accent hover:underline"
                    aria-expanded={open === i}
                  >
                    {r.sheetName} row {r.rowNumber}
                  </button>
                </td>
                <td>{r.periodLabel}</td>
                <td>{r.branch}</td>
                <td>{r.stream}</td>
                <td>{r.account}</td>
                <td className={`num ${r.amount < 0 ? 'text-negative' : ''}`}>{formatCurrency(r.amount)}</td>
              </tr>
              {open === i && (
                <tr>
                  <td colSpan={6} className="bg-canvas !whitespace-normal p-4">
                    <p className="mb-2 text-xs text-ink-muted">
                      Original cell values from <strong>{r.filename}</strong>, sheet “{r.sheetName}”, row {r.rowNumber}:
                    </p>
                    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
                      {Object.entries(r.raw).map(([k, v]) => (
                        <div key={k} className="contents">
                          <dt className="text-ink-faint">{k}</dt>
                          <dd className="tnum">{String(v)}</dd>
                        </div>
                      ))}
                    </dl>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

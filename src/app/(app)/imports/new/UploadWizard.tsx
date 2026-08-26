'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { cn } from '@/lib/cn';
import { formatBytes, formatCurrency, formatPercent } from '@/lib/format';
import { CANONICAL_FIELDS } from '@/lib/parser/types';

interface AnalyzeResponse {
  stagedPath: string;
  filename: string;
  fileSize: number;
  analysis: {
    sheets: Sheet[];
    warnings: Warning[];
    blockers: Warning[];
    readyToImport: boolean;
    matchedProfile?: { name: string; version: number; similarity: number };
  };
  normalization: {
    rowCount: number;
    factCount: number;
    warnings: Warning[];
    skipped: { rowNumber: number; sheetName: string; reason: string }[];
    dimensions: { periods: string[]; branches: number; streams: number; centres: number; accounts: number };
  };
  reconciliation: Reconciliation;
}

interface Sheet {
  name: string;
  sheetIndex: number;
  role: string;
  roleReason: string;
  layout: string;
  headerRow: number | null;
  rowCount: number;
  columnCount: number;
  mappings: Mapping[];
  totalRowNumbers: number[];
  columns: { index: number; header: string; kind: string; samples: unknown[] }[];
}

interface Mapping {
  columnIndex: number;
  header: string;
  field: string | null;
  role: string;
  confidence: number;
  reasons: string[];
  needsConfirmation: boolean;
  alternatives: { field: string; confidence: number }[];
  accountName?: string;
  accountKind?: string;
}

interface Warning {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  remedy?: string;
}

interface Reconciliation {
  status: 'PASS' | 'FAIL';
  checks: {
    code: string;
    label: string;
    status: 'PASS' | 'FAIL' | 'SKIPPED';
    expected: number | null;
    actual: number | null;
    difference: number | null;
    note?: string;
  }[];
  totals: { revenue: number; expense: number; profit: number; margin: number | null; factCount: number; rowCount: number };
}

type Stage = 'choose' | 'analyzing' | 'preview' | 'importing' | 'done';

export default function UploadWizard() {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>('choose');
  const [result, setResult] = useState<AnalyzeResponse | null>(null);
  const [error, setError] = useState<{ message: string; remedy?: string; detail?: string } | null>(null);
  const [overrides, setOverrides] = useState<Record<string, string | null>>({});
  const [saveMapping, setSaveMapping] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [done, setDone] = useState<{ status: string; message: string; importId: string } | null>(null);

  const analyze = useCallback(
    async (file: File, nextOverrides: Record<string, string | null> = {}) => {
      setStage('analyzing');
      setError(null);

      const form = new FormData();
      form.append('file', file);
      if (Object.keys(nextOverrides).length > 0) {
        form.append('overrides', JSON.stringify(nextOverrides));
      }

      try {
        const res = await fetch('/api/imports/analyze', { method: 'POST', body: form });
        const body = await res.json();
        if (!res.ok) {
          setError({ message: body.error, remedy: body.remedy, detail: body.detail });
          setStage('choose');
          return;
        }
        setResult(body);
        setStage('preview');
      } catch {
        setError({
          message: 'The upload did not complete.',
          remedy: 'Check your connection and try again. Large workbooks can take a minute.',
        });
        setStage('choose');
      }
    },
    [],
  );

  const [file, setFile] = useState<File | null>(null);

  function onFile(f: File | null) {
    if (!f) return;
    setFile(f);
    setOverrides({});
    void analyze(f);
  }

  function setOverride(sheetIndex: number, columnIndex: number, field: string | null) {
    const next = { ...overrides, [`${sheetIndex}:${columnIndex}`]: field };
    setOverrides(next);
    if (file) void analyze(file, next);
  }

  async function commit(acknowledgeWarnings = false) {
    if (!result) return;
    setStage('importing');
    setError(null);

    try {
      const res = await fetch('/api/imports/commit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          stagedPath: result.stagedPath,
          filename: result.filename,
          overrides,
          saveMapping,
          acknowledgeWarnings,
        }),
      });
      const body = await res.json();

      if (!res.ok) {
        setError({ message: body.error, remedy: body.remedy });
        setStage('preview');
        return;
      }

      setDone(body);
      setStage('done');
      router.refresh();
    } catch {
      setError({ message: 'The import did not complete.', remedy: 'Try again; nothing was changed.' });
      setStage('preview');
    }
  }

  // ---- choose ----
  if (stage === 'choose' || stage === 'analyzing') {
    return (
      <div className="mx-auto max-w-2xl">
        <label
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); onFile(e.dataTransfer.files[0] ?? null); }}
          className={cn(
            'card flex cursor-pointer flex-col items-center justify-center gap-3 border-2 border-dashed px-6 py-16 text-center transition-colors',
            dragging ? 'border-accent bg-accent-soft' : 'border-line hover:border-accent/50',
            stage === 'analyzing' && 'pointer-events-none opacity-60',
          )}
        >
          <input
            type="file"
            accept=".xlsx,.xls,.csv,.tsv"
            className="sr-only"
            onChange={(e) => onFile(e.target.files?.[0] ?? null)}
            disabled={stage === 'analyzing'}
          />
          {stage === 'analyzing' ? (
            <>
              <p className="text-sm font-medium">Analysing {file?.name}…</p>
              <p className="text-xs text-ink-faint">
                Detecting sheets, header rows and columns, then checking the totals reconcile.
              </p>
            </>
          ) : (
            <>
              <p className="text-sm font-medium">Drop an Excel or CSV file here, or click to choose</p>
              <p className="text-xs text-ink-faint">
                .xlsx and .csv up to 60 MB. Column order and naming can vary — the importer works
                it out and shows you what it found before anything is saved.
              </p>
            </>
          )}
        </label>

        {error && <ErrorPanel error={error} />}
      </div>
    );
  }

  // ---- done ----
  if (stage === 'done' && done) {
    return (
      <div className="mx-auto max-w-2xl">
        <div className="card card-pad text-center">
          <h2 className={cn('text-lg font-semibold', done.status === 'NEEDS_REVIEW' && 'text-amber-700')}>
            {done.status === 'COMPLETED' ? 'Import complete' : 'Imported with warnings'}
          </h2>
          <p className="mt-2 text-sm text-ink-muted">{done.message}</p>
          <div className="mt-6 flex justify-center gap-3">
            <a href="/" className="btn-primary">View dashboard</a>
            <a href={`/imports/${done.importId}`} className="btn-secondary">Import detail</a>
          </div>
        </div>
      </div>
    );
  }

  if (!result) return null;

  const { analysis, normalization, reconciliation } = result;
  const factSheets = analysis.sheets.filter((s) => s.role === 'FACTS');
  const ambiguous = factSheets.flatMap((s) =>
    s.mappings.filter((m) => m.needsConfirmation).map((m) => ({ sheet: s, mapping: m })),
  );
  const canImport = analysis.blockers.length === 0;

  // ---- preview ----
  return (
    <div className="space-y-4">
      <div className="card card-pad">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold">{result.filename}</h2>
            <p className="text-xs text-ink-faint">
              {formatBytes(result.fileSize)} · {analysis.sheets.length} sheet
              {analysis.sheets.length === 1 ? '' : 's'} found
              {analysis.matchedProfile && (
                <> · matches saved mapping “{analysis.matchedProfile.name}” v{analysis.matchedProfile.version}
                  {' '}({Math.round(analysis.matchedProfile.similarity * 100)}% similar)</>
              )}
            </p>
          </div>
          <button onClick={() => { setStage('choose'); setResult(null); setFile(null); }} className="btn-ghost text-xs">
            Choose a different file
          </button>
        </div>
      </div>

      {analysis.blockers.length > 0 && (
        <div className="card border-negative/30 card-pad">
          <h3 className="font-semibold text-negative">This file cannot be imported yet</h3>
          <ul className="mt-3 space-y-3">
            {analysis.blockers.map((b, i) => (
              <li key={i} className="text-sm">
                <p className="font-medium">{b.message}</p>
                {b.remedy && <p className="mt-0.5 text-ink-muted">{b.remedy}</p>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Sheets */}
      <section className="card">
        <header className="border-b border-line px-5 py-3.5">
          <h3 className="text-sm font-semibold">Sheets detected</h3>
        </header>
        <div className="divide-y divide-line">
          {analysis.sheets.map((s) => (
            <div key={s.sheetIndex} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-5 py-3 text-sm">
              <span className="font-medium">{s.name}</span>
              <RoleBadge role={s.role} />
              <span className="text-xs text-ink-faint">
                {s.role !== 'SKIPPED' && (
                  <>header on row {s.headerRow}, {s.rowCount.toLocaleString('en-IN')} data rows, {s.columnCount} columns</>
                )}
              </span>
              {s.roleReason && <span className="w-full text-xs text-ink-muted">{s.roleReason}</span>}
            </div>
          ))}
        </div>
      </section>

      {/* Column mapping */}
      {factSheets.map((sheet) => (
        <section key={sheet.sheetIndex} className="card">
          <header className="border-b border-line px-5 py-3.5">
            <h3 className="text-sm font-semibold">Column mapping — {sheet.name}</h3>
            <p className="mt-0.5 text-xs text-ink-faint">
              {sheet.mappings.filter((m) => m.field).length} named fields,{' '}
              {sheet.mappings.filter((m) => m.role === 'account-measure').length} account columns,{' '}
              {sheet.mappings.filter((m) => m.role === 'subtotal').length} subtotals excluded from the figures
            </p>
          </header>
          <div className="table-scroll max-h-[400px]">
            <table className="mis-table">
              <thead>
                <tr>
                  <th>Source column</th>
                  <th>Detected as</th>
                  <th>Confidence</th>
                  <th>Why</th>
                </tr>
              </thead>
              <tbody>
                {sheet.mappings
                  .filter((m) => m.role !== 'ignored' || m.needsConfirmation)
                  .map((m) => (
                    <tr key={m.columnIndex} className={m.needsConfirmation ? 'bg-amber-50/50' : undefined}>
                      <td className="font-medium">{m.header}</td>
                      <td>
                        {m.role === 'account-measure' ? (
                          <span className="text-ink-muted">
                            {m.accountKind === 'REVENUE' ? 'Revenue head' : 'Expense head'}
                          </span>
                        ) : m.role === 'subtotal' ? (
                          <span className="text-ink-faint">subtotal (not imported)</span>
                        ) : (
                          <select
                            value={overrides[`${sheet.sheetIndex}:${m.columnIndex}`] ?? m.field ?? ''}
                            onChange={(e) => setOverride(sheet.sheetIndex, m.columnIndex, e.target.value || null)}
                            className="input py-1 text-xs"
                          >
                            <option value="">— ignore —</option>
                            {CANONICAL_FIELDS.map((f) => (
                              <option key={f} value={f}>{f}</option>
                            ))}
                          </select>
                        )}
                      </td>
                      <td className="num">
                        <Confidence value={m.confidence} />
                      </td>
                      <td className="!whitespace-normal text-xs text-ink-muted">{m.reasons.join('; ')}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}

      {ambiguous.length > 0 && (
        <div className="card border-amber-300 card-pad">
          <h3 className="font-semibold text-amber-800">Attention required</h3>
          <p className="mt-1 text-sm text-ink-muted">
            {ambiguous.length} column{ambiguous.length === 1 ? '' : 's'} could not be classified
            confidently. Confirm each one above before importing.
          </p>
          <ul className="mt-3 space-y-2 text-sm">
            {ambiguous.map(({ sheet, mapping }, i) => (
              <li key={i}>
                <strong>“{mapping.header}”</strong> in {sheet.name} — best guess{' '}
                <strong>{mapping.field}</strong> at {Math.round(mapping.confidence * 100)}%
                {mapping.alternatives.length > 0 && (
                  <span className="text-ink-muted">
                    {' '}· could also be{' '}
                    {mapping.alternatives.map((a) => `${a.field} ${Math.round(a.confidence * 100)}%`).join(', ')}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Validation */}
      <section className="card">
        <header className="border-b border-line px-5 py-3.5">
          <h3 className="text-sm font-semibold">Validation</h3>
        </header>
        <div className="grid gap-4 p-5 md:grid-cols-2">
          <dl className="space-y-2 text-sm">
            <Row label="Rows to import" value={normalization.rowCount.toLocaleString('en-IN')} />
            <Row label="Entries created" value={normalization.factCount.toLocaleString('en-IN')} />
            <Row label="Periods" value={normalization.dimensions.periods.join(', ') || '—'} />
            <Row label="Branches" value={String(normalization.dimensions.branches)} />
            <Row label="Streams" value={String(normalization.dimensions.streams)} />
            <Row label="Accounts" value={String(normalization.dimensions.accounts)} />
          </dl>
          <dl className="space-y-2 text-sm">
            <Row label="Revenue" value={formatCurrency(reconciliation.totals.revenue)} />
            <Row label="Expense" value={formatCurrency(reconciliation.totals.expense)} />
            <Row label="Calculated profit" value={formatCurrency(reconciliation.totals.profit)} />
            <Row label="Profit margin" value={formatPercent(reconciliation.totals.margin)} />
          </dl>
        </div>

        <div className="border-t border-line px-5 py-4">
          <table className="w-full text-sm">
            <tbody>
              {reconciliation.checks.map((c) => (
                <tr key={c.code}>
                  <td className="py-1.5 pr-3">
                    <StatusPill status={c.status} />
                  </td>
                  <td className="py-1.5 pr-3">{c.label}</td>
                  <td className="py-1.5 text-right text-xs text-ink-muted tnum">
                    {c.status === 'SKIPPED'
                      ? c.note
                      : c.difference === 0
                        ? 'exact'
                        : `off by ${formatCurrency(c.difference ?? 0)}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Warnings */}
      {[...analysis.warnings, ...normalization.warnings].length > 0 && (
        <section className="card">
          <header className="border-b border-line px-5 py-3.5">
            <h3 className="text-sm font-semibold">Notes</h3>
          </header>
          <ul className="divide-y divide-line">
            {[...analysis.warnings, ...normalization.warnings].map((w, i) => (
              <li key={i} className="flex gap-3 px-5 py-3 text-sm">
                <SeverityDot severity={w.severity} />
                <div>
                  <p>{w.message}</p>
                  {w.remedy && <p className="mt-0.5 text-xs text-ink-muted">{w.remedy}</p>}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {error && <ErrorPanel error={error} />}

      {/* Confirm */}
      <div className="card card-pad sticky bottom-4 flex flex-wrap items-center justify-between gap-3 shadow-pop">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={saveMapping}
            onChange={(e) => setSaveMapping(e.target.checked)}
            className="rounded border-line text-accent focus:ring-accent"
          />
          Remember this column mapping for future uploads
        </label>

        <div className="flex items-center gap-3">
          {reconciliation.status === 'FAIL' && (
            <span className="text-xs text-amber-700">Figures do not reconcile</span>
          )}
          <button
            onClick={() => commit(reconciliation.status === 'FAIL')}
            disabled={!canImport || stage === 'importing' || ambiguous.length > 0}
            className="btn-primary"
          >
            {stage === 'importing'
              ? 'Importing…'
              : reconciliation.status === 'FAIL'
                ? 'Import anyway'
                : `Import ${normalization.rowCount.toLocaleString('en-IN')} rows`}
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="tnum font-medium">{value}</dd>
    </div>
  );
}

function Confidence({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const tone = pct >= 80 ? 'text-positive' : pct >= 50 ? 'text-amber-700' : 'text-ink-faint';
  return <span className={cn('tnum text-xs font-medium', tone)}>{pct}%</span>;
}

function RoleBadge({ role }: { role: string }) {
  const tone =
    role === 'FACTS' ? 'bg-accent-soft text-accent'
    : role === 'MAPPING' ? 'bg-emerald-50 text-emerald-800'
    : role === 'DERIVED' ? 'bg-amber-50 text-amber-800'
    : 'bg-canvas text-ink-faint';
  const label =
    role === 'FACTS' ? 'imported'
    : role === 'MAPPING' ? 'reference'
    : role === 'DERIVED' ? 'skipped (derived)'
    : 'skipped';
  return <span className={cn('badge', tone)}>{label}</span>;
}

function StatusPill({ status }: { status: string }) {
  const tone =
    status === 'PASS' ? 'bg-emerald-50 text-emerald-800'
    : status === 'FAIL' ? 'bg-rose-50 text-rose-800'
    : 'bg-canvas text-ink-faint';
  return <span className={cn('badge', tone)}>{status.toLowerCase()}</span>;
}

function SeverityDot({ severity }: { severity: string }) {
  const tone = severity === 'error' ? 'bg-negative' : severity === 'warning' ? 'bg-amber-500' : 'bg-ink-faint';
  return <span aria-hidden className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', tone)} />;
}

function ErrorPanel({ error }: { error: { message: string; remedy?: string; detail?: string } }) {
  return (
    <div role="alert" className="card mt-4 border-negative/30 card-pad">
      <h3 className="font-semibold text-negative">{error.message}</h3>
      {error.remedy && <p className="mt-1.5 text-sm text-ink-muted">{error.remedy}</p>}
      {error.detail && (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-ink-faint">Technical detail</summary>
          <pre className="mt-1 overflow-x-auto rounded bg-canvas p-2 text-xs">{error.detail}</pre>
        </details>
      )}
    </div>
  );
}

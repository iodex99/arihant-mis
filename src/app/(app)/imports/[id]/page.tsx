import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@/lib/db';
import { requireCompany } from '@/lib/company';
import SectionCard from '@/components/SectionCard';
import { formatBytes, formatCurrency, formatDateTime, formatPercent } from '@/lib/format';
import { cn } from '@/lib/cn';

export const dynamic = 'force-dynamic';

interface Reconciliation {
  status: string;
  checks: {
    code: string;
    label: string;
    status: string;
    expected: number | null;
    actual: number | null;
    difference: number | null;
    note?: string;
  }[];
  totals: { revenue: number; expense: number; profit: number; margin: number | null };
}

interface AnalysisJson {
  warnings?: { code: string; severity: string; message: string; remedy?: string }[];
}

export default async function ImportDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const company = await requireCompany();

  const imp = await prisma.import.findFirst({
    where: { id, companyId: company.id },
    include: {
      uploadedBy: { select: { name: true, email: true } },
      sheets: { orderBy: { sheetIndex: 'asc' } },
      mappingProfile: { select: { name: true, version: true } },
      _count: { select: { rows: true, facts: true } },
    },
  });

  if (!imp) notFound();

  const validation = imp.validation as unknown as Reconciliation | null;
  const analysis = imp.analysis as unknown as AnalysisJson | null;

  return (
    <>
      <header className="mb-5">
        <Link href="/imports" className="text-xs text-accent hover:underline">
          ← All imports
        </Link>
        <h1 className="mt-1 text-xl font-semibold tracking-tight">{imp.filename}</h1>
        <p className="mt-0.5 text-sm text-ink-muted">
          {formatDateTime(imp.finishedAt ?? imp.startedAt)} · {imp.uploadedBy?.name ?? 'system'} ·{' '}
          {formatBytes(imp.fileSize)}
        </p>
      </header>

      <div className="grid gap-4 lg:grid-cols-3">
        <SectionCard title="Result" className="lg:col-span-1">
          <dl className="space-y-2 text-sm">
            <Row label="Status" value={imp.status.toLowerCase().replace('_', ' ')} />
            <Row label="Source rows" value={imp._count.rows.toLocaleString('en-IN')} />
            <Row label="Entries created" value={imp._count.facts.toLocaleString('en-IN')} />
            <Row label="Validation" value={imp.validationStatus ?? '—'} />
            {imp.mappingProfile && (
              <Row label="Mapping profile" value={`${imp.mappingProfile.name} v${imp.mappingProfile.version}`} />
            )}
            <Row label="File hash" value={`${imp.fileHash.slice(0, 16)}…`} mono />
          </dl>

          {imp.errorMessage && (
            <p className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">{imp.errorMessage}</p>
          )}
        </SectionCard>

        {validation && (
          <SectionCard title="Figures" className="lg:col-span-2">
            <div className="mb-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Measure label="Revenue" value={formatCurrency(validation.totals.revenue)} />
              <Measure label="Expense" value={formatCurrency(validation.totals.expense)} />
              <Measure
                label="Profit"
                value={formatCurrency(validation.totals.profit)}
                negative={validation.totals.profit < 0}
              />
              <Measure label="Margin" value={formatPercent(validation.totals.margin)} />
            </div>

            <table className="w-full text-sm">
              <tbody>
                {validation.checks.map((c) => (
                  <tr key={c.code} className="border-t border-line/60">
                    <td className="py-2 pr-3">
                      <span
                        className={cn(
                          'badge',
                          c.status === 'PASS' ? 'bg-emerald-50 text-emerald-800'
                          : c.status === 'FAIL' ? 'bg-rose-50 text-rose-800'
                          : 'bg-canvas text-ink-faint',
                        )}
                      >
                        {c.status.toLowerCase()}
                      </span>
                    </td>
                    <td className="py-2 pr-3">{c.label}</td>
                    <td className="py-2 text-right text-xs text-ink-muted tnum">
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
          </SectionCard>
        )}
      </div>

      <SectionCard className="mt-4" title="Sheets">
        <div className="table-scroll rounded-lg border border-line">
          <table className="mis-table">
            <thead>
              <tr>
                <th>Sheet</th>
                <th>Role</th>
                <th className="num">Header row</th>
                <th className="num">Rows</th>
                <th className="num">Columns</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {imp.sheets.map((s) => (
                <tr key={s.id}>
                  <td className="font-medium">{s.name}</td>
                  <td>{s.role}</td>
                  <td className="num">{s.headerRow ?? '—'}</td>
                  <td className="num">{s.rowCount.toLocaleString('en-IN')}</td>
                  <td className="num">{s.columnCount}</td>
                  <td className="!whitespace-normal text-xs text-ink-muted">{s.roleReason ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>

      {analysis?.warnings && analysis.warnings.length > 0 && (
        <SectionCard className="mt-4" title="Notes recorded at import">
          <ul className="space-y-3 text-sm">
            {analysis.warnings.map((w, i) => (
              <li key={i}>
                <p>{w.message}</p>
                {w.remedy && <p className="mt-0.5 text-xs text-ink-muted">{w.remedy}</p>}
              </li>
            ))}
          </ul>
        </SectionCard>
      )}
    </>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-ink-muted">{label}</dt>
      <dd className={cn('font-medium', mono && 'font-mono text-xs')}>{value}</dd>
    </div>
  );
}

function Measure({ label, value, negative }: { label: string; value: string; negative?: boolean }) {
  return (
    <div>
      <div className="label">{label}</div>
      <div className={cn('mt-1 text-sm font-semibold tnum', negative && 'text-negative')}>{value}</div>
    </div>
  );
}

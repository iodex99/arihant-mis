import Link from 'next/link';
import { prisma } from '@/lib/db';
import { requireCompany } from '@/lib/company';
import SectionCard from '@/components/SectionCard';
import EmptyState from '@/components/EmptyState';
import { formatBytes, formatDateTime, formatCurrency } from '@/lib/format';
import { cn } from '@/lib/cn';

export const dynamic = 'force-dynamic';

export default async function ImportsPage() {
  const company = await requireCompany();

  const imports = await prisma.import.findMany({
    where: { companyId: company.id },
    orderBy: { startedAt: 'desc' },
    take: 100,
    include: { uploadedBy: { select: { name: true } } },
  });

  if (imports.length === 0) {
    return (
      <EmptyState
        title="No imports yet"
        body="Upload an Excel or CSV file to load financial data. Every import is kept with its validation result, so you can always trace a figure back to its source."
        action={{ href: '/imports/new', label: 'Upload a file' }}
      />
    );
  }

  return (
    <>
      <header className="mb-5 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Import history</h1>
          <p className="mt-0.5 text-sm text-ink-muted">
            {imports.length} import{imports.length === 1 ? '' : 's'} · nothing is ever overwritten
          </p>
        </div>
        <Link href="/imports/new" className="btn-primary">Upload a file</Link>
      </header>

      <SectionCard title="Imports" subtitle="Newest first">
        <div className="table-scroll rounded-lg border border-line">
          <table className="mis-table">
            <thead>
              <tr>
                <th>File</th>
                <th>When</th>
                <th>By</th>
                <th>Status</th>
                <th className="num">Rows</th>
                <th className="num">Entries</th>
                <th className="num">Revenue</th>
                <th className="num">Expense</th>
                <th className="num">Size</th>
              </tr>
            </thead>
            <tbody>
              {imports.map((imp) => {
                const totals = (imp.validation as { totals?: { revenue: number; expense: number } } | null)?.totals;
                return (
                  <tr key={imp.id}>
                    <td>
                      <Link href={`/imports/${imp.id}`} className="font-medium text-accent hover:underline">
                        {imp.filename}
                      </Link>
                    </td>
                    <td className="text-ink-muted">{formatDateTime(imp.finishedAt ?? imp.startedAt)}</td>
                    <td className="text-ink-muted">{imp.uploadedBy?.name ?? 'system'}</td>
                    <td><StatusBadge status={imp.status} validation={imp.validationStatus} /></td>
                    <td className="num">{imp.rowCount.toLocaleString('en-IN')}</td>
                    <td className="num">{imp.factCount.toLocaleString('en-IN')}</td>
                    <td className="num">{totals ? formatCurrency(totals.revenue) : '—'}</td>
                    <td className="num">{totals ? formatCurrency(totals.expense) : '—'}</td>
                    <td className="num text-ink-faint">{formatBytes(imp.fileSize)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </>
  );
}

function StatusBadge({ status, validation }: { status: string; validation: string | null }) {
  const tone =
    status === 'COMPLETED' ? 'bg-emerald-50 text-emerald-800'
    : status === 'NEEDS_REVIEW' ? 'bg-amber-50 text-amber-800'
    : status === 'FAILED' ? 'bg-rose-50 text-rose-800'
    : 'bg-canvas text-ink-faint';

  const label =
    status === 'COMPLETED' ? 'reconciled'
    : status === 'NEEDS_REVIEW' ? 'needs review'
    : status.toLowerCase().replace('_', ' ');

  return (
    <span className={cn('badge', tone)} title={validation ? `Validation: ${validation}` : undefined}>
      {label}
    </span>
  );
}

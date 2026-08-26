import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSessionUser } from '@/lib/auth';
import { requireCompany } from '@/lib/company';
import { prisma } from '@/lib/db';
import { ADAPTERS, getConnectionConfig, redactConnection } from '@/lib/tally';
import ConnectionPanel from './ConnectionPanel';
import SectionCard from '@/components/SectionCard';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/cn';

export const dynamic = 'force-dynamic';

export default async function ConnectionPage() {
  const user = await getSessionUser();
  if (!user || user.role !== 'ADMIN') redirect('/');

  const company = await requireCompany();
  const config = redactConnection(await getConnectionConfig(company.id));

  const [connection, runs] = await Promise.all([
    prisma.tallyConnection.findUnique({ where: { companyId: company.id } }),
    prisma.syncRun.findMany({
      where: { companyId: company.id },
      orderBy: { startedAt: 'desc' },
      take: 20,
      include: { _count: { select: { errors: true } } },
    }),
  ]);

  return (
    <>
      <header className="mb-5">
        <Link href="/admin" className="text-xs text-accent hover:underline">← Admin</Link>
        <h1 className="mt-1 text-xl font-semibold tracking-tight">Tally connection</h1>
        <p className="mt-0.5 text-sm text-ink-muted">
          Read-only. The MIS retrieves data from Tally and never writes back to it.
        </p>
      </header>

      <ConnectionPanel
        initialConfig={config}
        adapters={ADAPTERS}
        lastTest={{
          at: connection?.lastTestedAt ?? null,
          ok: connection?.lastTestOk ?? null,
          message: connection?.lastTestMessage ?? null,
          version: connection?.detectedVersion ?? null,
        }}
      />

      <SectionCard className="mt-4" title="Sync history" subtitle={`${runs.length} most recent runs`}>
        {runs.length === 0 ? (
          <p className="py-8 text-center text-sm text-ink-faint">
            No syncs have run yet. Test the connection first, then enable sync.
          </p>
        ) : (
          <div className="table-scroll rounded-lg border border-line">
            <table className="mis-table">
              <thead>
                <tr>
                  <th>Started</th>
                  <th>Trigger</th>
                  <th>Status</th>
                  <th className="num">Processed</th>
                  <th className="num">Added</th>
                  <th className="num">Failed</th>
                  <th className="num">Duration</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td>{formatDateTime(r.startedAt)}</td>
                    <td className="text-ink-muted">{r.trigger.toLowerCase()}</td>
                    <td>
                      <span className={cn('badge',
                        r.status === 'SUCCESS' ? 'bg-emerald-50 text-emerald-800'
                        : r.status === 'PARTIAL' ? 'bg-amber-50 text-amber-800'
                        : r.status === 'FAILED' ? 'bg-rose-50 text-rose-800'
                        : 'bg-canvas text-ink-faint')}>
                        {r.status.toLowerCase()}
                      </span>
                    </td>
                    <td className="num">{r.recordsProcessed.toLocaleString('en-IN')}</td>
                    <td className="num">{r.recordsAdded.toLocaleString('en-IN')}</td>
                    <td className="num">{r.recordsFailed.toLocaleString('en-IN')}</td>
                    <td className="num text-ink-faint">{r.durationMs ? `${(r.durationMs / 1000).toFixed(1)}s` : '—'}</td>
                    <td className="!whitespace-normal text-xs text-ink-muted">{r.errorMessage ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <SectionCard className="mt-4" title="What is confirmed, and what is not">
        <div className="space-y-3 text-sm text-ink-muted">
          <p>
            <strong className="text-ink">Confirmed:</strong> the XML/HTTP adapter is implemented
            against Tally&rsquo;s documented export envelope format, and the MIS pipeline from Tally
            data to dashboard is complete and tested.
          </p>
          <p>
            <strong className="text-ink">Not yet confirmed:</strong> whether Arihant&rsquo;s
            installation has the connectivity listener enabled, on which host and port, which Tally
            version and edition it runs, and whether its licence permits the listener. Those are
            facts about the machine, not about this code, and the connection test above is how they
            get established.
          </p>
          <p>
            Until that test passes, the file-import path is fully operational and is the supported
            way to load data. See{' '}
            <code className="rounded bg-canvas px-1">docs/tally-integration.md</code> for the full
            record.
          </p>
        </div>
      </SectionCard>
    </>
  );
}

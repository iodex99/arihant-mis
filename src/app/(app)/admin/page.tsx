import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSessionUser } from '@/lib/auth';
import { requireCompany } from '@/lib/company';
import { prisma } from '@/lib/db';
import { getConnectionConfig, redactConnection } from '@/lib/tally';
import SectionCard from '@/components/SectionCard';
import { formatDateTime, formatRelative } from '@/lib/format';
import { cn } from '@/lib/cn';

export const dynamic = 'force-dynamic';

const APP_VERSION = process.env.APP_VERSION ?? '1.0.0';

export default async function AdminPage() {
  const user = await getSessionUser();
  if (!user || user.role !== 'ADMIN') redirect('/');

  const company = await requireCompany();
  const config = redactConnection(await getConnectionConfig(company.id));

  const [connection, lastSync, syncCount, importCount, lastImport, factCount, accountCount, unmapped, dbTime] =
    await Promise.all([
      prisma.tallyConnection.findUnique({ where: { companyId: company.id } }),
      prisma.syncRun.findFirst({ where: { companyId: company.id }, orderBy: { startedAt: 'desc' } }),
      prisma.syncRun.count({ where: { companyId: company.id } }),
      prisma.import.count({ where: { companyId: company.id } }),
      prisma.import.findFirst({
        where: { companyId: company.id, status: { in: ['COMPLETED', 'NEEDS_REVIEW'] } },
        orderBy: { finishedAt: 'desc' },
      }),
      prisma.factEntry.count({ where: { companyId: company.id } }),
      prisma.account.count({ where: { companyId: company.id } }),
      prisma.account.count({ where: { companyId: company.id, groupMapped: false } }),
      prisma.$queryRaw<{ now: Date }[]>`SELECT NOW() as now`.then((r) => r[0]?.now ?? null).catch(() => null),
    ]);

  return (
    <>
      <header className="mb-5">
        <h1 className="text-xl font-semibold tracking-tight">Admin</h1>
        <p className="mt-0.5 text-sm text-ink-muted">Connection, imports, mappings and system status</p>
      </header>

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard
          title="Tally connection"
          subtitle={config.enabled ? 'Enabled' : 'Not enabled'}
          action={<Link href="/admin/connection" className="btn-secondary text-xs">Configure &amp; test</Link>}
        >
          <div className="mb-4 flex items-center gap-2">
            <span
              aria-hidden
              className={cn(
                'h-2.5 w-2.5 rounded-full',
                connection?.lastTestOk ? 'bg-emerald-500' : connection ? 'bg-rose-500' : 'bg-slate-300',
              )}
            />
            <span className="text-sm font-medium">
              {connection?.lastTestOk ? 'Connected' : connection ? 'Disconnected' : 'Never tested'}
            </span>
          </div>

          <dl className="space-y-2 text-sm">
            <Row label="Adapter" value={config.adapter} />
            <Row label="Endpoint" value={`${config.useHttps ? 'https' : 'http'}://${config.host}:${config.port}`} />
            <Row label="Tally company" value={config.companyName ?? 'not set'} />
            <Row label="Tally version" value={connection?.detectedVersion ?? 'unknown'} />
            <Row label="Last tested" value={formatDateTime(connection?.lastTestedAt)} />
            <Row label="Last successful sync" value={formatDateTime(connection?.lastSuccessfulSyncAt)} />
          </dl>

          {connection?.lastTestMessage && (
            <p className={cn('mt-3 rounded-lg px-3 py-2 text-xs', connection.lastTestOk ? 'bg-emerald-50 text-emerald-900' : 'bg-amber-50 text-amber-900')}>
              {connection.lastTestMessage}
            </p>
          )}

          {!config.enabled && (
            <p className="mt-3 rounded-lg bg-canvas px-3 py-2 text-xs text-ink-muted">
              Tally sync is off. The MIS is running from uploaded files, which is fully supported.
              Enable sync only after the connection test succeeds against Arihant’s Tally machine.
            </p>
          )}
        </SectionCard>

        <SectionCard
          title="Data"
          subtitle="What the MIS is currently reporting from"
          action={<Link href="/imports" className="btn-secondary text-xs">Import history</Link>}
        >
          <dl className="space-y-2 text-sm">
            <Row label="Entries stored" value={factCount.toLocaleString('en-IN')} />
            <Row label="Accounts" value={accountCount.toLocaleString('en-IN')} />
            <Row
              label="Unmapped accounts"
              value={unmapped === 0 ? 'none' : `${unmapped} — assign a group`}
              tone={unmapped > 0 ? 'warn' : undefined}
            />
            <Row label="File imports" value={importCount.toLocaleString('en-IN')} />
            <Row label="Latest import" value={lastImport ? `${lastImport.filename} · ${formatRelative(lastImport.finishedAt)}` : 'none'} />
            <Row label="Sync runs" value={syncCount.toLocaleString('en-IN')} />
            <Row
              label="Latest sync"
              value={lastSync ? `${lastSync.status.toLowerCase()} · ${formatRelative(lastSync.finishedAt ?? lastSync.startedAt)}` : 'never'}
            />
          </dl>

          {unmapped > 0 && (
            <Link href="/admin/mappings" className="btn-secondary mt-4 text-xs">
              Review {unmapped} unmapped account{unmapped === 1 ? '' : 's'}
            </Link>
          )}
        </SectionCard>

        <SectionCard title="System">
          <dl className="space-y-2 text-sm">
            <Row label="Application version" value={`Arihant MIS v${APP_VERSION}`} />
            <Row label="Database" value={dbTime ? 'connected' : 'unreachable'} tone={dbTime ? undefined : 'warn'} />
            <Row label="Database time" value={formatDateTime(dbTime)} />
            <Row label="Node" value={process.version} />
            <Row label="Environment" value={process.env.NODE_ENV ?? 'development'} />
          </dl>
          <p className="mt-3 text-xs text-ink-faint">
            Backups are taken by <code className="rounded bg-canvas px-1">scripts/backup.sh</code> on the
            server; see <code className="rounded bg-canvas px-1">docs/backup-and-restore.md</code>.
          </p>
        </SectionCard>

        <SectionCard
          title="Mappings"
          subtitle="Expense heads, groups and saved column mappings"
          action={<Link href="/admin/mappings" className="btn-secondary text-xs">Open</Link>}
        >
          <p className="text-sm text-ink-muted">
            Assign expense heads to group heads, and review the column mappings the importer has
            remembered from previous uploads.
          </p>
        </SectionCard>
      </div>
    </>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: 'warn' }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-ink-muted">{label}</dt>
      <dd className={cn('text-right font-medium', tone === 'warn' && 'text-amber-700')}>{value}</dd>
    </div>
  );
}

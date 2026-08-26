import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getSessionUser } from '@/lib/auth';
import { getActiveCompany } from '@/lib/company';
import NavLinks from '@/components/NavLinks';
import UserMenu from '@/components/UserMenu';
import DataSourceBadge from '@/components/DataSourceBadge';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  if (!user) redirect('/login');

  const company = await getActiveCompany();

  // Where the currently displayed figures came from, so nobody mistakes a
  // stale import for a live Tally feed (build spec §27).
  const [latestImport, latestSync] = company
    ? await Promise.all([
        prisma.import.findFirst({
          where: { companyId: company.id, status: { in: ['COMPLETED', 'NEEDS_REVIEW'] } },
          orderBy: { finishedAt: 'desc' },
          select: { filename: true, finishedAt: true, status: true },
        }),
        prisma.syncRun.findFirst({
          where: { companyId: company.id, status: 'SUCCESS' },
          orderBy: { finishedAt: 'desc' },
          select: { finishedAt: true, recordsProcessed: true },
        }),
      ])
    : [null, null];

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-line bg-surface/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1600px] items-center gap-6 px-4 py-3 sm:px-6">
          <Link href="/" className="shrink-0">
            <span className="block text-sm font-semibold leading-tight tracking-tight">
              {company?.name ?? 'Arihant Academy'}
            </span>
            <span className="block text-xs leading-tight text-ink-faint">Financial MIS</span>
          </Link>

          <NavLinks role={user.role} />

          <div className="ml-auto flex items-center gap-3">
            <DataSourceBadge latestImport={latestImport} latestSync={latestSync} />
            <UserMenu user={user} />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1600px] px-4 py-6 sm:px-6">{children}</main>
    </div>
  );
}

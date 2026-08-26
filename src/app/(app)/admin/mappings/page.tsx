import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSessionUser } from '@/lib/auth';
import { requireCompany } from '@/lib/company';
import { prisma } from '@/lib/db';
import SectionCard from '@/components/SectionCard';
import MappingEditor from './MappingEditor';
import { formatDateTime } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function MappingsPage() {
  const user = await getSessionUser();
  if (!user || user.role !== 'ADMIN') redirect('/');

  const company = await requireCompany();

  const [accounts, profiles, branches, streams] = await Promise.all([
    prisma.account.findMany({
      where: { companyId: company.id, kind: 'EXPENSE' },
      select: { id: true, name: true, groupHead: true, groupMapped: true },
      orderBy: [{ groupMapped: 'asc' }, { name: 'asc' }],
    }),
    prisma.mappingProfile.findMany({
      where: { companyId: company.id },
      orderBy: [{ name: 'asc' }, { version: 'desc' }],
    }),
    prisma.branch.findMany({
      where: { companyId: company.id },
      select: { abbreviation: true, name: true, status: true, centre: { select: { name: true } } },
      orderBy: { abbreviation: 'asc' },
    }),
    prisma.stream.findMany({
      where: { companyId: company.id },
      select: { name: true },
      orderBy: { name: 'asc' },
    }),
  ]);

  const groups = [...new Set(accounts.map((a) => a.groupHead))].sort();
  const unmapped = accounts.filter((a) => !a.groupMapped);

  return (
    <>
      <header className="mb-5">
        <Link href="/admin" className="text-xs text-accent hover:underline">
          ← Admin
        </Link>
        <h1 className="mt-1 text-xl font-semibold tracking-tight">Mappings</h1>
        <p className="mt-0.5 text-sm text-ink-muted">
          Expense head groupings, branches and streams, and remembered column mappings
        </p>
      </header>

      {unmapped.length > 0 && (
        <div className="card mb-4 border-amber-300 card-pad">
          <h2 className="font-semibold text-amber-800">
            {unmapped.length} expense head{unmapped.length === 1 ? '' : 's'} without a group
          </h2>
          <p className="mt-1 text-sm text-ink-muted">
            These are reported under “Unclassified”. Their amounts are included in every total —
            nothing is lost — but the group analysis is incomplete until they are assigned.
          </p>
        </div>
      )}

      <SectionCard
        title="Expense head to group head"
        subtitle={`${accounts.length} heads across ${groups.length} groups`}
      >
        <MappingEditor accounts={accounts} groups={groups} />
      </SectionCard>

      <SectionCard
        className="mt-4"
        title="Saved column mappings"
        subtitle="Reused automatically when a similar file is uploaded"
      >
        {profiles.length === 0 ? (
          <p className="py-8 text-center text-sm text-ink-faint">
            No mappings saved yet. Tick “Remember this column mapping” when importing a file.
          </p>
        ) : (
          <div className="table-scroll rounded-lg border border-line">
            <table className="mis-table">
              <thead>
                <tr>
                  <th>Profile</th>
                  <th className="num">Version</th>
                  <th>Created</th>
                  <th>Sheets covered</th>
                </tr>
              </thead>
              <tbody>
                {profiles.map((p) => {
                  const mapping = p.mapping as unknown as { sheet: string; role: string }[] | null;
                  return (
                    <tr key={p.id}>
                      <td className="font-medium">{p.name}</td>
                      <td className="num">v{p.version}</td>
                      <td className="text-ink-muted">{formatDateTime(p.createdAt)}</td>
                      <td className="!whitespace-normal text-xs text-ink-muted">
                        {Array.isArray(mapping)
                          ? mapping.map((m) => `${m.sheet} (${m.role.toLowerCase()})`).join(', ')
                          : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <SectionCard title="Branches" subtitle={`${branches.length} known`}>
          <div className="table-scroll max-h-96 rounded-lg border border-line">
            <table className="mis-table">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Name</th>
                  <th>Centre</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {branches.map((b) => (
                  <tr key={b.abbreviation}>
                    <td className="font-medium">{b.abbreviation}</td>
                    <td className="!whitespace-normal">{b.name}</td>
                    <td className="text-ink-muted">{b.centre?.name ?? '—'}</td>
                    <td className="text-ink-muted">{b.status ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-ink-faint">
            Branches are keyed on their code, because that is what the reports group by and it is
            not one-to-one with the branch name in the source data.
          </p>
        </SectionCard>

        <SectionCard title="Streams" subtitle={`${streams.length} known`}>
          <ul className="space-y-1 text-sm">
            {streams.map((s) => (
              <li key={s.name}>{s.name}</li>
            ))}
          </ul>
        </SectionCard>
      </div>
    </>
  );
}

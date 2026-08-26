import Link from 'next/link';
import { requireCompany } from '@/lib/company';
import { parseFilters, describeFilters, serializeFilters } from '@/lib/mis/filters';
import { getFilterOptions, getTrend } from '@/lib/mis/engine';
import { drill, getSourceRows } from '@/lib/mis/drill';
import FilterBar from '@/components/FilterBar';
import EmptyState from '@/components/EmptyState';
import { prisma } from '@/lib/db';
import SectionCard from '@/components/SectionCard';
import KpiCard from '@/components/KpiCard';
import { TrendChart } from '@/components/charts/Charts';
import SourceRows from './SourceRows';
import { formatCurrency, formatPercent } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function DrillPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const company = await requireCompany();
  const filters = parseFilters(params);

  const one = (k: string) => {
    const v = params[k];
    return Array.isArray(v) ? v[0] : v;
  };

  const query = {
    branch: one('branch'),
    group: one('group'),
    account: one('account'),
  };

  // Deleting the last import leaves the dimensions in place, so the drill page
  // would otherwise render a scaffold of zeros rather than saying there is no
  // data. Match the dashboard and the tabular MIS.
  const factCount = await prisma.factEntry.count({ where: { companyId: company.id } });
  if (factCount === 0) {
    return (
      <EmptyState
        title="No financial data available"
        body="Connect Tally or upload an Excel/CSV file to generate the MIS."
        action={{ href: '/imports/new', label: 'Upload Excel or CSV' }}
      />
    );
  }

  const [options, result, trend] = await Promise.all([
    getFilterOptions(company.id),
    drill(company.id, filters, query),
    getTrend(company.id, {
      ...filters,
      branches: query.branch ? [query.branch] : filters.branches,
      groups: query.group ? [query.group] : filters.groups,
      accounts: query.account ? [query.account] : filters.accounts,
    }),
  ]);

  const sourceRows =
    result.level === 'source'
      ? await getSourceRows(company.id, {
          ...filters,
          branches: query.branch ? [query.branch] : filters.branches,
          groups: query.group ? [query.group] : filters.groups,
          accounts: query.account ? [query.account] : filters.accounts,
        })
      : [];

  const base = serializeFilters(filters);
  const linkTo = (next: Partial<typeof query>) => {
    const p = new URLSearchParams(base);
    const merged = { ...query, ...next };
    if (merged.branch) p.set('branch', merged.branch);
    if (merged.group) p.set('group', merged.group);
    if (merged.account) p.set('account', merged.account);
    return `/drill?${p.toString()}`;
  };

  return (
    <>
      <header className="mb-5">
        <h1 className="text-xl font-semibold tracking-tight">Drill-down</h1>
        <p className="mt-0.5 text-sm text-ink-muted">{describeFilters(filters)}</p>
      </header>

      <FilterBar options={options} />

      {/* Breadcrumb */}
      <nav aria-label="Drill path" className="mb-4 flex flex-wrap items-center gap-1.5 text-sm">
        <Link href={`/drill?${base}`} className="rounded px-2 py-1 text-accent hover:bg-accent-soft">
          All branches
        </Link>
        {result.path.map((p, i) => (
          <span key={p.key} className="flex items-center gap-1.5">
            <span aria-hidden className="text-ink-faint">›</span>
            {i === result.path.length - 1 ? (
              <span className="rounded bg-canvas px-2 py-1 font-medium">{p.label}</span>
            ) : (
              <Link
                href={linkTo(
                  p.level === 'branch'
                    ? { group: undefined, account: undefined }
                    : { account: undefined },
                )}
                className="rounded px-2 py-1 text-accent hover:bg-accent-soft"
              >
                {p.label}
              </Link>
            )}
          </span>
        ))}
      </nav>

      <div className="mb-4 grid grid-cols-kpi gap-4">
        <KpiCard label="Revenue" value={result.header.revenue} />
        <KpiCard label="Expense" value={result.header.expense} />
        <KpiCard label="Profit" value={result.header.profit} signed />
        <KpiCard label="Profit margin" value={result.header.margin} kind="percent" signed />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <SectionCard title="Monthly trend" subtitle={result.header.title}>
          {trend.length > 1 ? (
            <TrendChart data={trend.map((t) => ({ periodLabel: t.periodLabel, revenue: t.revenue, expense: t.expense, profit: t.profit }))} />
          ) : (
            <p className="py-16 text-center text-sm text-ink-faint">
              Only one period is in view, so there is no trend to plot.
            </p>
          )}
        </SectionCard>

        <SectionCard
          title={
            result.level === 'branch' ? 'Expense by branch'
            : result.level === 'group' ? 'Expense by group'
            : result.level === 'account' ? 'Expense by head'
            : 'Source rows'
          }
          subtitle={
            result.nextLevel
              ? `Select a row to drill into ${result.nextLevel === 'source' ? 'its source rows' : `its ${result.nextLevel}s`}`
              : undefined
          }
        >
          {result.level === 'source' ? (
            <div>
              <p className="mb-4 rounded-lg bg-canvas px-3 py-2.5 text-xs text-ink-muted">
                {result.leafNote}
              </p>
              <SourceRows rows={sourceRows} />
            </div>
          ) : (
            <div className="table-scroll max-h-[420px] rounded-lg border border-line">
              <table className="mis-table">
                <thead>
                  <tr>
                    <th>{result.level === 'branch' ? 'Branch' : result.level === 'group' ? 'Group' : 'Expense head'}</th>
                    <th className="num">Amount</th>
                    <th className="num">Share</th>
                  </tr>
                </thead>
                <tbody>
                  {result.nodes.length === 0 && (
                    <tr>
                      <td colSpan={3} className="py-8 text-center text-ink-faint">
                        No expense in this selection.
                      </td>
                    </tr>
                  )}
                  {result.nodes.map((n) => (
                    <tr key={n.key}>
                      <td>
                        <Link
                          href={linkTo(
                            result.level === 'branch' ? { branch: n.key }
                            : result.level === 'group' ? { group: n.key }
                            : { account: n.key },
                          )}
                          className="font-medium text-accent hover:underline"
                        >
                          {n.label}
                        </Link>
                      </td>
                      <td className={`num ${n.amount < 0 ? 'text-negative' : ''}`}>{formatCurrency(n.amount)}</td>
                      <td className="num text-ink-muted">{formatPercent(n.share, 1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>
      </div>
    </>
  );
}

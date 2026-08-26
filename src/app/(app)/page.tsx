import Link from 'next/link';
import { requireCompany } from '@/lib/company';
import { parseFilters, describeFilters } from '@/lib/mis/filters';
import {
  getKpis,
  getByDimension,
  getExpenseAnalysis,
  getTrend,
  getExpenseTrend,
  getFilterOptions,
} from '@/lib/mis/engine';
import { prisma } from '@/lib/db';
import FilterBar from '@/components/FilterBar';
import KpiCard from '@/components/KpiCard';
import SectionCard from '@/components/SectionCard';
import EmptyState from '@/components/EmptyState';
import {
  TrendChart,
  RevenueExpenseChart,
  SignedBarChart,
  CompositionChart,
  ExpenseTrendChart,
} from '@/components/charts/Charts';
import { formatCurrency, formatPercent } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const company = await requireCompany();
  const filters = parseFilters(await searchParams);

  const factCount = await prisma.factEntry.count({ where: { companyId: company.id } });
  if (factCount === 0) {
    return (
      <EmptyState
        title="No financial data available"
        body="Connect Tally or upload an Excel/CSV file to generate the MIS. Uploaded files are analysed and validated before anything is imported."
        action={{ href: '/imports/new', label: 'Upload Excel or CSV' }}
        secondary={{ href: '/admin/connection', label: 'Connect Tally' }}
      />
    );
  }

  const [options, kpis, byStream, byBranch, byGroup, trend, expenseTrend] = await Promise.all([
    getFilterOptions(company.id),
    getKpis(company.id, filters),
    getByDimension(company.id, filters, 'stream'),
    getByDimension(company.id, filters, 'branch'),
    getExpenseAnalysis(company.id, filters, 'group'),
    getTrend(company.id, filters),
    getExpenseTrend(company.id, filters),
  ]);

  const trading = byBranch.filter((b) => b.revenue > 0);
  const ranked = [...trading].sort((a, b) => (b.margin ?? -Infinity) - (a.margin ?? -Infinity));
  const top = ranked.slice(0, 5);
  const bottom = ranked.slice(-5).reverse();
  const costOnly = byBranch.filter((b) => b.revenue === 0 && b.expense !== 0);

  return (
    <>
      <header className="mb-5">
        <h1 className="text-xl font-semibold tracking-tight">Financial Snapshot</h1>
        <p className="mt-0.5 text-sm text-ink-muted">{describeFilters(filters)}</p>
      </header>

      <FilterBar options={options} />

      <div className="mb-6 grid grid-cols-kpi gap-4">
        <KpiCard label="Revenue" value={kpis.revenue} />
        <KpiCard label="Expense" value={kpis.expense} />
        <KpiCard label="Profit" value={kpis.profit} signed emphasis />
        <KpiCard
          label="Profit margin"
          value={kpis.margin}
          kind="percent"
          signed
          detail={kpis.margin === null ? 'no revenue in this selection' : undefined}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <SectionCard
          title="Monthly trend"
          subtitle={`${trend.length} period${trend.length === 1 ? '' : 's'} in view`}
        >
          {trend.length > 1 ? (
            <TrendChart data={trend.map((t) => ({ periodLabel: t.periodLabel, revenue: t.revenue, expense: t.expense, profit: t.profit }))} />
          ) : (
            <NotEnoughPeriods count={trend.length} />
          )}
        </SectionCard>

        <SectionCard title="Revenue vs expense by stream">
          <RevenueExpenseChart
            data={byStream.map((s) => ({ label: s.label, revenue: s.revenue, expense: s.expense }))}
          />
        </SectionCard>

        <SectionCard
          title="Profit by branch"
          subtitle={`${trading.length} branches with revenue`}
          action={<Link href="/mis#branch" className="btn-ghost text-xs">View table</Link>}
        >
          <SignedBarChart
            data={ranked.slice(0, 14).map((b) => ({ label: b.key, value: b.profit }))}
            height={Math.max(280, Math.min(ranked.length, 14) * 26)}
          />
        </SectionCard>

        <SectionCard
          title="Stream profitability"
          action={<Link href="/mis#stream" className="btn-ghost text-xs">View table</Link>}
        >
          <SignedBarChart
            data={byStream.map((s) => ({ label: s.label, value: s.profit }))}
            layout="horizontal"
            height={280}
          />
        </SectionCard>

        <SectionCard
          title="Expense composition"
          subtitle="By group head"
          action={<Link href="/mis#group" className="btn-ghost text-xs">View table</Link>}
        >
          <CompositionChart data={byGroup.map((g) => ({ label: g.label, value: g.amount }))} />
        </SectionCard>

        <SectionCard title="Expense trend" subtitle="Stacked by group head">
          {trend.length > 1 ? (
            <ExpenseTrendChart series={expenseTrend.series} groups={expenseTrend.groups} />
          ) : (
            <NotEnoughPeriods count={trend.length} />
          )}
        </SectionCard>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <RankTable title="Strongest branches" subtitle="By profit margin" rows={top} />
        <RankTable title="Weakest branches" subtitle="By profit margin" rows={bottom} />
      </div>

      {costOnly.length > 0 && (
        <SectionCard
          className="mt-4"
          title="Cost-only branches"
          subtitle={`${costOnly.length} branches carry expense with no revenue in this selection`}
        >
          <div className="table-scroll">
            <table className="mis-table">
              <thead>
                <tr>
                  <th>Branch</th>
                  <th className="num">Expense</th>
                </tr>
              </thead>
              <tbody>
                {costOnly.map((b) => (
                  <tr key={b.key}>
                    <td className="font-medium">{b.label}</td>
                    <td className="num">{formatCurrency(b.expense)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>Total</td>
                  <td className="num">{formatCurrency(costOnly.reduce((s, b) => s + b.expense, 0))}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="mt-3 text-xs text-ink-faint">
            These have no profit margin — a margin needs revenue to divide by. They are shown
            separately rather than ranked at 0 %, which would place them alongside genuinely
            break-even branches.
          </p>
        </SectionCard>
      )}
    </>
  );
}

function NotEnoughPeriods({ count }: { count: number }) {
  return (
    <div className="flex h-[260px] items-center justify-center text-center">
      <p className="max-w-xs text-sm text-ink-faint">
        {count === 0
          ? 'No periods match the current filters.'
          : 'Only one period is in view, so there is no trend to plot yet. Widen the month filter or import another period.'}
      </p>
    </div>
  );
}

function RankTable({
  title,
  subtitle,
  rows,
}: {
  title: string;
  subtitle: string;
  rows: { key: string; label: string; revenue: number; profit: number; margin: number | null }[];
}) {
  return (
    <SectionCard title={title} subtitle={subtitle}>
      <div className="table-scroll">
        <table className="mis-table">
          <thead>
            <tr>
              <th>Branch</th>
              <th className="num">Revenue</th>
              <th className="num">Profit</th>
              <th className="num">Margin</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={4} className="py-6 text-center text-ink-faint">
                  No branches with revenue in this selection.
                </td>
              </tr>
            )}
            {rows.map((b) => (
              <tr key={b.key}>
                <td>
                  <Link href={`/drill?branch=${encodeURIComponent(b.key)}`} className="font-medium text-accent hover:underline">
                    {b.label}
                  </Link>
                </td>
                <td className="num">{formatCurrency(b.revenue)}</td>
                <td className={`num ${b.profit < 0 ? 'text-negative' : ''}`}>{formatCurrency(b.profit)}</td>
                <td className={`num ${(b.margin ?? 0) < 0 ? 'text-negative' : ''}`}>{formatPercent(b.margin)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}

import Link from 'next/link';
import { requireCompany } from '@/lib/company';
import { prisma } from '@/lib/db';
import { parseFilters, describeFilters } from '@/lib/mis/filters';
import { getFilterOptions, getByDimension, getKpis } from '@/lib/mis/engine';
import {
  getVariance,
  getConcentration,
  getStreamBranchMatrix,
  getCostStructure,
  getBranchPositioning,
} from '@/lib/mis/analysis';
import FilterBar from '@/components/FilterBar';
import SectionCard from '@/components/SectionCard';
import EmptyState from '@/components/EmptyState';
import { CompositionChart } from '@/components/charts/Charts';
import {
  VarianceChart,
  ParetoChart,
  StructureChart,
  PositioningChart,
} from '@/components/charts/AnalysisCharts';
import MarginMatrix from './MarginMatrix';
import { formatCurrency, formatPercent, formatCompactCurrency } from '@/lib/format';
import { cn } from '@/lib/cn';

export const dynamic = 'force-dynamic';

const SECTIONS = [
  ['variance', 'What changed'],
  ['centre', 'Centre & status'],
  ['matrix', 'Stream × branch'],
  ['concentration', 'Concentration'],
  ['structure', 'Cost structure'],
  ['positioning', 'Scale vs margin'],
] as const;

export default async function AnalysisPage({
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
        body="Connect Tally or upload an Excel/CSV file to generate the MIS."
        action={{ href: '/imports/new', label: 'Upload Excel or CSV' }}
      />
    );
  }

  const [options, kpis, variance, concentration, matrix, structure, positioning, byCentre, byStatus] =
    await Promise.all([
      getFilterOptions(company.id),
      getKpis(company.id, filters),
      getVariance(company.id, filters),
      getConcentration(company.id, filters, 'profit'),
      getStreamBranchMatrix(company.id, filters),
      getCostStructure(company.id, filters),
      getBranchPositioning(company.id, filters),
      getByDimension(company.id, filters, 'centre'),
      getStatusBreakdown(company.id, filters),
    ]);

  return (
    <>
      <header className="mb-5">
        <h1 className="text-xl font-semibold tracking-tight">Analysis</h1>
        <p className="mt-0.5 text-sm text-ink-muted">{describeFilters(filters)}</p>
      </header>

      <FilterBar options={options} />

      <nav aria-label="Report sections" className="mb-5 flex flex-wrap gap-2 no-print">
        {SECTIONS.map(([id, label]) => (
          <a
            key={id}
            href={`#${id}`}
            className="rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-medium text-ink-muted transition-colors hover:border-accent hover:text-accent"
          >
            {label}
          </a>
        ))}
      </nav>

      <div className="space-y-4">
        {/* ---------------------------------------------------------------- */}
        <SectionCard
          id="variance"
          title="A. What changed"
          subtitle={
            variance.available
              ? `${variance.fromPeriod} compared with ${variance.toPeriod}`
              : 'Period-over-period movement'
          }
        >
          {!variance.available ? (
            <p className="py-10 text-center text-sm text-ink-faint">{variance.reason}</p>
          ) : (
            <>
              <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Movement label="Revenue" from={variance.revenue.from} to={variance.revenue.to} change={variance.revenue.change} />
                <Movement label="Expense" from={variance.expense.from} to={variance.expense.to} change={variance.expense.change} higherIsWorse />
                <Movement label="Profit" from={variance.profit.from} to={variance.profit.to} change={variance.profit.change} />
                <Movement
                  label="Operating profit"
                  from={variance.operatingProfit.from}
                  to={variance.operatingProfit.to}
                  change={variance.operatingProfit.change}
                  hint="excludes centrally-booked groups"
                />
              </div>

              {variance.distortion && (
                <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-3.5 py-3">
                  <p className="text-sm font-medium text-amber-900">
                    The headline movement is not what it looks like
                  </p>
                  <p className="mt-1 text-sm text-ink-muted">{variance.distortion.note}</p>
                </div>
              )}

              <div className="grid gap-5 xl:grid-cols-2">
                <div>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-faint">
                    Expense movement by head
                  </h3>
                  <VarianceChart
                    higherIsWorse
                    data={variance.byAccount.slice(0, 12).map((l) => ({
                      label: l.label.length > 22 ? `${l.label.slice(0, 21)}…` : l.label,
                      change: l.change,
                      unallocated: l.unallocated,
                    }))}
                    height={Math.max(260, Math.min(variance.byAccount.length, 12) * 28)}
                  />
                  <p className="mt-2 text-xs text-ink-faint">
                    Blue is a reduction, red an increase. Grey bars are booked centrally rather than
                    by branch.
                  </p>
                </div>

                <div>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-faint">
                    Profit movement by branch
                  </h3>
                  <VarianceChart
                    data={[...variance.byBranch]
                      .filter((l) => Math.abs(l.change) > 0)
                      .sort((a, b) => Math.abs(b.change) - Math.abs(a.change))
                      .slice(0, 12)
                      .sort((a, b) => b.change - a.change)
                      .map((l) => ({ label: l.label, change: l.change }))}
                    height={Math.max(260, Math.min(variance.byBranch.length, 12) * 28)}
                  />
                  <p className="mt-2 text-xs text-ink-faint">
                    The twelve largest movements in either direction. Blue gained, red lost.
                  </p>
                </div>
              </div>

              <div className="mt-5 table-scroll max-h-80 rounded-lg border border-line">
                <table className="mis-table">
                  <thead>
                    <tr>
                      <th>Expense head</th>
                      <th className="num">{variance.fromPeriod}</th>
                      <th className="num">{variance.toPeriod}</th>
                      <th className="num">Change</th>
                      <th className="num">%</th>
                    </tr>
                  </thead>
                  <tbody>
                    {variance.byAccount.map((l) => (
                      <tr key={l.key}>
                        <td className="font-medium">
                          {l.label}
                          {l.unallocated && (
                            <span className="ml-2 badge bg-canvas text-ink-faint">central</span>
                          )}
                        </td>
                        <td className="num">{formatCurrency(l.from)}</td>
                        <td className="num">{formatCurrency(l.to)}</td>
                        <td className={cn('num', l.change > 0 ? 'text-negative' : 'text-positive')}>
                          {formatCurrency(l.change)}
                        </td>
                        <td className="num text-ink-muted">{formatPercent(l.changePct, 1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </SectionCard>

        {/* ---------------------------------------------------------------- */}
        <SectionCard
          id="centre"
          title="B. Centre and branch status"
          subtitle="Two dimensions the previous report did not break out"
        >
          <div className="grid gap-6 lg:grid-cols-2">
            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-faint">
                Revenue by centre
              </h3>
              <CompositionChart data={byCentre.filter((c) => c.revenue > 0).map((c) => ({ label: c.label, value: c.revenue }))} />
            </div>

            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-faint">
                Centre profitability
              </h3>
              <div className="table-scroll rounded-lg border border-line">
                <table className="mis-table">
                  <thead>
                    <tr>
                      <th>Centre</th>
                      <th className="num">Revenue</th>
                      <th className="num">Expense</th>
                      <th className="num">Profit</th>
                      <th className="num">Margin</th>
                    </tr>
                  </thead>
                  <tbody>
                    {byCentre.map((c) => (
                      <tr key={c.key}>
                        <td className="font-medium">{c.label}</td>
                        <td className="num">{formatCurrency(c.revenue)}</td>
                        <td className="num">{formatCurrency(c.expense)}</td>
                        <td className={cn('num', c.profit < 0 && 'text-negative')}>{formatCurrency(c.profit)}</td>
                        <td className={cn('num', (c.margin ?? 0) < 0 && 'text-negative')}>{formatPercent(c.margin)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <h3 className="mb-2 mt-5 text-xs font-semibold uppercase tracking-wide text-ink-faint">
                By branch status
              </h3>
              <div className="table-scroll rounded-lg border border-line">
                <table className="mis-table">
                  <thead>
                    <tr>
                      <th>Status</th>
                      <th className="num">Branches</th>
                      <th className="num">Revenue</th>
                      <th className="num">Expense</th>
                      <th className="num">Profit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {byStatus.map((s) => (
                      <tr key={s.status}>
                        <td className="font-medium">{s.status}</td>
                        <td className="num">{s.branches}</td>
                        <td className="num">{formatCurrency(s.revenue)}</td>
                        <td className="num">{formatCurrency(s.expense)}</td>
                        <td className={cn('num', s.revenue - s.expense < 0 && 'text-negative')}>
                          {formatCurrency(s.revenue - s.expense)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </SectionCard>

        {/* ---------------------------------------------------------------- */}
        <SectionCard
          id="matrix"
          title="C. Stream by branch"
          subtitle={`${matrix.populated} of ${matrix.possible} combinations trade — margin for each`}
        >
          <MarginMatrix matrix={matrix} />
        </SectionCard>

        {/* ---------------------------------------------------------------- */}
        <SectionCard
          id="concentration"
          title="D. Where the profit comes from"
          subtitle="Branches ranked by contribution"
        >
          <div className="mb-4 grid gap-3 sm:grid-cols-3">
            <Stat
              label="Branches making 80 % of profit"
              value={`${concentration.countTo80} of ${concentration.totalCount}`}
            />
            <Stat label="Top five together" value={formatPercent(concentration.top5Share)} />
            <Stat
              label="Loss-making branches"
              value={
                concentration.negativeCount === 0
                  ? 'none'
                  : `${concentration.negativeCount} · ${formatCompactCurrency(concentration.negativeTotal)}`
              }
              tone={concentration.negativeCount > 0 ? 'warn' : undefined}
            />
          </div>

          {concentration.entries.length === 0 ? (
            <p className="py-10 text-center text-sm text-ink-faint">
              No branch is profitable in this selection.
            </p>
          ) : (
            <ParetoChart data={concentration.entries.slice(0, 20)} />
          )}

          <p className="mt-3 text-xs text-ink-faint">
            Bars are each branch&rsquo;s share of total profit; the line is the running cumulative
            share, so where it crosses 80 % tells you how few branches carry the business.
            {concentration.negativeCount > 0 && (
              <>
                {' '}Loss-making branches are excluded from the curve — a loss has no share of a
                positive total — and are counted above instead.
              </>
            )}
          </p>
        </SectionCard>

        {/* ---------------------------------------------------------------- */}
        <SectionCard
          id="structure"
          title="E. Cost structure"
          subtitle="Where each branch's money goes, as a share of its own spend"
        >
          <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
            <div>
              <StructureChart
                groups={structure.groups}
                data={structure.branches.slice(0, 16).map((b) => ({
                  label: b.key,
                  ...Object.fromEntries(structure.groups.map((g) => [g, b.groups[g] ?? 0])),
                }))}
                height={Math.max(300, Math.min(structure.branches.length, 16) * 30)}
              />
              <p className="mt-2 text-xs text-ink-faint">
                Normalised to 100 %, so a large branch and a small one can be compared on where the
                money goes rather than how much of it there is. Centrally-booked groups are excluded —
                spreading one company-wide figure across branches would invent a pattern.
              </p>
            </div>

            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-faint">
                Typical branch (median share)
              </h3>
              <div className="table-scroll rounded-lg border border-line">
                <table className="mis-table">
                  <thead>
                    <tr>
                      <th>Group</th>
                      <th className="num">Median</th>
                      <th className="num">Company</th>
                    </tr>
                  </thead>
                  <tbody>
                    {structure.groups
                      .map((g) => ({
                        g,
                        median: structure.median[g] ?? 0,
                        overall:
                          structure.overall.total === 0
                            ? 0
                            : (structure.overall.groups[g] ?? 0) / structure.overall.total,
                      }))
                      .sort((a, b) => b.median - a.median)
                      .map(({ g, median, overall }) => (
                        <tr key={g}>
                          <td className="!whitespace-normal font-medium">{g}</td>
                          <td className="num">{formatPercent(median, 1)}</td>
                          <td className="num text-ink-muted">{formatPercent(overall, 1)}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-xs text-ink-faint">
                The median is the middle branch, so it is not pulled by one outlier the way an
                average would be. A branch far from the median on any row is worth a look.
              </p>
            </div>
          </div>
        </SectionCard>

        {/* ---------------------------------------------------------------- */}
        <SectionCard
          id="positioning"
          title="F. Scale against margin"
          subtitle="Each branch placed against the company medians"
        >
          {positioning.points.length === 0 ? (
            <p className="py-10 text-center text-sm text-ink-faint">
              No branch has revenue in this selection.
            </p>
          ) : (
            <>
              <PositioningChart
                points={positioning.points}
                medianRevenue={positioning.medianRevenue}
                medianMargin={positioning.medianMargin}
              />

              <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Quadrant
                  title="Large and profitable"
                  hint="above median on both"
                  branches={positioning.points.filter((p) => p.quadrant === 'scale-and-margin')}
                />
                <Quadrant
                  title="Large, thin margin"
                  hint="the biggest opportunity"
                  tone="warn"
                  branches={positioning.points.filter((p) => p.quadrant === 'scale-low-margin')}
                />
                <Quadrant
                  title="Small, strong margin"
                  hint="candidates to grow"
                  branches={positioning.points.filter((p) => p.quadrant === 'small-high-margin')}
                />
                <Quadrant
                  title="Small, thin margin"
                  hint="review individually"
                  tone="warn"
                  branches={positioning.points.filter((p) => p.quadrant === 'small-low-margin')}
                />
              </div>

              <p className="mt-3 text-xs text-ink-faint">
                Split at the medians ({formatCompactCurrency(positioning.medianRevenue)} revenue,{' '}
                {formatPercent(positioning.medianMargin)} margin) rather than at zero or a target,
                because the useful question is which branches are unlike their peers. Bubble size is
                total expense.
                {positioning.excludedNoRevenue > 0 && (
                  <> {positioning.excludedNoRevenue} branches with no revenue are not plotted — they have no margin to place.</>
                )}
              </p>
            </>
          )}
        </SectionCard>
      </div>

      <p className="mt-6 text-center text-xs text-ink-faint no-print">
        Figures reconcile with the <Link href="/mis" className="text-accent hover:underline">Tabular MIS</Link>:{' '}
        revenue {formatCurrency(kpis.revenue)}, expense {formatCurrency(kpis.expense)}.
      </p>
    </>
  );
}

/** Branch counts and totals per operating status. */
async function getStatusBreakdown(companyId: string, filters: Parameters<typeof getKpis>[1]) {
  const rows = await getByDimension(companyId, filters, 'branch');
  const branches = await prisma.branch.findMany({
    where: { companyId },
    select: { abbreviation: true, status: true },
  });
  const statusOf = new Map(branches.map((b) => [b.abbreviation, b.status ?? 'Unspecified']));

  const agg = new Map<string, { revenue: number; expense: number; branches: number }>();
  for (const r of rows) {
    const status = statusOf.get(r.key) ?? 'Unspecified';
    const v = agg.get(status) ?? { revenue: 0, expense: 0, branches: 0 };
    v.revenue += r.revenue;
    v.expense += r.expense;
    v.branches += 1;
    agg.set(status, v);
  }

  return [...agg.entries()]
    .map(([status, v]) => ({ status, ...v }))
    .sort((a, b) => b.revenue - a.revenue);
}

function Movement({
  label,
  from,
  to,
  change,
  higherIsWorse,
  hint,
}: {
  label: string;
  from: number;
  to: number;
  change: number;
  higherIsWorse?: boolean;
  hint?: string;
}) {
  const good = higherIsWorse ? change < 0 : change > 0;

  return (
    <div className="rounded-lg border border-line bg-surface px-3.5 py-3">
      <div className="label">{label}</div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className={cn('text-lg font-semibold tnum', change === 0 ? '' : good ? 'text-positive' : 'text-negative')}>
          {change > 0 ? '+' : ''}
          {formatCompactCurrency(change)}
        </span>
      </div>
      <div className="mt-0.5 text-xs text-ink-faint tnum">
        {formatCompactCurrency(from)} → {formatCompactCurrency(to)}
      </div>
      {hint && <div className="mt-1 text-xs text-ink-faint">{hint}</div>}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'warn' }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-3.5 py-3">
      <div className="label">{label}</div>
      <div className={cn('mt-1 text-lg font-semibold tnum', tone === 'warn' && 'text-negative')}>{value}</div>
    </div>
  );
}

function Quadrant({
  title,
  hint,
  branches,
  tone,
}: {
  title: string;
  hint: string;
  branches: { key: string }[];
  tone?: 'warn';
}) {
  return (
    <div className={cn('rounded-lg border px-3.5 py-3', tone === 'warn' ? 'border-amber-300 bg-amber-50/50' : 'border-line bg-surface')}>
      <div className="text-xs font-semibold">{title}</div>
      <div className="text-xs text-ink-faint">{hint}</div>
      <div className="mt-2 flex flex-wrap gap-1">
        {branches.length === 0 && <span className="text-xs text-ink-faint">none</span>}
        {branches.map((b) => (
          <Link
            key={b.key}
            href={`/drill?branch=${encodeURIComponent(b.key)}`}
            className="rounded bg-canvas px-1.5 py-0.5 text-xs font-medium text-accent hover:underline"
          >
            {b.key}
          </Link>
        ))}
      </div>
    </div>
  );
}

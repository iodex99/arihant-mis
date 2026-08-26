import { requireCompany } from '@/lib/company';
import { parseFilters, describeFilters, serializeFilters } from '@/lib/mis/filters';
import {
  getByDimension,
  getBranchDetail,
  getExpenseAnalysis,
  getFilterOptions,
  getKpis,
  getComparisonMatrix,
} from '@/lib/mis/engine';
import { prisma } from '@/lib/db';
import FilterBar from '@/components/FilterBar';
import SectionCard from '@/components/SectionCard';
import EmptyState from '@/components/EmptyState';
import DataTable, { type Column } from '@/components/DataTable';
import ComparisonMatrix from './ComparisonMatrix';
import ExportButtons from '@/components/ExportButtons';
import { formatCurrency, formatPercent } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function MisPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const company = await requireCompany();
  const filters = parseFilters(await searchParams);
  const query = serializeFilters(filters);

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

  const [options, kpis, streams, branches, accounts, groups, matrix, centres] = await Promise.all([
    getFilterOptions(company.id),
    getKpis(company.id, filters),
    getByDimension(company.id, filters, 'stream'),
    getBranchDetail(company.id, filters),
    getExpenseAnalysis(company.id, filters, 'account'),
    getExpenseAnalysis(company.id, filters, 'group'),
    getComparisonMatrix(company.id, filters),
    getByDimension(company.id, filters, 'centre'),
  ]);

  const streamColumns: Column<(typeof streams)[number]>[] = [
    { key: 'label', header: 'Stream', format: 'text', linkTemplate: '/drill?stream=%s' },
    { key: 'revenue', header: 'Revenue', format: 'currency', footer: { kind: 'sum' } },
    { key: 'expense', header: 'Expense', format: 'currency', footer: { kind: 'sum' } },
    { key: 'profit', header: 'Profit', format: 'currency', signed: true, footer: { kind: 'sum' } },
    {
      key: 'margin',
      header: 'Profit margin',
      format: 'percent',
      signed: true,
      footer: { kind: 'ratio', numerator: 'profit', denominator: 'revenue' },
    },
    {
      key: 'expenseRatio',
      header: 'Expense ratio',
      format: 'ratio',
      optional: true,
      note: 'Expense divided by revenue.',
      footer: { kind: 'ratio', numerator: 'expense', denominator: 'revenue' },
    },
  ];

  const branchColumns: Column<(typeof branches)[number]>[] = [
    { key: 'key', header: 'Branch', format: 'text', linkTemplate: '/drill?branch=%s' },
    { key: 'name', header: 'Branch name', format: 'text', optional: true },
    { key: 'centre', header: 'Centre', format: 'text', optional: true },
    { key: 'status', header: 'Status', format: 'text', optional: true },
    { key: 'revenue', header: 'Revenue', format: 'currency', footer: { kind: 'sum' } },
    { key: 'expense', header: 'Expense', format: 'currency', footer: { kind: 'sum' } },
    { key: 'profit', header: 'Profit', format: 'currency', signed: true, footer: { kind: 'sum' } },
    {
      key: 'expenseRatio',
      header: 'Expense ratio',
      format: 'ratio',
      note: 'Expense divided by revenue. The previous report labelled its profit-margin column this way; this is the genuine expense ratio.',
      footer: { kind: 'ratio', numerator: 'expense', denominator: 'revenue' },
    },
    {
      key: 'margin',
      header: 'Profit margin',
      format: 'percent',
      signed: true,
      footer: { kind: 'ratio', numerator: 'profit', denominator: 'revenue' },
    },
    {
      key: 'shareOfExpense',
      header: '% of total expense',
      format: 'percent',
      optional: true,
      footer: { kind: 'constant', value: 1 },
    },
  ];

  const centreColumns: Column<(typeof centres)[number]>[] = [
    { key: 'label', header: 'Centre', format: 'text', linkTemplate: '/drill?centre=%s' },
    { key: 'revenue', header: 'Revenue', format: 'currency', footer: { kind: 'sum' } },
    { key: 'expense', header: 'Expense', format: 'currency', footer: { kind: 'sum' } },
    { key: 'profit', header: 'Profit', format: 'currency', signed: true, footer: { kind: 'sum' } },
    {
      key: 'margin',
      header: 'Profit margin',
      format: 'percent',
      signed: true,
      footer: { kind: 'ratio', numerator: 'profit', denominator: 'revenue' },
    },
    {
      key: 'shareOfExpense',
      header: '% of total expense',
      format: 'percent',
      footer: { kind: 'constant', value: 1 },
    },
  ];

  const accountColumns: Column<(typeof accounts)[number]>[] = [
    { key: 'label', header: 'Expense head', format: 'text', linkTemplate: '/drill?account=%s' },
    { key: 'amount', header: 'Amount', format: 'currency', signed: true, footer: { kind: 'sum' } },
    {
      key: 'pctOfRevenue',
      header: '% of revenue',
      format: 'percent',
      note: 'Divided by the revenue of the current selection.',
      footer: { kind: 'ratio', numerator: 'amount', denominatorValue: kpis.revenue },
    },
    { key: 'shareOfExpense', header: '% of total expense', format: 'percent', footer: { kind: 'constant', value: 1 } },
  ];

  const groupColumns: Column<(typeof groups)[number]>[] = [
    { key: 'label', header: 'Group', format: 'text', linkTemplate: '/drill?group=%s' },
    { key: 'amount', header: 'Amount', format: 'currency', signed: true, footer: { kind: 'sum' } },
    {
      key: 'pctOfRevenue',
      header: '% of revenue',
      format: 'percent',
      footer: { kind: 'ratio', numerator: 'amount', denominatorValue: kpis.revenue },
    },
    { key: 'shareOfExpense', header: '% of total expense', format: 'percent', footer: { kind: 'constant', value: 1 } },
  ];

  return (
    <>
      <header className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Tabular MIS</h1>
          <p className="mt-0.5 text-sm text-ink-muted">{describeFilters(filters)}</p>
        </div>
        <ExportButtons query={query} />
      </header>

      <FilterBar options={options} />

      <div className="mb-6 grid grid-cols-kpi gap-4">
        <Summary label="Revenue" value={formatCurrency(kpis.revenue)} />
        <Summary label="Expense" value={formatCurrency(kpis.expense)} />
        <Summary label="Profit" value={formatCurrency(kpis.profit)} negative={kpis.profit < 0} />
        <Summary label="Profit margin" value={formatPercent(kpis.margin)} negative={(kpis.margin ?? 0) < 0} />
      </div>

      <div className="space-y-4">
        <SectionCard id="stream" title="A. Stream profitability" subtitle="Revenue, expense and profit by academic stream">
          <DataTable
            columns={streamColumns}
            rows={streams}
            initialSort={{ key: 'profit', direction: 'desc' }}
            showFooter
            searchKeys={['label']}
            caption="Stream profitability"
          />
        </SectionCard>

        <SectionCard
          id="branch"
          title="B. Branch profitability"
          subtitle="Grouped by branch code, which is the reporting key"
        >
          <DataTable
            columns={branchColumns}
            rows={branches}
            initialSort={{ key: 'margin', direction: 'desc' }}
            showFooter
            searchKeys={['key', 'name', 'centre']}
            pageSize={30}
            caption="Branch profitability"
          />
          <p className="mt-3 text-xs text-ink-faint">
            Branches with no revenue show “—” for margin rather than 0 %, because a margin needs
            revenue to divide by.
          </p>
        </SectionCard>

        <SectionCard id="expense" title="C. Expense analysis" subtitle="By individual expense head">
          <DataTable
            columns={accountColumns}
            rows={accounts}
            initialSort={{ key: 'amount', direction: 'desc' }}
            showFooter
            searchKeys={['label']}
            pageSize={30}
            caption="Expense analysis by head"
          />
        </SectionCard>

        <SectionCard id="group" title="D. Group analysis" subtitle="Expense heads rolled up to group heads">
          <DataTable
            columns={groupColumns}
            rows={groups}
            initialSort={{ key: 'amount', direction: 'desc' }}
            showFooter
            searchKeys={['label']}
            caption="Expense analysis by group"
          />
          <p className="mt-3 text-xs text-ink-faint">
            <strong>% of revenue</strong> divides by the revenue of the current selection. The
            previous Looker Studio report divided by a revenue figure repeated once per
            expense-head row, which made these percentages read lower — its grand total showed
            1.23 % where expense was actually about 59 % of revenue. The amounts are identical in
            both systems.
          </p>
        </SectionCard>

        <SectionCard id="centre" title="E. Centre profitability" subtitle="Revenue, expense and profit by geographic centre">
          <DataTable
            columns={centreColumns}
            rows={centres}
            initialSort={{ key: 'revenue', direction: 'desc' }}
            showFooter
            searchKeys={['label']}
            caption="Centre profitability"
          />
        </SectionCard>

        <SectionCard
          id="comparison"
          title="F. Comparison analysis"
          subtitle="Each expense group as a share of that branch’s own revenue"
        >
          <ComparisonMatrix matrix={matrix} />
        </SectionCard>
      </div>
    </>
  );
}

function Summary({ label, value, negative }: { label: string; value: string; negative?: boolean }) {
  return (
    <div className="card card-pad">
      <div className="label">{label}</div>
      <div className={`mt-1.5 text-lg font-semibold tnum ${negative ? 'text-negative' : ''}`}>{value}</div>
    </div>
  );
}

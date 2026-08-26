'use client';

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { CATEGORICAL, CHROME, DIVERGING, OTHER_COLOR, foldToTopN } from './palette';
import { formatCompactCurrency, formatCurrency, formatPercent } from '@/lib/format';

const AXIS = { stroke: CHROME.axis, fontSize: 11 };
const GRID = { stroke: CHROME.grid, strokeDasharray: '3 3' };

/** Compact axis ticks; the tooltip carries full precision. */
const compactTick = (v: number) => formatCompactCurrency(v).replace('₹', '');

interface TooltipRow {
  name?: string;
  value?: number;
  color?: string;
  dataKey?: string | number;
}

function ChartTooltip({
  active,
  payload,
  label,
  showTotal,
}: {
  active?: boolean;
  payload?: TooltipRow[];
  label?: string | number;
  showTotal?: boolean;
}) {
  if (!active || !payload?.length) return null;

  const total = payload.reduce((s, p) => s + (p.value ?? 0), 0);

  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2 shadow-pop">
      {label !== undefined && <div className="mb-1 text-xs font-semibold">{label}</div>}
      <table className="text-xs">
        <tbody>
          {payload.map((p, i) => (
            <tr key={i}>
              <td className="pr-2">
                <span
                  aria-hidden
                  className="mr-1.5 inline-block h-2 w-2 rounded-sm align-middle"
                  style={{ background: p.color }}
                />
                <span className="text-ink-muted">{p.name}</span>
              </td>
              <td className="tnum text-right font-medium">{formatCurrency(p.value ?? 0)}</td>
            </tr>
          ))}
          {showTotal && payload.length > 1 && (
            <tr className="border-t border-line">
              <td className="pr-2 pt-1 text-ink-muted">Total</td>
              <td className="tnum pt-1 text-right font-semibold">{formatCurrency(total)}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

const LEGEND_STYLE = { fontSize: 11, color: CHROME.text, paddingTop: 8 };

// ---------------------------------------------------------------------------

export interface TrendDatum {
  periodLabel: string;
  revenue: number;
  expense: number;
  profit: number;
}

/**
 * Revenue, expense and profit over time.
 *
 * All three are rupees on one axis — never a second scale (the dual-axis
 * anti-pattern makes two unrelated slopes look comparable).
 */
export function TrendChart({ data }: { data: TrendDatum[] }) {
  return (
    <ResponsiveContainer width="100%" height={280}>
      <LineChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 8 }}>
        <CartesianGrid {...GRID} vertical={false} />
        <XAxis dataKey="periodLabel" {...AXIS} tickLine={false} axisLine={{ stroke: CHROME.grid }} />
        <YAxis {...AXIS} tickFormatter={compactTick} tickLine={false} axisLine={false} width={64} />
        <ReferenceLine y={0} stroke={CHROME.axis} strokeWidth={1} />
        <Tooltip content={<ChartTooltip />} cursor={{ stroke: CHROME.axis, strokeWidth: 1 }} />
        <Legend wrapperStyle={LEGEND_STYLE} iconType="plainline" />
        <Line isAnimationActive={false} type="monotone" dataKey="revenue" name="Revenue" stroke={CATEGORICAL[0]} strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 5 }} />
        <Line isAnimationActive={false} type="monotone" dataKey="expense" name="Expense" stroke={CATEGORICAL[1]} strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 5 }} />
        <Line isAnimationActive={false} type="monotone" dataKey="profit" name="Profit" stroke={CATEGORICAL[2]} strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 5 }} />
      </LineChart>
    </ResponsiveContainer>
  );
}

/** Revenue against expense, side by side. */
export function RevenueExpenseChart({ data }: { data: { label: string; revenue: number; expense: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height={280}>
      <BarChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 8 }} barGap={2}>
        <CartesianGrid {...GRID} vertical={false} />
        <XAxis dataKey="label" {...AXIS} tickLine={false} axisLine={{ stroke: CHROME.grid }} />
        <YAxis {...AXIS} tickFormatter={compactTick} tickLine={false} axisLine={false} width={64} />
        <ReferenceLine y={0} stroke={CHROME.axis} strokeWidth={1} />
        <Tooltip content={<ChartTooltip />} cursor={{ fill: 'rgba(67,56,202,0.04)' }} />
        <Legend wrapperStyle={LEGEND_STYLE} iconType="square" />
        <Bar isAnimationActive={false} dataKey="revenue" name="Revenue" fill={CATEGORICAL[0]} radius={[4, 4, 0, 0]} maxBarSize={44} />
        <Bar isAnimationActive={false} dataKey="expense" name="Expense" fill={CATEGORICAL[1]} radius={[4, 4, 0, 0]} maxBarSize={44} />
      </BarChart>
    </ResponsiveContainer>
  );
}

/**
 * A single signed measure per category — profit by branch or by stream.
 * Sign is polarity, so it takes the diverging pair, not a categorical hue.
 */
export function SignedBarChart({
  data,
  height = 320,
  layout = 'vertical',
}: {
  data: { label: string; value: number }[];
  height?: number;
  layout?: 'vertical' | 'horizontal';
}) {
  const isVertical = layout === 'vertical';

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart
        data={data}
        layout={isVertical ? 'vertical' : 'horizontal'}
        margin={{ top: 8, right: 24, bottom: 4, left: isVertical ? 8 : 8 }}
      >
        <CartesianGrid {...GRID} horizontal={!isVertical} vertical={isVertical} />
        {isVertical ? (
          <>
            <XAxis type="number" {...AXIS} tickFormatter={compactTick} tickLine={false} axisLine={false} />
            <YAxis type="category" dataKey="label" {...AXIS} width={92} tickLine={false} axisLine={false} />
          </>
        ) : (
          <>
            <XAxis dataKey="label" {...AXIS} tickLine={false} axisLine={{ stroke: CHROME.grid }} />
            <YAxis {...AXIS} tickFormatter={compactTick} tickLine={false} axisLine={false} width={64} />
          </>
        )}
        <ReferenceLine {...(isVertical ? { x: 0 } : { y: 0 })} stroke={CHROME.axis} strokeWidth={1} />
        <Tooltip content={<ChartTooltip />} cursor={{ fill: 'rgba(67,56,202,0.04)' }} />
        <Bar isAnimationActive={false} dataKey="value" name="Profit" radius={4} maxBarSize={28}>
          {data.map((d, i) => (
            <Cell key={i} fill={d.value < 0 ? DIVERGING.negative : DIVERGING.positive} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/**
 * Expense composition.
 *
 * Capped at eight slices with the remainder folded into a neutral "Other" —
 * a ninth generated hue would break the fixed-order rule and be unreadable.
 * Negative categories (provision reversals) cannot be drawn as a share of a
 * whole, so they are reported beneath the chart instead of being dropped.
 */
export function CompositionChart({
  data,
}: {
  data: { label: string; value: number }[];
}) {
  const positive = data.filter((d) => d.value > 0);
  const negative = data.filter((d) => d.value < 0);
  const folded = foldToTopN(positive, 8, (label, value) => ({ label, value }));
  const total = folded.items.reduce((s, d) => s + d.value, 0);

  return (
    <div>
      <ResponsiveContainer width="100%" height={260}>
        <PieChart>
          <Pie
            isAnimationActive={false}
            data={folded.items}
            dataKey="value"
            nameKey="label"
            innerRadius={62}
            outerRadius={100}
            paddingAngle={1}
            stroke={CHROME.surface}
            strokeWidth={2}
          >
            {folded.items.map((d, i) => (
              <Cell key={i} fill={d.__other ? OTHER_COLOR : CATEGORICAL[i % CATEGORICAL.length]} />
            ))}
          </Pie>
          <Tooltip content={<ChartTooltip />} />
          <Legend wrapperStyle={LEGEND_STYLE} iconType="square" />
        </PieChart>
      </ResponsiveContainer>

      <ul className="mt-2 space-y-1 text-xs">
        {folded.items.map((d, i) => (
          <li key={i} className="flex items-center gap-2">
            <span
              aria-hidden
              className="h-2 w-2 shrink-0 rounded-sm"
              style={{ background: d.__other ? OTHER_COLOR : CATEGORICAL[i % CATEGORICAL.length] }}
            />
            <span className="truncate text-ink-muted">{d.label}</span>
            <span className="ml-auto tnum shrink-0 font-medium">{formatCurrency(d.value)}</span>
            <span className="tnum w-12 shrink-0 text-right text-ink-faint">
              {formatPercent(total === 0 ? null : d.value / total, 1)}
            </span>
          </li>
        ))}
      </ul>

      {negative.length > 0 && (
        <p className="mt-3 border-t border-line pt-2 text-xs text-ink-faint">
          {negative.length} categor{negative.length === 1 ? 'y is' : 'ies are'} net negative
          ({negative.map((n) => n.label).join(', ')}, {formatCurrency(negative.reduce((s, n) => s + n.value, 0))})
          and cannot be shown as a share of the whole. They are included in every total.
        </p>
      )}
    </div>
  );
}

/** Expense by group over time, stacked. */
export function ExpenseTrendChart({
  series,
  groups,
}: {
  series: Record<string, number | string>[];
  groups: string[];
}) {
  const shown = groups.slice(0, 8);
  const hidden = groups.slice(8);

  // Fold overflow groups into one neutral band rather than inventing hues.
  const data = series.map((row) => {
    const out: Record<string, number | string> = { period: row.period };
    for (const g of shown) out[g] = Number(row[g] ?? 0);
    if (hidden.length > 0) {
      out.Other = hidden.reduce((s, g) => s + Number(row[g] ?? 0), 0);
    }
    return out;
  });

  const keys = hidden.length > 0 ? [...shown, 'Other'] : shown;

  return (
    <ResponsiveContainer width="100%" height={300}>
      <AreaChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 8 }}>
        <CartesianGrid {...GRID} vertical={false} />
        <XAxis dataKey="period" {...AXIS} tickLine={false} axisLine={{ stroke: CHROME.grid }} />
        <YAxis {...AXIS} tickFormatter={compactTick} tickLine={false} axisLine={false} width={64} />
        <ReferenceLine y={0} stroke={CHROME.axis} strokeWidth={1} />
        <Tooltip content={<ChartTooltip showTotal />} cursor={{ stroke: CHROME.axis, strokeWidth: 1 }} />
        <Legend wrapperStyle={LEGEND_STYLE} iconType="square" />
        {keys.map((g, i) => (
          <Area
            isAnimationActive={false}
            key={g}
            type="monotone"
            dataKey={g}
            name={g}
            stackId="expense"
            stroke={CHROME.surface}
            strokeWidth={2}
            fill={g === 'Other' ? OTHER_COLOR : CATEGORICAL[i % CATEGORICAL.length]}
            fillOpacity={1}
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}

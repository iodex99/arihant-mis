'use client';

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from 'recharts';
import { CATEGORICAL, CHROME, DIVERGING, OTHER_COLOR } from './palette';
import { formatCompactCurrency, formatCurrency, formatPercent } from '@/lib/format';

const AXIS = { stroke: CHROME.axis, fontSize: 11 };
const GRID = { stroke: CHROME.grid, strokeDasharray: '3 3' };
const LEGEND_STYLE = { fontSize: 11, color: CHROME.text, paddingTop: 8 };

const compactTick = (v: number) => formatCompactCurrency(v).replace('₹', '');
const percentTick = (v: number) => `${Math.round(v * 100)}%`;

function Panel({ children }: { children: React.ReactNode }) {
  return <div className="rounded-lg border border-line bg-surface px-3 py-2 shadow-pop">{children}</div>;
}

// ---------------------------------------------------------------------------
// Variance
// ---------------------------------------------------------------------------

export interface VarianceDatum {
  label: string;
  change: number;
  unallocated?: boolean;
}

/**
 * Period-over-period movement.
 *
 * `higherIsWorse` flips the colour mapping for expense, where an increase is
 * the bad direction. Sign alone would otherwise paint a cost overrun in the
 * same colour as a profit gain.
 */
export function VarianceChart({
  data,
  higherIsWorse = false,
  height = 320,
}: {
  data: VarianceDatum[];
  higherIsWorse?: boolean;
  height?: number;
}) {
  const colourFor = (d: VarianceDatum) => {
    if (d.unallocated) return OTHER_COLOR;
    const good = higherIsWorse ? d.change < 0 : d.change > 0;
    return good ? DIVERGING.positive : DIVERGING.negative;
  };

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} layout="vertical" margin={{ top: 8, right: 32, bottom: 4, left: 8 }}>
        <CartesianGrid {...GRID} horizontal={false} />
        <XAxis type="number" {...AXIS} tickFormatter={compactTick} tickLine={false} axisLine={false} />
        <YAxis type="category" dataKey="label" {...AXIS} width={168} tickLine={false} axisLine={false} interval={0} />
        <ReferenceLine x={0} stroke={CHROME.axis} strokeWidth={1} />
        <Tooltip
          cursor={{ fill: 'rgba(67,56,202,0.04)' }}
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const d = payload[0].payload as VarianceDatum;
            return (
              <Panel>
                <div className="text-xs font-semibold">{d.label}</div>
                <div className="tnum mt-0.5 text-xs">{formatCurrency(d.change)}</div>
                {d.unallocated && (
                  <div className="mt-1 max-w-[220px] text-xs text-ink-faint">
                    Booked centrally, not by branch
                  </div>
                )}
              </Panel>
            );
          }}
        />
        <Bar isAnimationActive={false} dataKey="change" name="Change" radius={4} maxBarSize={22}>
          {data.map((d, i) => (
            <Cell key={i} fill={colourFor(d)} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

// ---------------------------------------------------------------------------
// Concentration (Pareto)
// ---------------------------------------------------------------------------

export interface ParetoDatum {
  key: string;
  share: number;
  cumulativeShare: number;
  value: number;
}

/**
 * Pareto: individual share as bars, cumulative share as a line.
 *
 * Both series are percentages of the same total, so they share one axis. A
 * conventional Pareto puts amount on the left and cumulative percent on the
 * right, which is a dual-axis chart — two scales invite comparing slopes that
 * are not comparable. Expressing the bars as share instead keeps one scale.
 */
export function ParetoChart({ data, height = 320 }: { data: ParetoDatum[]; height?: number }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 8 }}>
        <CartesianGrid {...GRID} vertical={false} />
        <XAxis dataKey="key" {...AXIS} tickLine={false} axisLine={{ stroke: CHROME.grid }} interval={0} angle={-45} textAnchor="end" height={56} />
        <YAxis {...AXIS} tickFormatter={percentTick} tickLine={false} axisLine={false} width={48} domain={[0, 1]} />
        <ReferenceLine y={0.8} stroke={CHROME.axis} strokeDasharray="4 4" label={{ value: '80% of profit', position: 'insideTopRight', fontSize: 10, fill: CHROME.text }} />
        <Tooltip
          cursor={{ fill: 'rgba(67,56,202,0.04)' }}
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const d = payload[0].payload as ParetoDatum;
            return (
              <Panel>
                <div className="text-xs font-semibold">{d.key}</div>
                <div className="tnum mt-0.5 text-xs">{formatCurrency(d.value)}</div>
                <div className="tnum text-xs text-ink-muted">
                  {formatPercent(d.share, 1)} of total · {formatPercent(d.cumulativeShare, 1)} cumulative
                </div>
              </Panel>
            );
          }}
        />
        <Legend wrapperStyle={LEGEND_STYLE} />
        <Bar isAnimationActive={false} dataKey="share" name="Share of total" fill={CATEGORICAL[0]} radius={[4, 4, 0, 0]} maxBarSize={34} />
        <Line
          isAnimationActive={false}
          type="monotone"
          dataKey="cumulativeShare"
          name="Cumulative"
          stroke={CATEGORICAL[1]}
          strokeWidth={2}
          dot={{ r: 2.5 }}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

// ---------------------------------------------------------------------------
// Cost structure, normalised
// ---------------------------------------------------------------------------

export interface StructureDatum {
  label: string;
  [group: string]: string | number;
}

/**
 * Cost composition per branch, normalised to 100 %.
 *
 * Absolute cost makes big branches look different from small ones for reasons
 * that are not interesting. Normalising asks the useful question: is this
 * branch's money going to the same places as everyone else's?
 */
export function StructureChart({
  data,
  groups,
  height = 420,
}: {
  data: StructureDatum[];
  groups: string[];
  height?: number;
}) {
  const shown = groups.slice(0, 8);

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} layout="vertical" margin={{ top: 8, right: 16, bottom: 4, left: 8 }} stackOffset="expand">
        <CartesianGrid {...GRID} horizontal={false} />
        <XAxis type="number" {...AXIS} tickFormatter={percentTick} tickLine={false} axisLine={false} domain={[0, 1]} />
        <YAxis type="category" dataKey="label" {...AXIS} width={80} tickLine={false} axisLine={false} />
        <Tooltip
          cursor={{ fill: 'rgba(67,56,202,0.04)' }}
          content={({ active, payload, label }) => {
            if (!active || !payload?.length) return null;
            const total = payload.reduce((s, p) => s + Number(p.value ?? 0), 0);
            return (
              <Panel>
                <div className="mb-1 text-xs font-semibold">{label}</div>
                <table className="text-xs">
                  <tbody>
                    {payload.map((p, i) => (
                      <tr key={i}>
                        <td className="pr-2">
                          <span aria-hidden className="mr-1.5 inline-block h-2 w-2 rounded-sm align-middle" style={{ background: p.color }} />
                          <span className="text-ink-muted">{p.name}</span>
                        </td>
                        <td className="tnum text-right font-medium">
                          {formatPercent(total === 0 ? null : Number(p.value ?? 0) / total, 1)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Panel>
            );
          }}
        />
        <Legend wrapperStyle={LEGEND_STYLE} iconType="square" />
        {shown.map((g, i) => (
          <Bar
            key={g}
            isAnimationActive={false}
            dataKey={g}
            name={g}
            stackId="cost"
            fill={CATEGORICAL[i % CATEGORICAL.length]}
            stroke={CHROME.surface}
            strokeWidth={1}
            maxBarSize={26}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

// ---------------------------------------------------------------------------
// Scale vs margin
// ---------------------------------------------------------------------------

export interface PositionDatum {
  key: string;
  revenue: number;
  margin: number;
  expense: number;
}

/**
 * Branch position: revenue against margin, split at the company medians.
 *
 * A single series, so no categorical palette is needed — points are coloured by
 * whether they sit above or below the median margin, which is polarity.
 */
export function PositioningChart({
  points,
  medianRevenue,
  medianMargin,
  height = 400,
}: {
  points: PositionDatum[];
  medianRevenue: number;
  medianMargin: number;
  height?: number;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ScatterChart margin={{ top: 16, right: 24, bottom: 32, left: 8 }}>
        <CartesianGrid {...GRID} />
        <XAxis
          type="number"
          dataKey="revenue"
          name="Revenue"
          {...AXIS}
          tickFormatter={compactTick}
          tickLine={false}
          axisLine={{ stroke: CHROME.grid }}
          label={{ value: 'Revenue', position: 'insideBottom', offset: -18, fontSize: 11, fill: CHROME.text }}
        />
        <YAxis
          type="number"
          dataKey="margin"
          name="Margin"
          {...AXIS}
          tickFormatter={percentTick}
          tickLine={false}
          axisLine={false}
          width={52}
          label={{ value: 'Profit margin', angle: -90, position: 'insideLeft', fontSize: 11, fill: CHROME.text }}
        />
        <ZAxis type="number" dataKey="expense" range={[60, 400]} name="Expense" />
        <ReferenceLine x={medianRevenue} stroke={CHROME.axis} strokeDasharray="4 4"
          label={{ value: 'median revenue', position: 'insideTopLeft', fontSize: 9, fill: CHROME.text }} />
        <ReferenceLine y={medianMargin} stroke={CHROME.axis} strokeDasharray="4 4"
          label={{ value: 'median margin', position: 'insideBottomRight', fontSize: 9, fill: CHROME.text }} />
        <ReferenceLine y={0} stroke={DIVERGING.negative} strokeWidth={1} />
        <Tooltip
          cursor={{ strokeDasharray: '3 3' }}
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const d = payload[0].payload as PositionDatum;
            return (
              <Panel>
                <div className="text-xs font-semibold">{d.key}</div>
                <div className="tnum mt-0.5 text-xs">Revenue {formatCurrency(d.revenue)}</div>
                <div className="tnum text-xs">Expense {formatCurrency(d.expense)}</div>
                <div className="tnum text-xs text-ink-muted">Margin {formatPercent(d.margin)}</div>
              </Panel>
            );
          }}
        />
        <Scatter isAnimationActive={false} data={points} name="Branch">
          {points.map((p, i) => (
            <Cell key={i} fill={p.margin >= medianMargin ? DIVERGING.positive : DIVERGING.negative} fillOpacity={0.75} />
          ))}
        </Scatter>
      </ScatterChart>
    </ResponsiveContainer>
  );
}

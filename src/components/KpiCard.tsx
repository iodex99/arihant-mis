import { cn } from '@/lib/cn';
import { formatCompactCurrency, formatCurrency, formatPercent } from '@/lib/format';

interface Props {
  label: string;
  value: number | null;
  kind?: 'currency' | 'percent';
  /** Rendered small beneath the value. */
  detail?: string;
  /** Colour the value by sign — only for figures where a loss is meaningful. */
  signed?: boolean;
  emphasis?: boolean;
}

export default function KpiCard({ label, value, kind = 'currency', detail, signed, emphasis }: Props) {
  const display =
    value === null
      ? '—'
      : kind === 'percent'
        ? formatPercent(value)
        : formatCompactCurrency(value);

  const exact = value !== null && kind === 'currency' ? formatCurrency(value) : undefined;

  return (
    <div className={cn('card card-pad', emphasis && 'ring-1 ring-accent/20')}>
      <div className="label">{label}</div>
      <div
        className={cn(
          'mt-2 text-kpi font-semibold tnum',
          signed && value !== null && value < 0 && 'text-negative',
          signed && value !== null && value > 0 && 'text-positive',
        )}
        title={exact}
      >
        {display}
      </div>
      {detail && <div className="mt-1 text-xs text-ink-faint">{detail}</div>}
      {exact && <div className="mt-1 text-xs text-ink-faint tnum">{exact}</div>}
    </div>
  );
}

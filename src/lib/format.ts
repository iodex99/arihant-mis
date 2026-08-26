/**
 * Presentation formatting.
 *
 * Amounts are stored as exact decimals and formatted only here — no currency
 * symbol or scaling ever reaches the database (build spec §42).
 */

const INR = 'en-IN';

/** Full precision with Indian digit grouping: `₹81,57,62,00.57`-style lakh/crore groups. */
export function formatCurrency(value: number | null | undefined, currency = 'INR'): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  const body = abs.toLocaleString(INR, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const symbol = currency === 'INR' ? '₹' : `${currency} `;
  // Accounting convention: negatives in parentheses, which reads faster than a
  // minus sign in a dense table.
  return value < 0 ? `(${symbol}${body})` : `${symbol}${body}`;
}

/** Compact Indian scale for KPI cards: `₹8.16 Cr`, `₹14.84 L`, `₹45.20 K`. */
export function formatCompactCurrency(value: number | null | undefined, currency = 'INR'): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';

  const symbol = currency === 'INR' ? '₹' : `${currency} `;
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';

  const CRORE = 1e7;
  const LAKH = 1e5;
  const THOUSAND = 1e3;

  if (abs >= CRORE) return `${sign}${symbol}${(abs / CRORE).toFixed(2)} Cr`;
  if (abs >= LAKH) return `${sign}${symbol}${(abs / LAKH).toFixed(2)} L`;
  if (abs >= THOUSAND) return `${sign}${symbol}${(abs / THOUSAND).toFixed(2)} K`;
  return `${sign}${symbol}${abs.toFixed(2)}`;
}

/** Plain number with Indian grouping, no currency symbol. */
export function formatNumber(value: number | null | undefined, decimals = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toLocaleString(INR, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/**
 * Percentage from a ratio. `null` renders as an em dash rather than 0 % —
 * a branch with no revenue has no margin, which is not the same as a 0 %
 * margin (docs/mis-specification.md §3).
 */
export function formatPercent(ratio: number | null | undefined, decimals = 2): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return '—';
  return `${(ratio * 100).toFixed(decimals)}%`;
}

/** Ratio to 2dp, e.g. the branch report's `Expense Ratio` column. */
export function formatRatio(ratio: number | null | undefined): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return '—';
  return ratio.toFixed(2);
}

export function formatDateTime(value: Date | string | null | undefined): string {
  if (!value) return '—';
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(INR, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatDate(value: Date | string | null | undefined): string {
  if (!value) return '—';
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(INR, { day: '2-digit', month: 'short', year: 'numeric' });
}

/** "3 minutes ago" / "2 days ago", for staleness indicators. */
export function formatRelative(value: Date | string | null | undefined, now = new Date()): string {
  if (!value) return 'never';
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return 'never';

  const seconds = Math.round((now.getTime() - d.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  return formatDate(d);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

/** Class name for a signed figure, so losses read as losses. */
export function signClass(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'text-slate-400';
  if (value < 0) return 'text-rose-600';
  if (value > 0) return 'text-emerald-700';
  return 'text-slate-500';
}

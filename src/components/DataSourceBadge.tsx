import { formatRelative } from '@/lib/format';

interface Props {
  latestImport: { filename: string; finishedAt: Date | null; status: string } | null;
  latestSync: { finishedAt: Date | null; recordsProcessed: number } | null;
}

/**
 * States plainly where the figures on screen came from and how old they are.
 * Stale data is never presented as live (build spec §26, §27).
 */
export default function DataSourceBadge({ latestImport, latestSync }: Props) {
  const importAt = latestImport?.finishedAt ?? null;
  const syncAt = latestSync?.finishedAt ?? null;

  if (!importAt && !syncAt) {
    return (
      <span className="badge bg-canvas text-ink-faint" title="No data has been loaded yet">
        No data
      </span>
    );
  }

  const fromTally = syncAt && (!importAt || syncAt > importAt);
  const at = fromTally ? syncAt : importAt;
  const ageHours = at ? (Date.now() - at.getTime()) / 3_600_000 : Infinity;
  const stale = ageHours > 36;

  return (
    <span
      className={
        stale
          ? 'badge bg-amber-50 text-amber-800'
          : 'badge bg-emerald-50 text-emerald-800'
      }
      title={
        fromTally
          ? `Synced from Tally · ${latestSync?.recordsProcessed.toLocaleString('en-IN')} records`
          : `Uploaded file: ${latestImport?.filename}`
      }
    >
      <span aria-hidden className={stale ? 'text-amber-500' : 'text-emerald-500'}>●</span>
      <span className="hidden sm:inline">{fromTally ? 'Tally' : 'Uploaded file'} ·</span>
      {formatRelative(at)}
    </span>
  );
}

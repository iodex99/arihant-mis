'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { cn } from '@/lib/cn';
import { formatCurrency, formatDateTime } from '@/lib/format';

interface Impact {
  importId: string;
  filename: string;
  uploadedAt: string;
  uploadedBy: string | null;
  status: string;
  rowCount: number;
  factCount: number;
  totals: { revenue: number; expense: number; profit: number } | null;
  periods: { label: string; factCount: number }[];
  periodsLeftEmpty: string[];
  leavesNoData: boolean;
  orphanedAccounts: number;
  orphanedBranches: number;
}

/**
 * Deleting an import is irreversible from inside the application, so the dialog
 * loads the real impact from the server and leads with the consequence rather
 * than asking "are you sure?" about an unspecified amount of data.
 */
export default function DeleteImportButton({
  importId,
  variant = 'icon',
  /** Where to go afterwards. Stay put on the list; leave the detail page. */
  redirectTo,
}: {
  importId: string;
  variant?: 'icon' | 'button';
  redirectTo?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [impact, setImpact] = useState<Impact | null>(null);
  const [loading, setLoading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  // Escape closes the dialog, but not mid-delete — the request is already away.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !deleting) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, deleting]);

  async function openDialog() {
    setOpen(true);
    setConfirm('');
    setError(null);
    setImpact(null);
    setLoading(true);

    try {
      const res = await fetch(`/api/imports/${importId}`);
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? 'Could not work out what this deletion would affect.');
        return;
      }
      setImpact(body);
    } catch {
      setError('Could not reach the server, so the effect of this deletion is unknown. Nothing was changed.');
    } finally {
      setLoading(false);
    }
  }

  async function performDelete() {
    setDeleting(true);
    setError(null);

    try {
      const res = await fetch(`/api/imports/${importId}`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: 'DELETE' }),
      });
      const body = await res.json();

      if (!res.ok) {
        setError(body.remedy ? `${body.error} ${body.remedy}` : body.error);
        return;
      }

      setOpen(false);
      if (redirectTo) router.push(redirectTo);
      router.refresh();
    } catch {
      setError('The delete request did not complete. Reload the page to see whether it took effect.');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      {variant === 'icon' ? (
        <button
          type="button"
          onClick={openDialog}
          className="rounded px-2 py-1 text-xs text-ink-faint transition-colors hover:bg-negative/10 hover:text-negative"
          aria-label="Delete this import"
          title="Delete this import"
        >
          Delete
        </button>
      ) : (
        <button type="button" onClick={openDialog} className="btn-secondary text-xs text-negative">
          Delete import
        </button>
      )}

      {open && mounted && createPortal(
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4 text-left"
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-import-title"
        >
          <div className="max-h-[85vh] w-full max-w-lg overflow-y-auto whitespace-normal rounded-xl border border-line bg-surface shadow-pop">
            <header className="border-b border-line px-5 py-4">
              <h2 id="delete-import-title" className="font-semibold">Delete this import?</h2>
              <p className="mt-0.5 text-xs text-ink-faint">
                This cannot be undone from here. Recovery means restoring a database backup.
              </p>
            </header>

            <div className="space-y-4 px-5 py-4 text-sm">
              {loading && <p className="text-ink-muted">Working out what this would affect…</p>}

              {impact && (
                <>
                  <dl className="space-y-1.5">
                    <Row label="File" value={impact.filename} />
                    <Row label="Imported" value={formatDateTime(impact.uploadedAt)} />
                    {impact.uploadedBy && <Row label="By" value={impact.uploadedBy} />}
                    <Row label="Source rows" value={impact.rowCount.toLocaleString('en-IN')} />
                    <Row label="Entries to remove" value={impact.factCount.toLocaleString('en-IN')} />
                  </dl>

                  {impact.totals && (
                    <dl className="space-y-1.5 rounded-lg bg-canvas px-3 py-2.5">
                      <Row label="Revenue removed" value={formatCurrency(impact.totals.revenue)} />
                      <Row label="Expense removed" value={formatCurrency(impact.totals.expense)} />
                      <Row label="Profit removed" value={formatCurrency(impact.totals.profit)} />
                    </dl>
                  )}

                  {impact.periodsLeftEmpty.length > 0 ? (
                    <div className="rounded-lg border border-negative/30 bg-negative/5 px-3 py-2.5">
                      <p className="font-medium text-negative">
                        {impact.leavesNoData
                          ? 'The MIS will be left with no data at all.'
                          : `${impact.periodsLeftEmpty.join(', ')} will be left with no data.`}
                      </p>
                      <p className="mt-1 text-xs text-ink-muted">
                        Re-importing a period replaces its figures rather than adding to them, so
                        deleting this import does not restore whatever was there before it — nothing
                        else covers {impact.periodsLeftEmpty.length === 1 ? 'that period' : 'those periods'}.
                        You would need to import {impact.periodsLeftEmpty.length === 1 ? 'that month' : 'those months'} again.
                      </p>
                    </div>
                  ) : (
                    <div className="rounded-lg bg-canvas px-3 py-2.5 text-xs text-ink-muted">
                      Every period this import covers is also covered by other data, so no month will
                      be left empty.
                    </div>
                  )}

                  {(impact.orphanedAccounts > 0 || impact.orphanedBranches > 0) && (
                    <p className="text-xs text-ink-faint">
                      {impact.orphanedBranches > 0 && `${impact.orphanedBranches} branch${impact.orphanedBranches === 1 ? '' : 'es'}`}
                      {impact.orphanedBranches > 0 && impact.orphanedAccounts > 0 && ' and '}
                      {impact.orphanedAccounts > 0 && `${impact.orphanedAccounts} expense head${impact.orphanedAccounts === 1 ? '' : 's'}`}
                      {' '}will have no remaining entries. They stay in the mappings so their
                      configuration is not lost.
                    </p>
                  )}

                  <div>
                    <label htmlFor="confirm-delete" className="label">
                      Type DELETE to confirm
                    </label>
                    <input
                      id="confirm-delete"
                      value={confirm}
                      onChange={(e) => setConfirm(e.target.value)}
                      autoComplete="off"
                      className="input mt-1.5"
                      placeholder="DELETE"
                    />
                  </div>
                </>
              )}

              {error && (
                <p role="alert" className="rounded-lg bg-negative/5 px-3 py-2 text-negative">
                  {error}
                </p>
              )}
            </div>

            <footer className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">
              <button type="button" onClick={() => setOpen(false)} disabled={deleting} className="btn-secondary text-sm">
                Cancel
              </button>
              <button
                type="button"
                onClick={performDelete}
                disabled={deleting || confirm !== 'DELETE' || !impact}
                className={cn(
                  'btn text-sm text-white',
                  confirm === 'DELETE' && impact ? 'bg-negative hover:bg-negative/90' : 'bg-negative/50',
                )}
              >
                {deleting ? 'Deleting…' : 'Delete permanently'}
              </button>
            </footer>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="text-right font-medium tnum">{value}</dd>
    </div>
  );
}

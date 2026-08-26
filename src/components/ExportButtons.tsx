'use client';

import { useState } from 'react';

/**
 * Exports carry the current filters, so what downloads is exactly what is on
 * screen (build spec §37).
 */
export default function ExportButtons({ query }: { query: string }) {
  const [busy, setBusy] = useState<string | null>(null);

  async function download(kind: 'excel') {
    setBusy(kind);
    try {
      // Navigating rather than fetching lets the browser handle the file
      // dialog and keeps the session cookie attached.
      window.location.href = `/api/export/${kind}?${query}`;
    } finally {
      setTimeout(() => setBusy(null), 1500);
    }
  }

  return (
    <div className="flex items-center gap-2 no-print">
      <button onClick={() => download('excel')} disabled={busy !== null} className="btn-secondary text-xs">
        {busy === 'excel' ? 'Preparing…' : 'Export Excel'}
      </button>
      <button onClick={() => window.print()} className="btn-secondary text-xs">
        Export PDF
      </button>
    </div>
  );
}

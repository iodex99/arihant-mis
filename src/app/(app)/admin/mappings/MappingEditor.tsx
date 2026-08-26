'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { cn } from '@/lib/cn';

interface Account {
  id: string;
  name: string;
  groupHead: string;
  groupMapped: boolean;
}

export default function MappingEditor({ accounts, groups }: { accounts: Account[]; groups: string[] }) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [onlyUnmapped, setOnlyUnmapped] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const shown = accounts.filter((a) => {
    if (onlyUnmapped && a.groupMapped) return false;
    if (!query.trim()) return true;
    const q = query.toLowerCase();
    return a.name.toLowerCase().includes(q) || a.groupHead.toLowerCase().includes(q);
  });

  async function assign(account: Account, groupHead: string) {
    if (groupHead === account.groupHead) return;
    setSaving(account.id);
    setError(null);

    try {
      const res = await fetch('/api/mappings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accountName: account.name, groupHead }),
      });

      if (!res.ok) {
        const body = await res.json();
        setError(body.error ?? 'Could not save that mapping.');
        return;
      }

      router.refresh();
    } catch {
      setError('Could not reach the server. The mapping was not changed.');
    } finally {
      setSaving(null);
    }
  }

  const options = [...new Set([...groups, 'Unclassified'])].sort();

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search expense heads…"
          className="input max-w-xs py-1.5 text-sm"
        />
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={onlyUnmapped}
            onChange={(e) => setOnlyUnmapped(e.target.checked)}
            className="rounded border-line text-accent focus:ring-accent"
          />
          Only unmapped
        </label>
        <span className="ml-auto text-xs text-ink-faint">{shown.length} shown</span>
      </div>

      {error && (
        <p role="alert" className="mb-3 rounded-lg bg-negative/5 px-3 py-2 text-sm text-negative">
          {error}
        </p>
      )}

      <div className="table-scroll max-h-[500px] rounded-lg border border-line">
        <table className="mis-table">
          <thead>
            <tr>
              <th>Expense head</th>
              <th>Group head</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr>
                <td colSpan={3} className="py-8 text-center text-ink-faint">
                  No matching heads.
                </td>
              </tr>
            )}
            {shown.map((a) => (
              <tr key={a.id} className={cn(!a.groupMapped && 'bg-amber-50/50')}>
                <td className="font-medium">{a.name}</td>
                <td>
                  <select
                    value={a.groupHead}
                    onChange={(e) => assign(a, e.target.value)}
                    disabled={saving === a.id}
                    className="input py-1 text-xs"
                    aria-label={`Group for ${a.name}`}
                  >
                    {options.map((g) => (
                      <option key={g} value={g}>
                        {g}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="text-xs text-ink-faint">
                  {saving === a.id ? 'saving…' : a.groupMapped ? '' : 'unmapped'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-xs text-ink-faint">
        Changing a group applies immediately and is remembered, so future imports of the same head
        inherit it without needing to be reassigned.
      </p>
    </div>
  );
}

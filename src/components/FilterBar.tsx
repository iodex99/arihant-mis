'use client';

import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { useCallback, useMemo, useState, useTransition } from 'react';
import { cn } from '@/lib/cn';
import type { FilterOptions } from '@/lib/mis/engine';

/**
 * Global filters.
 *
 * Filter state lives in the URL, so a filtered view is shareable, survives
 * reload, and drives the server components below it. Changes are pushed with
 * `router.replace` inside a transition — no full page reload (build spec §12).
 */
export default function FilterBar({ options }: { options: FilterOptions }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [expanded, setExpanded] = useState(false);

  const current = useMemo(() => {
    const get = (k: string) => searchParams.getAll(k).flatMap((v) => v.split(',')).filter(Boolean);
    return {
      fy: searchParams.get('fy') ?? '',
      quarter: searchParams.get('quarter') ?? '',
      month: get('month'),
      centre: get('centre'),
      branch: get('branch'),
      stream: get('stream'),
      group: get('group'),
      status: get('status'),
    };
  }, [searchParams]);

  const update = useCallback(
    (key: string, value: string | string[]) => {
      const params = new URLSearchParams(searchParams.toString());
      const list = Array.isArray(value) ? value.filter(Boolean) : value ? [value] : [];
      if (list.length === 0) params.delete(key);
      else params.set(key, list.join(','));

      startTransition(() => {
        router.replace(`${pathname}?${params.toString()}`, { scroll: false });
      });
    },
    [pathname, router, searchParams],
  );

  const clearAll = useCallback(() => {
    startTransition(() => router.replace(pathname, { scroll: false }));
  }, [pathname, router]);

  // Months narrow to the selected financial year, so the list stays usable as
  // years accumulate.
  const months = current.fy
    ? options.months.filter((m) => m.financialYear === current.fy)
    : options.months;

  const activeCount =
    (current.fy ? 1 : 0) +
    (current.quarter ? 1 : 0) +
    current.month.length +
    current.centre.length +
    current.branch.length +
    current.stream.length +
    current.group.length +
    current.status.length;

  return (
    <section
      aria-label="Filters"
      className={cn('card no-print mb-6 transition-opacity', pending && 'opacity-60')}
    >
      <div className="flex flex-wrap items-end gap-3 p-4">
        <Select
          label="Financial year"
          value={current.fy}
          options={options.financialYears}
          onChange={(v) => update('fy', v)}
          allLabel="All years"
        />
        <Select
          label="Quarter"
          value={current.quarter}
          options={options.quarters}
          onChange={(v) => update('quarter', v)}
          allLabel="All quarters"
        />
        <MultiSelect
          label="Month"
          plural="months"
          selected={current.month}
          options={months.map((m) => m.label)}
          onChange={(v) => update('month', v)}
        />
        <MultiSelect
          label="Centre"
          plural="centres"
          selected={current.centre}
          options={options.centres}
          onChange={(v) => update('centre', v)}
        />
        <MultiSelect
          label="Branch"
          plural="branches"
          selected={current.branch}
          options={options.branches.map((b) => b.abbreviation)}
          onChange={(v) => update('branch', v)}
        />
        <MultiSelect
          label="Stream"
          plural="streams"
          selected={current.stream}
          options={options.streams}
          onChange={(v) => update('stream', v)}
        />

        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="btn-ghost text-xs"
          aria-expanded={expanded}
        >
          {expanded ? 'Fewer filters' : 'More filters'}
        </button>

        {activeCount > 0 && (
          <button type="button" onClick={clearAll} className="btn-ghost text-xs text-accent">
            Clear {activeCount} filter{activeCount === 1 ? '' : 's'}
          </button>
        )}
      </div>

      {expanded && (
        <div className="flex flex-wrap items-end gap-3 border-t border-line px-4 py-3">
          <MultiSelect
            label="Expense group"
            plural="expense groups"
            selected={current.group}
            options={options.groups}
            onChange={(v) => update('group', v)}
          />
          <MultiSelect
            label="Branch status"
            plural="statuses"
            selected={current.status}
            options={options.statuses}
            onChange={(v) => update('status', v)}
          />
          <p className="max-w-md text-xs text-ink-faint">
            Filtering by expense group narrows expense figures only. Revenue stays at the
            full revenue of the remaining scope, so percentages of revenue keep their meaning.
          </p>
        </div>
      )}
    </section>
  );
}

function Select({
  label,
  value,
  options,
  onChange,
  allLabel,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
  allLabel: string;
}) {
  return (
    <div className="min-w-[150px]">
      <label className="label">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="input mt-1.5 py-1.5"
      >
        <option value="">{allLabel}</option>
        {options.map((o) => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
    </div>
  );
}

/** Checkbox popover — plain HTML, keyboard-navigable, no dependency. */
function MultiSelect({
  label,
  plural,
  selected,
  options,
  onChange,
}: {
  label: string;
  /** Explicit plural — appending "s" gives "branchs", "centres" -> "centres s". */
  plural: string;
  selected: string[];
  options: string[];
  onChange: (v: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const shown = query
    ? options.filter((o) => o.toLowerCase().includes(query.toLowerCase()))
    : options;

  const summary =
    selected.length === 0 ? `All ${plural}`
    : selected.length === 1 ? selected[0]
    : `${selected.length} selected`;

  function toggle(option: string) {
    onChange(
      selected.includes(option)
        ? selected.filter((s) => s !== option)
        : [...selected, option],
    );
  }

  return (
    <div className="relative min-w-[150px]">
      <label className="label">{label}</label>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={cn(
          'input mt-1.5 flex items-center justify-between gap-2 py-1.5 text-left',
          selected.length > 0 && 'border-accent bg-accent-soft/50',
        )}
      >
        <span className="truncate">{summary}</span>
        <span aria-hidden className="text-ink-faint">▾</span>
      </button>

      {open && (
        <>
          {/* Click-away layer. */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden />
          <div className="absolute z-50 mt-1 w-64 rounded-lg border border-line bg-surface p-2 shadow-pop">
            {options.length > 8 && (
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={`Search ${plural}…`}
                className="input mb-2 py-1.5 text-xs"
              />
            )}

            <div className="max-h-64 overflow-y-auto">
              {shown.length === 0 && (
                <p className="px-2 py-3 text-xs text-ink-faint">No matches.</p>
              )}
              {shown.map((o) => (
                <label
                  key={o}
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-canvas"
                >
                  <input
                    type="checkbox"
                    checked={selected.includes(o)}
                    onChange={() => toggle(o)}
                    className="rounded border-line text-accent focus:ring-accent"
                  />
                  <span className="truncate">{o}</span>
                </label>
              ))}
            </div>

            {selected.length > 0 && (
              <button
                type="button"
                onClick={() => onChange([])}
                className="mt-2 w-full rounded px-2 py-1 text-left text-xs text-accent hover:bg-canvas"
              >
                Clear selection
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

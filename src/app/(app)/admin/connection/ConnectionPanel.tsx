'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/format';

interface Config {
  adapter: string;
  host: string;
  port: number;
  useHttps: boolean;
  companyName: string | null;
  timeoutMs: number;
  enabled: boolean;
}

interface Status {
  reachable: boolean;
  version?: string;
  product?: string;
  latencyMs?: number;
  message: string;
  remedy?: string[];
  detail?: string;
}

interface Probe {
  capability: string;
  ok: boolean;
  count?: number;
  latencyMs?: number;
  message: string;
}

const CAPABILITY_LABELS: Record<string, string> = {
  companies: 'Companies',
  groups: 'Groups',
  ledgers: 'Ledgers',
  costCentres: 'Cost Centres',
  vouchers: 'Transactions',
  reports: 'Reports',
};

export default function ConnectionPanel({
  initialConfig,
  adapters,
  lastTest,
}: {
  initialConfig: Config;
  adapters: { id: string; label: string; available: boolean; note: string }[];
  lastTest: { at: Date | null; ok: boolean | null; message: string | null; version: string | null };
}) {
  const router = useRouter();
  const [config, setConfig] = useState(initialConfig);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [probes, setProbes] = useState<Probe[]>([]);
  const [syncResult, setSyncResult] = useState<{ status: string; message: string } | null>(null);
  const [saved, setSaved] = useState(false);

  async function save() {
    setSaving(true);
    setSaved(false);
    try {
      const res = await fetch('/api/tally/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(config),
      });
      if (res.ok) {
        setSaved(true);
        router.refresh();
      }
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    setTesting(true);
    setStatus(null);
    setProbes([]);
    try {
      const res = await fetch('/api/tally/test', { method: 'POST' });
      const body = await res.json();
      setStatus(body.status);
      setProbes(body.probes ?? []);
      router.refresh();
    } catch {
      setStatus({
        reachable: false,
        message: 'The test request did not complete.',
        remedy: ['Check that the MIS server itself is healthy, then try again.'],
      });
    } finally {
      setTesting(false);
    }
  }

  async function sync() {
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await fetch('/api/tally/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      setSyncResult(await res.json());
      router.refresh();
    } catch {
      setSyncResult({ status: 'FAILED', message: 'The sync request did not complete.' });
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* Status */}
      <section className="card card-pad">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span
              aria-hidden
              className={cn(
                'h-2.5 w-2.5 rounded-full',
                lastTest.ok ? 'bg-emerald-500' : lastTest.ok === false ? 'bg-rose-500' : 'bg-slate-300',
              )}
            />
            <span className="font-medium">
              {lastTest.ok ? 'Connected' : lastTest.ok === false ? 'Disconnected' : 'Never tested'}
            </span>
            {lastTest.at && (
              <span className="text-xs text-ink-faint">· last tested {formatDateTime(lastTest.at)}</span>
            )}
          </div>
          <div className="flex gap-2">
            <button onClick={test} disabled={testing} className="btn-secondary text-xs">
              {testing ? 'Testing…' : 'Test connection'}
            </button>
            <button onClick={sync} disabled={syncing || !config.enabled} className="btn-primary text-xs">
              {syncing ? 'Syncing…' : 'Sync now'}
            </button>
          </div>
        </div>

        {lastTest.version && (
          <p className="mt-2 text-xs text-ink-muted">Tally version reported: {lastTest.version}</p>
        )}

        {!config.enabled && (
          <p className="mt-3 rounded-lg bg-canvas px-3 py-2 text-xs text-ink-muted">
            Sync is disabled, so “Sync now” is unavailable. Test the connection first; enable sync
            only once the test succeeds against the real Tally machine.
          </p>
        )}
      </section>

      {/* Test result */}
      {status && (
        <section className={cn('card card-pad', status.reachable ? 'border-emerald-200' : 'border-amber-300')}>
          <h2 className="font-semibold">{status.reachable ? 'Connection succeeded' : 'Connection unavailable'}</h2>
          <p className="mt-1 text-sm text-ink-muted">{status.message}</p>

          <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            {status.version && <Pair label="Tally version" value={status.version} />}
            {status.product && <Pair label="Product" value={status.product} />}
            {status.latencyMs !== undefined && <Pair label="Round trip" value={`${status.latencyMs} ms`} />}
          </dl>

          {status.remedy && status.remedy.length > 0 && (
            <div className="mt-4">
              <p className="text-sm font-medium">Check the following:</p>
              <ol className="mt-1.5 list-decimal space-y-1 pl-5 text-sm text-ink-muted">
                {status.remedy.map((r, i) => <li key={i}>{r}</li>)}
              </ol>
            </div>
          )}

          {status.detail && (
            <details className="mt-3">
              <summary className="cursor-pointer text-xs text-ink-faint">Technical detail</summary>
              <pre className="mt-1 overflow-x-auto rounded bg-canvas p-2 text-xs">{status.detail}</pre>
            </details>
          )}
        </section>
      )}

      {/* Capability probes */}
      {probes.length > 0 && (
        <section className="card">
          <header className="border-b border-line px-5 py-3.5">
            <h2 className="text-sm font-semibold">Capabilities</h2>
            <p className="mt-0.5 text-xs text-ink-faint">
              Each is requested independently, so a partly-working environment shows exactly which
              parts work.
            </p>
          </header>
          <table className="mis-table">
            <tbody>
              {probes.map((p) => (
                <tr key={p.capability}>
                  <td className="w-40 font-medium">{CAPABILITY_LABELS[p.capability] ?? p.capability}</td>
                  <td className="w-16">
                    <span aria-hidden className={p.ok ? 'text-emerald-600' : 'text-rose-600'}>
                      {p.ok ? '✓' : '✕'}
                    </span>
                    <span className="sr-only">{p.ok ? 'available' : 'unavailable'}</span>
                  </td>
                  <td className="num w-24 text-ink-faint">{p.latencyMs !== undefined ? `${p.latencyMs} ms` : '—'}</td>
                  <td className="!whitespace-normal text-xs text-ink-muted">{p.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {syncResult && (
        <section className={cn('card card-pad', syncResult.status === 'FAILED' ? 'border-amber-300' : 'border-emerald-200')}>
          <h2 className="font-semibold">Sync {syncResult.status.toLowerCase()}</h2>
          <p className="mt-1 text-sm text-ink-muted">{syncResult.message}</p>
        </section>
      )}

      {/* Settings */}
      <section className="card">
        <header className="border-b border-line px-5 py-3.5">
          <h2 className="text-sm font-semibold">Connection settings</h2>
          <p className="mt-0.5 text-xs text-ink-faint">
            These are stored on the server. They are never sent to a browser other than this admin
            page, and no Tally credentials are exposed to client-side code.
          </p>
        </header>

        <div className="grid gap-4 p-5 sm:grid-cols-2">
          <Field label="Adapter">
            <select
              value={config.adapter}
              onChange={(e) => setConfig({ ...config, adapter: e.target.value })}
              className="input"
            >
              {adapters.map((a) => (
                <option key={a.id} value={a.id} disabled={!a.available}>
                  {a.label}{a.available ? '' : ' — not implemented'}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-ink-faint">
              {adapters.find((a) => a.id === config.adapter)?.note}
            </p>
          </Field>

          <Field label="Tally company name">
            <input
              value={config.companyName ?? ''}
              onChange={(e) => setConfig({ ...config, companyName: e.target.value || null })}
              placeholder="exactly as it appears in Tally"
              className="input"
            />
          </Field>

          <Field label="Host">
            <input
              value={config.host}
              onChange={(e) => setConfig({ ...config, host: e.target.value })}
              className="input"
            />
            <p className="mt-1 text-xs text-ink-faint">
              The machine running Tally. Use <code>host.docker.internal</code> when the MIS runs in
              Docker and Tally runs on the same server.
            </p>
          </Field>

          <Field label="Port">
            <input
              type="number"
              value={config.port}
              onChange={(e) => setConfig({ ...config, port: Number(e.target.value) })}
              className="input"
            />
            <p className="mt-1 text-xs text-ink-faint">Whatever port Tally’s connectivity setting shows; 9000 by convention.</p>
          </Field>

          <Field label="Timeout">
            <input
              type="number"
              value={config.timeoutMs}
              onChange={(e) => setConfig({ ...config, timeoutMs: Number(e.target.value) })}
              className="input"
            />
            <p className="mt-1 text-xs text-ink-faint">Milliseconds. Large date ranges need longer.</p>
          </Field>

          <div className="space-y-3">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={config.useHttps}
                onChange={(e) => setConfig({ ...config, useHttps: e.target.checked })}
                className="rounded border-line text-accent focus:ring-accent"
              />
              Use HTTPS
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={config.enabled}
                onChange={(e) => setConfig({ ...config, enabled: e.target.checked })}
                className="rounded border-line text-accent focus:ring-accent"
              />
              Enable Tally sync
            </label>
          </div>
        </div>

        <div className="flex items-center gap-3 border-t border-line px-5 py-4">
          <button onClick={save} disabled={saving} className="btn-primary text-sm">
            {saving ? 'Saving…' : 'Save settings'}
          </button>
          {saved && <span className="text-xs text-positive">Saved.</span>}
        </div>
      </section>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="label">{label}</label>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

function Pair({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}

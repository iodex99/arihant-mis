/**
 * Tally adapter factory and connection settings.
 *
 * Connection settings live in the database (or environment) and are read only
 * on the server. Nothing here is ever serialised into a client component —
 * see `redactConnection` for what may cross that boundary (build spec §28).
 */

import { prisma } from '../db';
import { TallyXmlHttpAdapter } from './xml-http';
import type { AdapterId, TallyAdapter, TallyConnectionConfig } from './types';

export * from './types';
export { TallyXmlHttpAdapter } from './xml-http';

/**
 * Adapters available today. The interface is the contract; which of these is
 * appropriate for Arihant is an environment question answered by the POC, not
 * by this code (docs/tally-integration.md).
 */
export const ADAPTERS: { id: AdapterId; label: string; available: boolean; note: string }[] = [
  {
    id: 'TALLY_XML_HTTP',
    label: 'Tally XML over HTTP',
    available: true,
    note: 'Tally acts as a server on a local port. Works with Tally.ERP 9 and TallyPrime when the connectivity listener is enabled.',
  },
  {
    id: 'TALLY_JSON_HTTP',
    label: 'Tally JSON over HTTP',
    available: false,
    note: 'TallyPrime 7.0 documents native JSON exchange. Not implemented until Arihant’s Tally version is confirmed to support it — implementing against undocumented assumptions would produce a connector that silently returns wrong data.',
  },
  {
    id: 'TALLY_ODBC',
    label: 'Tally ODBC',
    available: false,
    note: 'Requires the Tally ODBC driver on the MIS host and is Windows-only. Kept as an option for environments where the HTTP listener cannot be enabled.',
  },
];

export function createAdapter(config: TallyConnectionConfig): TallyAdapter {
  switch (config.adapter) {
    case 'TALLY_XML_HTTP':
      return new TallyXmlHttpAdapter(config);
    case 'TALLY_JSON_HTTP':
    case 'TALLY_ODBC':
      throw new Error(
        `The ${config.adapter} adapter is not implemented. ` +
          `Run the connection test with the XML/HTTP adapter first and record what Arihant's Tally reports; ` +
          `see docs/tally-integration.md.`,
      );
    default:
      throw new Error(`Unknown Tally adapter "${config.adapter}".`);
  }
}

/** Stored settings for a company, falling back to environment defaults. */
export async function getConnectionConfig(companyId: string): Promise<TallyConnectionConfig & { enabled: boolean }> {
  const stored = await prisma.tallyConnection.findUnique({ where: { companyId } });

  if (stored) {
    return {
      adapter: stored.adapter as AdapterId,
      host: stored.host,
      port: stored.port,
      useHttps: stored.useHttps,
      companyName: stored.tallyCompanyName,
      timeoutMs: stored.timeoutMs,
      extra: (stored.config as Record<string, unknown> | null) ?? undefined,
      enabled: stored.enabled,
    };
  }

  return {
    adapter: (process.env.TALLY_ADAPTER as AdapterId) ?? 'TALLY_XML_HTTP',
    host: process.env.TALLY_HOST ?? 'localhost',
    port: Number(process.env.TALLY_PORT ?? 9000),
    useHttps: process.env.TALLY_USE_HTTPS === 'true',
    companyName: process.env.TALLY_COMPANY_NAME || null,
    timeoutMs: Number(process.env.TALLY_TIMEOUT_MS ?? 60_000),
    enabled: process.env.TALLY_ENABLED === 'true',
  };
}

export async function saveConnectionConfig(
  companyId: string,
  input: Partial<TallyConnectionConfig> & { enabled?: boolean },
): Promise<void> {
  const data = {
    adapter: input.adapter,
    host: input.host,
    port: input.port,
    useHttps: input.useHttps,
    tallyCompanyName: input.companyName ?? null,
    timeoutMs: input.timeoutMs,
    enabled: input.enabled,
    config: (input.extra ?? undefined) as never,
  };

  await prisma.tallyConnection.upsert({
    where: { companyId },
    create: {
      companyId,
      adapter: input.adapter ?? 'TALLY_XML_HTTP',
      host: input.host ?? 'localhost',
      port: input.port ?? 9000,
      useHttps: input.useHttps ?? false,
      tallyCompanyName: input.companyName ?? null,
      timeoutMs: input.timeoutMs ?? 60_000,
      enabled: input.enabled ?? false,
    },
    update: Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)),
  });
}

/**
 * The subset of connection settings safe to render in the browser.
 *
 * Host and port are operational detail an administrator needs in order to fix
 * a connection; `extra` may hold adapter credentials and never leaves the
 * server.
 */
export function redactConnection(config: TallyConnectionConfig & { enabled: boolean }) {
  return {
    adapter: config.adapter,
    host: config.host,
    port: config.port,
    useHttps: config.useHttps,
    companyName: config.companyName ?? null,
    timeoutMs: config.timeoutMs,
    enabled: config.enabled,
    hasExtraConfig: Boolean(config.extra && Object.keys(config.extra).length > 0),
  };
}

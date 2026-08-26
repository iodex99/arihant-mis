import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { requireCompany } from '@/lib/company';
import { createAdapter, getConnectionConfig } from '@/lib/tally';
import { prisma } from '@/lib/db';

export const maxDuration = 300;

/**
 * Connection test and capability probe (build spec §5).
 * Records exactly what was observed, including failures — the point of the POC
 * is an honest report, not a green tick.
 */
export async function POST() {
  await requireAdmin();
  const company = await requireCompany();
  const config = await getConnectionConfig(company.id);

  let adapter;
  try {
    adapter = createAdapter(config);
  } catch (error) {
    return NextResponse.json({
      status: {
        reachable: false,
        message: error instanceof Error ? error.message : 'Adapter unavailable.',
        remedy: ['Choose the Tally XML over HTTP adapter, which is the implemented one.'],
      },
      probes: [],
    });
  }

  const status = await adapter.testConnection();
  const probes = status.reachable ? await adapter.probeCapabilities() : [];

  await prisma.tallyConnection.upsert({
    where: { companyId: company.id },
    create: {
      companyId: company.id,
      adapter: config.adapter,
      host: config.host,
      port: config.port,
      useHttps: config.useHttps,
      tallyCompanyName: config.companyName,
      timeoutMs: config.timeoutMs,
      enabled: config.enabled,
      lastTestedAt: new Date(),
      lastTestOk: status.reachable,
      lastTestMessage: status.message,
      detectedVersion: status.version,
    },
    update: {
      lastTestedAt: new Date(),
      lastTestOk: status.reachable,
      lastTestMessage: status.message,
      detectedVersion: status.version,
    },
  });

  await prisma.auditLog.create({
    data: {
      action: 'TALLY_CONNECTION_TEST',
      entity: 'TallyConnection',
      metadata: { reachable: status.reachable, message: status.message, version: status.version ?? null },
    },
  });

  return NextResponse.json({ status, probes });
}

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * Liveness and readiness for the container healthcheck and any reverse proxy.
 * Deliberately unauthenticated and free of business data.
 */
export async function GET() {
  const started = Date.now();

  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({
      status: 'ok',
      version: process.env.APP_VERSION ?? '1.0.0',
      database: 'connected',
      latencyMs: Date.now() - started,
    });
  } catch {
    // The message is generic on purpose — this endpoint is reachable without
    // authentication and must not leak the connection string or host details.
    return NextResponse.json(
      { status: 'degraded', database: 'unreachable', latencyMs: Date.now() - started },
      { status: 503 },
    );
  }
}

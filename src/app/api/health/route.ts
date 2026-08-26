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
    const [row] = await prisma.$queryRaw<{ encoding: string }[]>`
      SELECT current_setting('server_encoding') AS encoding
    `;

    // A non-UTF8 database silently rejects any row containing a rupee sign, a
    // curly quote or Devanagari — it fails the write rather than mangling it,
    // so an import can break on one branch name. Surfacing it here means the
    // healthcheck catches a misprovisioned database before data does.
    const encodingOk = row?.encoding?.toUpperCase() === 'UTF8';

    return NextResponse.json(
      {
        status: encodingOk ? 'ok' : 'degraded',
        version: process.env.APP_VERSION ?? '1.0.0',
        database: 'connected',
        encoding: row?.encoding ?? 'unknown',
        ...(encodingOk
          ? {}
          : {
              warning:
                `The database was created with ${row?.encoding} encoding, not UTF8. ` +
                'Text containing the rupee sign, curly quotes or Indian-language characters cannot be stored. ' +
                'Recreate the database with --encoding=UTF8 and restore from a backup.',
            }),
        latencyMs: Date.now() - started,
      },
      { status: encodingOk ? 200 : 503 },
    );
  } catch {
    // The message is generic on purpose — this endpoint is reachable without
    // authentication and must not leak the connection string or host details.
    return NextResponse.json(
      { status: 'degraded', database: 'unreachable', latencyMs: Date.now() - started },
      { status: 503 },
    );
  }
}

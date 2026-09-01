import { NextResponse, type NextRequest } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { requireCompany } from '@/lib/company';
import { autoImport } from '@/lib/import/auto-import';
import { toErrorResponse } from '@/lib/api';
import { importLogger } from '@/lib/logger';

export const maxDuration = 300;

const MAX_BYTES = 60 * 1024 * 1024;

/**
 * Machine-to-machine import.
 *
 * Arihant's Tally is a hosted web application with no reachable Tally process,
 * so nothing can pull from it. This is the other direction: if that product (or
 * any scheduler) can POST its export on a schedule, the chain becomes automatic
 * without anyone opening a browser.
 *
 *   curl -X POST https://mis.example/api/imports/ingest \
 *        -H "Authorization: Bearer $INGEST_API_KEY" \
 *        -F "file=@monthly-export.xlsx"
 *
 * Authenticated by a static key rather than a session, because the caller is a
 * scheduler with no login. The key only permits *depositing* a file — it grants
 * no read access to any figure, and it cannot delete anything.
 *
 * The same safety rule as the folder watcher: imported only when nothing needs
 * a person, held for review otherwise.
 */
export async function POST(request: NextRequest) {
  try {
    const configured = process.env.INGEST_API_KEY;

    // Absent key disables the endpoint outright, rather than leaving it open.
    if (!configured || configured.length < 24) {
      return NextResponse.json(
        {
          error: 'Machine import is not enabled.',
          remedy:
            'Set INGEST_API_KEY in .env to a random string of at least 24 characters and restart, then send it as a Bearer token.',
        },
        { status: 503 },
      );
    }

    const presented = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
    if (!constantTimeEquals(presented, configured)) {
      importLogger.warn({ scope: 'ingest' }, 'rejected ingest with a bad key');
      return NextResponse.json({ error: 'That key is not valid.' }, { status: 401 });
    }

    const company = await requireCompany();
    const form = await request.formData();
    const file = form.get('file');

    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: 'No file was received.', remedy: 'Send the export as multipart form field "file".' },
        { status: 400 },
      );
    }

    if (file.size === 0) {
      return NextResponse.json({ error: 'The uploaded file is empty.' }, { status: 400 });
    }

    if (file.size > MAX_BYTES) {
      return NextResponse.json(
        { error: `The file is over the ${MAX_BYTES / 1024 / 1024} MB limit.` },
        { status: 413 },
      );
    }

    const result = await autoImport(company.id, file.name, Buffer.from(await file.arrayBuffer()));

    // 202 for held: the file arrived and is safe, it just needs a person.
    const status =
      result.decision === 'IMPORTED' || result.decision === 'DUPLICATE'
        ? 200
        : result.decision === 'HELD_FOR_REVIEW'
          ? 202
          : 422;

    return NextResponse.json(result, { status });
  } catch (error) {
    return toErrorResponse(error, 'imports.ingest');
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

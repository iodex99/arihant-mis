import { NextResponse, type NextRequest } from 'next/server';
import { createHash } from 'node:crypto';
import { requireImporter, ForbiddenError, UnauthorizedError } from '@/lib/auth';
import { requireCompany } from '@/lib/company';
import { prepareImport } from '@/lib/import/persist';
import { stageFile } from '@/lib/import/storage';
import { ImportFormatError } from '@/lib/parser/readers';
import { importLogger } from '@/lib/logger';

export const maxDuration = 300;

const MAX_BYTES = 60 * 1024 * 1024;

/**
 * Analyse an uploaded file and return the preview. Nothing is written to the
 * MIS here — the operator confirms first (build spec §21).
 */
export async function POST(request: NextRequest) {
  try {
    await requireImporter();
    const company = await requireCompany();

    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: 'No file was received.', remedy: 'Choose a .xlsx or .csv file and try again.' },
        { status: 400 },
      );
    }

    if (file.size === 0) {
      return NextResponse.json(
        { error: 'The uploaded file is empty.', remedy: 'Check the file opens in Excel, then upload it again.' },
        { status: 400 },
      );
    }

    if (file.size > MAX_BYTES) {
      return NextResponse.json(
        {
          error: `The file is ${(file.size / 1024 / 1024).toFixed(1)} MB, over the ${MAX_BYTES / 1024 / 1024} MB limit.`,
          remedy: 'Split the workbook by period, or remove sheets that are not needed for the MIS.',
        },
        { status: 413 },
      );
    }

    const overridesRaw = form.get('overrides');
    const overrides =
      typeof overridesRaw === 'string' && overridesRaw
        ? (JSON.parse(overridesRaw) as Record<string, string | null>)
        : undefined;

    const buffer = Buffer.from(await file.arrayBuffer());
    const hash = createHash('sha256').update(buffer).digest('hex');
    const stagedPath = await stageFile(hash, file.name, buffer);

    const prepared = await prepareImport(company.id, file.name, buffer, overrides);

    importLogger.info(
      { filename: file.name, sheets: prepared.analysis.sheets.length, facts: prepared.normalized.facts.length },
      'file analysed',
    );

    return NextResponse.json({
      stagedPath,
      filename: file.name,
      fileSize: file.size,
      analysis: prepared.analysis,
      normalization: {
        rowCount: prepared.normalized.rows.length,
        factCount: prepared.normalized.facts.length,
        warnings: prepared.normalized.warnings,
        skipped: prepared.normalized.skipped.slice(0, 50),
        dimensions: {
          periods: [...prepared.normalized.dimensions.periods.values()].map((p) => p.label),
          branches: prepared.normalized.dimensions.branches.size,
          streams: prepared.normalized.dimensions.streams.size,
          centres: prepared.normalized.dimensions.centres.size,
          accounts: prepared.normalized.dimensions.accounts.size,
        },
      },
      reconciliation: prepared.reconciliation,
    });
  } catch (error) {
    return handleError(error);
  }
}

export function handleError(error: unknown) {
  if (error instanceof UnauthorizedError) {
    return NextResponse.json({ error: 'Please sign in again.' }, { status: 401 });
  }
  if (error instanceof ForbiddenError) {
    return NextResponse.json({ error: 'Your account cannot import data.' }, { status: 403 });
  }
  if (error instanceof ImportFormatError) {
    return NextResponse.json({ error: error.message, remedy: error.remedy }, { status: 415 });
  }

  const message = error instanceof Error ? error.message : String(error);
  importLogger.error({ err: message }, 'import failed');

  return NextResponse.json(
    {
      error: 'The file could not be read.',
      remedy:
        'This usually means the file is corrupt or password-protected. Open it in Excel, re-save it as .xlsx, and try again.',
      detail: message,
    },
    { status: 500 },
  );
}

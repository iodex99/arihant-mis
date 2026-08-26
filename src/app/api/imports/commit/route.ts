import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireImporter } from '@/lib/auth';
import { requireCompany } from '@/lib/company';
import { prepareImport, commitImport } from '@/lib/import/persist';
import { readStagedFile, keepFile, discardStaged } from '@/lib/import/storage';
import { handleError } from '../analyze/route';

export const maxDuration = 300;

const schema = z.object({
  stagedPath: z.string().min(1),
  filename: z.string().min(1),
  overrides: z.record(z.string(), z.string().nullable()).optional(),
  saveMapping: z.boolean().optional(),
  mappingProfileName: z.string().optional(),
  /** Required when reconciliation failed — the operator has read the warning. */
  acknowledgeWarnings: z.boolean().optional(),
});

export async function POST(request: NextRequest) {
  try {
    const user = await requireImporter();
    const company = await requireCompany();

    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Malformed request.' }, { status: 400 });
    }

    const { stagedPath, filename, overrides, saveMapping, mappingProfileName, acknowledgeWarnings } = parsed.data;

    const buffer = await readStagedFile(stagedPath);
    // Re-analyse the exact staged bytes so what is committed is what was
    // previewed, including any mapping overrides the operator set.
    const prepared = await prepareImport(company.id, filename, buffer, overrides);

    if (prepared.analysis.blockers.length > 0) {
      return NextResponse.json(
        {
          error: 'This file cannot be imported yet.',
          blockers: prepared.analysis.blockers,
        },
        { status: 422 },
      );
    }

    if (prepared.reconciliation.status === 'FAIL' && !acknowledgeWarnings) {
      return NextResponse.json(
        {
          error: 'The figures in this file do not reconcile.',
          remedy: 'Review the failed checks below. You can import anyway, but the MIS will be flagged for review.',
          reconciliation: prepared.reconciliation,
          requiresAcknowledgement: true,
        },
        { status: 409 },
      );
    }

    const result = await commitImport(company.id, filename, buffer, prepared, {
      userId: user.id,
      saveMapping,
      mappingProfileName,
    });

    // Keep the original file for troubleshooting, subject to retention.
    await keepFile(stagedPath, result.importId).catch(() => discardStaged(stagedPath));

    return NextResponse.json(result);
  } catch (error) {
    return handleError(error);
  }
}

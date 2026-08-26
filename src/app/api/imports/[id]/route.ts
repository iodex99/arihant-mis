import { NextResponse, type NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { requireCompany } from '@/lib/company';
import { assessDeletion, deleteImport } from '@/lib/import/delete';
import { toErrorResponse } from '@/lib/api';

/**
 * Deleting an import destroys financial records permanently, so it is
 * restricted to administrators — an analyst may add data but not remove it.
 */

/** What deleting this import would cost. Read-only; changes nothing. */
export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin();
    const company = await requireCompany();
    const { id } = await context.params;

    const impact = await assessDeletion(company.id, id);
    if (!impact) {
      return NextResponse.json({ error: 'That import does not exist.' }, { status: 404 });
    }

    return NextResponse.json(impact);
  } catch (error) {
    return toErrorResponse(error, 'imports.impact');
  }
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireAdmin();
    const company = await requireCompany();
    const { id } = await context.params;

    // A typed confirmation, because this cannot be undone from inside the
    // application — recovery means restoring a database backup.
    const body = (await request.json().catch(() => ({}))) as { confirm?: string };
    if (body.confirm !== 'DELETE') {
      return NextResponse.json(
        {
          error: 'This deletion was not confirmed.',
          remedy: 'Type DELETE in the confirmation box to proceed.',
        },
        { status: 400 },
      );
    }

    const result = await deleteImport(company.id, id, user.id);
    if (!result) {
      return NextResponse.json({ error: 'That import does not exist.' }, { status: 404 });
    }

    return NextResponse.json(result);
  } catch (error) {
    return toErrorResponse(error, 'imports.delete');
  }
}

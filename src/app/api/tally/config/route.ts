import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth';
import { requireCompany } from '@/lib/company';
import { getConnectionConfig, saveConnectionConfig, redactConnection } from '@/lib/tally';
import { toErrorResponse } from '@/lib/api';

const schema = z.object({
  adapter: z.enum(['TALLY_XML_HTTP', 'TALLY_JSON_HTTP', 'TALLY_ODBC']).optional(),
  host: z.string().min(1).max(255).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  useHttps: z.boolean().optional(),
  companyName: z.string().max(255).nullable().optional(),
  timeoutMs: z.number().int().min(1000).max(600_000).optional(),
  enabled: z.boolean().optional(),
});

export async function GET() {
  try {
    await requireAdmin();
    const company = await requireCompany();
    return NextResponse.json(redactConnection(await getConnectionConfig(company.id)));
  } catch (error) {
    return toErrorResponse(error, 'tally.config');
  }
}

export async function PUT(request: NextRequest) {
  try {
    await requireAdmin();
    const company = await requireCompany();

    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Those connection settings are not valid.', detail: parsed.error.issues.map((i) => i.message).join('; ') },
        { status: 400 },
      );
    }

    await saveConnectionConfig(company.id, parsed.data);
    return NextResponse.json(redactConnection(await getConnectionConfig(company.id)));
  } catch (error) {
    return toErrorResponse(error, 'tally.config');
  }
}

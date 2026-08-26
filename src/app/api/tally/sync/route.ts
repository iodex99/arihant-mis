import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth';
import { requireCompany } from '@/lib/company';
import { runSync } from '@/lib/tally/sync';

export const maxDuration = 300;

const schema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

export async function POST(request: NextRequest) {
  const user = await requireAdmin();
  const company = await requireCompany();

  const parsed = schema.safeParse(await request.json().catch(() => ({})));
  const body = parsed.success ? parsed.data : {};

  const result = await runSync(company.id, {
    from: body.from ? new Date(body.from) : undefined,
    to: body.to ? new Date(body.to) : undefined,
    trigger: 'MANUAL',
    userId: user.id,
  });

  return NextResponse.json(result, { status: result.status === 'FAILED' ? 502 : 200 });
}

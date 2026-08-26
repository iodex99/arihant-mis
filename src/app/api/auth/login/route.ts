import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { login } from '@/lib/auth';

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function POST(request: NextRequest) {
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Enter a valid email address and password.' }, { status: 400 });
  }

  const result = await login(parsed.data.email, parsed.data.password, {
    userAgent: request.headers.get('user-agent') ?? undefined,
    ipAddress: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim(),
  });

  if (!result.ok) {
    // Deliberately vague: do not reveal whether the account exists.
    return NextResponse.json({ error: result.error }, { status: 401 });
  }

  return NextResponse.json({ user: result.user });
}

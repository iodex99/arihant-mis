import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth';
import { requireCompany } from '@/lib/company';
import { prisma } from '@/lib/db';
import { normalizeAccountName } from '@/lib/parser/values';

const schema = z.object({
  accountName: z.string().min(1),
  groupHead: z.string().min(1).max(120),
});

/**
 * Reassign an expense head to a group. Applies immediately to the existing
 * account and is remembered as a rule so future imports inherit it.
 */
export async function POST(request: NextRequest) {
  const user = await requireAdmin();
  const company = await requireCompany();

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Provide an account name and a group head.' }, { status: 400 });
  }

  const normalized = normalizeAccountName(parsed.data.accountName);
  const groupHead = parsed.data.groupHead.trim();

  const account = await prisma.account.findUnique({
    where: { companyId_normalized: { companyId: company.id, normalized } },
  });

  if (!account) {
    return NextResponse.json({ error: `No account named "${parsed.data.accountName}" exists.` }, { status: 404 });
  }

  await prisma.$transaction([
    prisma.account.update({
      where: { id: account.id },
      data: { groupHead, groupMapped: true },
    }),
    prisma.mappingRule.upsert({
      where: { companyId_ruleType_sourceValue: { companyId: company.id, ruleType: 'ACCOUNT_GROUP', sourceValue: normalized } },
      create: { companyId: company.id, ruleType: 'ACCOUNT_GROUP', sourceValue: normalized, targetValue: groupHead },
      update: { targetValue: groupHead },
    }),
    prisma.auditLog.create({
      data: {
        userId: user.id,
        action: 'MAPPING_UPDATED',
        entity: 'Account',
        entityId: account.id,
        metadata: { account: account.name, from: account.groupHead, to: groupHead },
      },
    }),
  ]);

  return NextResponse.json({ ok: true, account: account.name, groupHead });
}

/**
 * Deleting an import.
 *
 * These need a live database, so they skip when one is not reachable — the same
 * pattern as the reference-workbook suite. They work inside their own
 * throwaway organization and never touch real company data.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient, Prisma } from '@prisma/client';
import { assessDeletion, deleteImport } from '@/lib/import/delete';

const prisma = new PrismaClient();

const SLUG = 'test-delete-import';

// Probed at module load, not in beforeAll: vitest decides describe.skip when it
// collects the file, which happens before any hook runs.
const reachable = await prisma
  .$queryRaw`SELECT 1`
  .then(() => true)
  .catch(() => false);

let companyId = '';
let userId = '';

beforeAll(async () => {
  if (!reachable) return;

  await cleanup();

  const org = await prisma.organization.create({ data: { name: 'Test Org', slug: SLUG } });

  const company = await prisma.company.create({
    data: { organizationId: org.id, name: 'Test Co', currency: 'INR' },
  });
  companyId = company.id;

  const user = await prisma.user.create({
    data: {
      email: `${SLUG}@example.invalid`,
      name: 'Test Admin',
      passwordHash: 'not-a-real-hash',
      role: 'ADMIN',
    },
  });
  userId = user.id;
});

afterAll(async () => {
  if (reachable) await cleanup();
  await prisma.$disconnect();
});

async function cleanup() {
  await prisma.user.deleteMany({ where: { email: `${SLUG}@example.invalid` } });
  // Cascades to company, dimensions, imports and facts.
  await prisma.organization.deleteMany({ where: { slug: SLUG } });
}

/** Build an import with facts across the given period labels. */
async function seedImport(filename: string, periodSpecs: { year: number; month: number; label: string }[]) {
  const record = await prisma.import.create({
    data: {
      companyId,
      filename,
      fileSize: 1000,
      fileHash: `hash-${filename}-${periodSpecs.map((p) => p.label).join('-')}`,
      status: 'COMPLETED',
      validationStatus: 'PASS',
      validation: { totals: { revenue: 1000, expense: 400, profit: 600 } } as Prisma.InputJsonValue,
      rowCount: periodSpecs.length,
      uploadedById: userId,
    },
  });

  const branch = await prisma.branch.upsert({
    where: { companyId_abbreviation: { companyId, abbreviation: 'TB' } },
    create: { companyId, abbreviation: 'TB', name: 'Test Branch' },
    update: {},
  });
  const stream = await prisma.stream.upsert({
    where: { companyId_name: { companyId, name: 'TestStream' } },
    create: { companyId, name: 'TestStream' },
    update: {},
  });
  const account = await prisma.account.upsert({
    where: { companyId_normalized: { companyId, normalized: 'TEST RENT' } },
    create: { companyId, name: 'Test Rent', normalized: 'TEST RENT', kind: 'EXPENSE', groupHead: 'Rent Expense' },
    update: {},
  });

  for (const spec of periodSpecs) {
    const period = await prisma.period.upsert({
      where: { companyId_year_month: { companyId, year: spec.year, month: spec.month } },
      create: {
        companyId,
        label: spec.label,
        year: spec.year,
        month: spec.month,
        quarter: 'Q3',
        financialYear: 'FY 2025-26',
        sortKey: spec.year * 100 + spec.month,
      },
      update: {},
    });

    await prisma.factEntry.create({
      data: {
        companyId,
        periodId: period.id,
        branchId: branch.id,
        streamId: stream.id,
        accountId: account.id,
        kind: 'EXPENSE',
        amount: new Prisma.Decimal('400.0000'),
        source: 'FILE_IMPORT',
        importId: record.id,
      },
    });
  }

  return record.id;
}

const suite = reachable ? describe : describe.skip;

suite('deleting an import', () => {
  it('reports which periods would be left with no data', async () => {
    const id = await seedImport('one.xlsx', [{ year: 2025, month: 10, label: "Oct'25" }]);

    const impact = await assessDeletion(companyId, id);

    expect(impact).not.toBeNull();
    expect(impact!.factCount).toBe(1);
    expect(impact!.periods.map((p) => p.label)).toEqual(["Oct'25"]);
    // Nothing else covers October, so it would be emptied.
    expect(impact!.periodsLeftEmpty).toEqual(["Oct'25"]);
    expect(impact!.leavesNoData).toBe(true);

    await deleteImport(companyId, id, userId);
  });

  it('does not flag a period that another import also covers', async () => {
    const first = await seedImport('a.xlsx', [{ year: 2025, month: 10, label: "Oct'25" }]);
    const second = await seedImport('b.xlsx', [{ year: 2025, month: 10, label: "Oct'25" }]);

    const impact = await assessDeletion(companyId, second);

    // October survives, because the first import still supplies it.
    expect(impact!.periodsLeftEmpty).toEqual([]);
    expect(impact!.leavesNoData).toBe(false);

    await deleteImport(companyId, first, userId);
    await deleteImport(companyId, second, userId);
  });

  it('removes the facts, rows and sheets that belong to it, and nothing else', async () => {
    const keep = await seedImport('keep.xlsx', [{ year: 2025, month: 11, label: "Nov'25" }]);
    const drop = await seedImport('drop.xlsx', [{ year: 2025, month: 10, label: "Oct'25" }]);

    expect(await prisma.factEntry.count({ where: { companyId } })).toBe(2);

    const result = await deleteImport(companyId, drop, userId);

    expect(result?.deleted).toBe(true);
    expect(result?.factsRemoved).toBe(1);
    expect(await prisma.factEntry.count({ where: { companyId } })).toBe(1);
    expect(await prisma.import.count({ where: { companyId } })).toBe(1);
    // The other import is untouched.
    expect(await prisma.factEntry.count({ where: { importId: keep } })).toBe(1);

    await deleteImport(companyId, keep, userId);
  });

  it('keeps an audit record of what was deleted', async () => {
    const id = await seedImport('audited.xlsx', [{ year: 2025, month: 10, label: "Oct'25" }]);
    await deleteImport(companyId, id, userId);

    const log = await prisma.auditLog.findFirst({
      where: { action: 'IMPORT_DELETED', entityId: id },
    });

    expect(log).not.toBeNull();
    const meta = log!.metadata as Record<string, unknown>;
    expect(meta.filename).toBe('audited.xlsx');
    expect(meta.factCount).toBe(1);
    // The record of its existence outlives the import itself.
    expect(await prisma.import.findUnique({ where: { id } })).toBeNull();

    await prisma.auditLog.deleteMany({ where: { entityId: id } });
  });

  it('leaves shared dimensions in place', async () => {
    const id = await seedImport('dims.xlsx', [{ year: 2025, month: 10, label: "Oct'25" }]);
    await deleteImport(companyId, id, userId);

    // A branch that traded in a deleted period is still a real branch, and its
    // group mappings must survive so they need not be reconfigured.
    expect(await prisma.branch.count({ where: { companyId } })).toBeGreaterThan(0);
    expect(await prisma.account.count({ where: { companyId } })).toBeGreaterThan(0);
  });

  it('returns null for an import that does not exist', async () => {
    expect(await assessDeletion(companyId, 'no-such-id')).toBeNull();
    expect(await deleteImport(companyId, 'no-such-id', userId)).toBeNull();
  });

  it('refuses to touch an import belonging to another company', async () => {
    const id = await seedImport('other.xlsx', [{ year: 2025, month: 10, label: "Oct'25" }]);

    // Scoping is by companyId, so a wrong company must find nothing.
    expect(await assessDeletion('some-other-company', id)).toBeNull();
    expect(await deleteImport('some-other-company', id, userId)).toBeNull();
    expect(await prisma.import.findUnique({ where: { id } })).not.toBeNull();

    await deleteImport(companyId, id, userId);
  });
});

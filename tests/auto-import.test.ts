/**
 * Unattended import.
 *
 * The safety rule is the whole feature: a file is imported without a person
 * **only** when nothing about it needs one. These assert both halves — that a
 * clean file goes in, and that every kind of not-clean file is held instead.
 *
 * Database-backed, so they skip when no database is reachable, and they work in
 * their own throwaway organization.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { autoImport, blockingIssues } from '@/lib/import/auto-import';
import { prepareImport } from '@/lib/import/persist';
import { versionA, versionB, versionD, versionE, expected } from './fixtures/build';

const prisma = new PrismaClient();
const SLUG = 'test-auto-import';

const reachable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

let companyId = '';

beforeAll(async () => {
  if (!reachable) return;
  await cleanup();
  const org = await prisma.organization.create({ data: { name: 'Auto Org', slug: SLUG } });
  const company = await prisma.company.create({
    data: { organizationId: org.id, name: 'Auto Co', currency: 'INR' },
  });
  companyId = company.id;
});

afterAll(async () => {
  if (reachable) await cleanup();
  await prisma.$disconnect();
});

async function cleanup() {
  await prisma.organization.deleteMany({ where: { slug: SLUG } });
}

const suite = reachable ? describe : describe.skip;

const TOTALS = expected();

async function revenueTotal(): Promise<number> {
  const agg = await prisma.factEntry.aggregate({
    where: { companyId, kind: 'REVENUE' },
    _sum: { amount: true },
  });
  return Number(agg._sum.amount ?? 0);
}

suite('unattended import', () => {
  it('imports a clean export without asking anyone', async () => {
    const result = await autoImport(companyId, 'clean.xlsx', await versionA());

    expect(result.decision).toBe('IMPORTED');
    expect(result.importId).toBeTruthy();
    expect(result.totals!.revenue).toBeCloseTo(TOTALS.revenue, 2);
    expect(result.totals!.expense).toBeCloseTo(TOTALS.expense, 2);
  });

  it('imports CSV, and recognises the same bytes arriving twice', async () => {
    // A watched folder is scanned repeatedly, so the same file reappears. That
    // is normal, not an error, and must not re-run the import.
    //
    // CSV rather than xlsx on purpose: an xlsx zip stamps every entry with the
    // time it was written, so two builds of identical data are byte-identical
    // only when they land in the same second. Depending on that made this test
    // pass alone and fail under load. CSV generation is plain string building.
    const bytes = versionE();

    const first = await autoImport(companyId, 'export.csv', bytes);
    expect(first.decision).toBe('IMPORTED');

    const again = await autoImport(companyId, 'export-rescanned.csv', bytes);
    expect(again.decision).toBe('DUPLICATE');
    expect(again.reason).toContain('already imported');
    expect(again.importId).toBe(first.importId);
  });

  it('re-imports a fresh export of the same period instead of doubling it', async () => {
    // Different bytes, same figures — a re-export after a correction. Content
    // dedupe must not catch this, and the period must be replaced rather than
    // added to.
    const before = await revenueTotal();
    expect(before).toBeCloseTo(TOTALS.revenue, 2);

    const result = await autoImport(companyId, 'reordered-export.xlsx', await versionB());
    expect(result.decision).toBe('IMPORTED');

    // Still one period's worth of revenue, not two.
    expect(await revenueTotal()).toBeCloseTo(TOTALS.revenue, 2);
  });

  it('holds a file missing a dimension the MIS needs', async () => {
    const noBranch = Buffer.from(
      "Stream,Quater,Sales,Rent\nScience,Oct'25,1000,100\nCommerce,Oct'25,2000,200",
      'utf8',
    );
    const result = await autoImport(companyId, 'nobranch.csv', noBranch);

    expect(result.decision).toBe('HELD_FOR_REVIEW');
    expect(result.issues!.join(' ')).toContain('branch');
    // Held, not partially written.
    expect(result.importId).toBeUndefined();
  });

  it('holds a file it cannot recognise as financial data at all', async () => {
    const junk = Buffer.from('a,b,c\n1,2,3\n4,5,6', 'utf8');
    const result = await autoImport(companyId, 'junk.csv', junk);

    expect(result.decision).toBe('HELD_FOR_REVIEW');
    expect(result.issues!.length).toBeGreaterThan(0);
  });

  it('reports a file it cannot read at all rather than throwing', async () => {
    // A malformed file must not stop the rest of a batch.
    const result = await autoImport(companyId, 'broken.xlsx', Buffer.from('PK\x03\x04garbage'));

    expect(result.decision).toBe('FAILED');
    expect(result.reason).toContain('could not be read');
  });

  it('rejects the legacy .xls format with the reason, not a crash', async () => {
    const result = await autoImport(companyId, 'old.xls', Buffer.from('\xD0\xCF\x11\xE0'));

    expect(result.decision).toBe('FAILED');
    expect(result.reason).toContain('.xls');
  });

  it('still imports a messy but valid export — title rows, totals, formatted numbers', async () => {
    const result = await autoImport(companyId, 'messy.xlsx', await versionD());

    expect(result.decision).toBe('IMPORTED');
    expect(result.totals!.revenue).toBeCloseTo(TOTALS.revenue, 2);
  });

});

suite('the safety rule', () => {
  it('reports nothing blocking for a clean file', async () => {
    const prepared = await prepareImport(companyId, 'clean.xlsx', await versionA());
    expect(blockingIssues(prepared)).toEqual([]);
  });

  it('names a low-confidence column mapping as blocking', async () => {
    const prepared = await prepareImport(companyId, 'clean.xlsx', await versionA());

    // Force the condition the rule exists to catch.
    const sheet = prepared.analysis.sheets.find((s) => s.role === 'FACTS')!;
    sheet.mappings[0].needsConfirmation = true;
    sheet.mappings[0].confidence = 0.42;

    const issues = blockingIssues(prepared);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]).toContain('42%');
  });

  it('names a failed reconciliation as blocking', async () => {
    const prepared = await prepareImport(companyId, 'clean.xlsx', await versionA());

    prepared.reconciliation.status = 'FAIL';
    prepared.reconciliation.checks[0].status = 'FAIL';
    prepared.reconciliation.checks[0].difference = 1234.5;

    const issues = blockingIssues(prepared);
    expect(issues.join(' ')).toContain('1234.5');
  });

  it('every blocking issue tells the reader what to do', async () => {
    const noBranch = Buffer.from("Stream,Quater,Sales\nScience,Oct'25,1000", 'utf8');
    const prepared = await prepareImport(companyId, 'nobranch.csv', noBranch);

    const issues = blockingIssues(prepared);
    expect(issues.length).toBeGreaterThan(0);
    // Not just "invalid" — an instruction.
    for (const issue of issues) {
      expect(issue.length).toBeGreaterThan(40);
    }
  });
});

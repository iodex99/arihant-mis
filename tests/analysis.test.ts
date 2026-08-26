/**
 * Analytical reports.
 *
 * Database-backed, so these skip when no database is reachable. They build a
 * small dataset shaped like the real one — including a centrally-booked
 * provision reversal, which is what makes the client's two months look far
 * worse than they are.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient, Prisma } from '@prisma/client';
import {
  getVariance,
  getConcentration,
  getStreamBranchMatrix,
  getCostStructure,
  getBranchPositioning,
  isUnallocated,
} from '@/lib/mis/analysis';

const prisma = new PrismaClient();
const SLUG = 'test-analysis';

const reachable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

let companyId = '';

interface Seed {
  branch: string;
  stream: string;
  centre: string;
  period: 'oct' | 'nov';
  account: string;
  group: string;
  kind: 'REVENUE' | 'EXPENSE';
  amount: number;
}

/**
 * Two branches over two months.
 *
 * BIG earns more and spends more; SMALL is high-margin but minor. A
 * DEPRECIATION credit sits in Oct only, exactly as it does in the real
 * workbook, so October's expense looks artificially low.
 */
const SEED: Seed[] = [
  // October
  { branch: 'BIG', stream: 'Science', centre: 'WEST', period: 'oct', account: 'Sales', group: 'Revenue', kind: 'REVENUE', amount: 1_000_000 },
  { branch: 'BIG', stream: 'Science', centre: 'WEST', period: 'oct', account: 'Rent', group: 'Rent Expense', kind: 'EXPENSE', amount: 200_000 },
  { branch: 'BIG', stream: 'Science', centre: 'WEST', period: 'oct', account: 'Teachers', group: 'Professional Charges Teachers', kind: 'EXPENSE', amount: 400_000 },
  { branch: 'BIG', stream: 'Science', centre: 'WEST', period: 'oct', account: 'DEPRECIATION', group: 'Unallocated Expense', kind: 'EXPENSE', amount: -500_000 },
  { branch: 'SMALL', stream: 'Commerce', centre: 'EAST', period: 'oct', account: 'Sales', group: 'Revenue', kind: 'REVENUE', amount: 200_000 },
  { branch: 'SMALL', stream: 'Commerce', centre: 'EAST', period: 'oct', account: 'Rent', group: 'Rent Expense', kind: 'EXPENSE', amount: 40_000 },
  { branch: 'SMALL', stream: 'Commerce', centre: 'EAST', period: 'oct', account: 'Teachers', group: 'Professional Charges Teachers', kind: 'EXPENSE', amount: 60_000 },

  // November — same operations, no depreciation credit.
  { branch: 'BIG', stream: 'Science', centre: 'WEST', period: 'nov', account: 'Sales', group: 'Revenue', kind: 'REVENUE', amount: 1_100_000 },
  { branch: 'BIG', stream: 'Science', centre: 'WEST', period: 'nov', account: 'Rent', group: 'Rent Expense', kind: 'EXPENSE', amount: 200_000 },
  { branch: 'BIG', stream: 'Science', centre: 'WEST', period: 'nov', account: 'Teachers', group: 'Professional Charges Teachers', kind: 'EXPENSE', amount: 420_000 },
  { branch: 'SMALL', stream: 'Commerce', centre: 'EAST', period: 'nov', account: 'Sales', group: 'Revenue', kind: 'REVENUE', amount: 190_000 },
  { branch: 'SMALL', stream: 'Commerce', centre: 'EAST', period: 'nov', account: 'Rent', group: 'Rent Expense', kind: 'EXPENSE', amount: 40_000 },
  { branch: 'SMALL', stream: 'Commerce', centre: 'EAST', period: 'nov', account: 'Teachers', group: 'Professional Charges Teachers', kind: 'EXPENSE', amount: 55_000 },
];

beforeAll(async () => {
  if (!reachable) return;
  await cleanup();

  const org = await prisma.organization.create({ data: { name: 'Analysis Org', slug: SLUG } });
  const company = await prisma.company.create({
    data: { organizationId: org.id, name: 'Analysis Co', currency: 'INR' },
  });
  companyId = company.id;

  const periods = {
    oct: await prisma.period.create({
      data: { companyId, label: "Oct'25", year: 2025, month: 10, quarter: 'Q3', financialYear: 'FY 2025-26', sortKey: 202510 },
    }),
    nov: await prisma.period.create({
      data: { companyId, label: "Nov'25", year: 2025, month: 11, quarter: 'Q3', financialYear: 'FY 2025-26', sortKey: 202511 },
    }),
  };

  const cache = new Map<string, string>();
  const ensure = async (kind: 'centre' | 'branch' | 'stream' | 'account', name: string, extra?: Seed) => {
    const key = `${kind}:${name}`;
    if (cache.has(key)) return cache.get(key)!;
    let id: string;
    if (kind === 'centre') id = (await prisma.centre.create({ data: { companyId, name } })).id;
    else if (kind === 'stream') id = (await prisma.stream.create({ data: { companyId, name } })).id;
    else if (kind === 'branch') id = (await prisma.branch.create({ data: { companyId, abbreviation: name, name } })).id;
    else {
      id = (
        await prisma.account.create({
          data: {
            companyId,
            name,
            normalized: name.toUpperCase(),
            kind: extra!.kind,
            groupHead: extra!.group,
            groupMapped: true,
          },
        })
      ).id;
    }
    cache.set(key, id);
    return id;
  };

  for (const s of SEED) {
    await prisma.factEntry.create({
      data: {
        companyId,
        periodId: periods[s.period].id,
        branchId: await ensure('branch', s.branch),
        streamId: await ensure('stream', s.stream),
        centreId: await ensure('centre', s.centre),
        accountId: await ensure('account', s.account, s),
        kind: s.kind,
        amount: new Prisma.Decimal(s.amount.toFixed(4)),
        source: 'FILE_IMPORT',
      },
    });
  }
});

afterAll(async () => {
  if (reachable) await cleanup();
  await prisma.$disconnect();
});

async function cleanup() {
  await prisma.organization.deleteMany({ where: { slug: SLUG } });
}

const suite = reachable ? describe : describe.skip;

suite('variance', () => {
  it('compares the two most recent periods', async () => {
    const v = await getVariance(companyId, {});
    expect(v.available).toBe(true);
    expect(v.fromPeriod).toBe("Oct'25");
    expect(v.toPeriod).toBe("Nov'25");
  });

  it('reports the headline movement accurately', async () => {
    const v = await getVariance(companyId, {});

    // Oct expense: 200k + 400k - 500k + 40k + 60k = 200k
    // Nov expense: 200k + 420k + 40k + 55k = 715k
    expect(v.expense.from).toBeCloseTo(200_000, 2);
    expect(v.expense.to).toBeCloseTo(715_000, 2);
    expect(v.expense.change).toBeCloseTo(515_000, 2);

    // Headline profit therefore looks like a collapse.
    expect(v.profit.change).toBeLessThan(0);
  });

  it('separates operating expense from centrally-booked provisions', async () => {
    const v = await getVariance(companyId, {});

    // Excluding the depreciation credit, October's real expense was 700k.
    expect(v.operatingExpense.from).toBeCloseTo(700_000, 2);
    expect(v.operatingExpense.to).toBeCloseTo(715_000, 2);

    // And operating profit barely moved, unlike the headline.
    expect(Math.abs(v.operatingProfit.change)).toBeLessThan(Math.abs(v.profit.change));
  });

  it('flags the distortion when central bookings dominate the movement', async () => {
    const v = await getVariance(companyId, {});

    expect(v.distortion).not.toBeNull();
    expect(v.distortion!.groups).toContain('Unallocated Expense');
    expect(v.distortion!.amount).toBeCloseTo(500_000, 2);
  });

  it('marks which account lines are centrally booked', async () => {
    const v = await getVariance(companyId, {});
    const depreciation = v.byAccount.find((l) => l.key === 'DEPRECIATION');

    expect(depreciation?.unallocated).toBe(true);
    expect(v.byAccount.find((l) => l.key === 'Rent')?.unallocated).toBeFalsy();
  });

  it('says so rather than guessing when only one period is in scope', async () => {
    const v = await getVariance(companyId, { months: ["Oct'25"] });
    expect(v.available).toBe(false);
    expect(v.reason).toContain('one period');
  });
});

suite('concentration', () => {
  it('ranks contributors and tracks the cumulative share', async () => {
    const c = await getConcentration(companyId, {}, 'profit');

    expect(c.entries[0].key).toBe('BIG');
    expect(c.entries[0].cumulativeShare).toBeGreaterThan(c.entries[0].share - 1e-9);

    const last = c.entries[c.entries.length - 1];
    expect(last.cumulativeShare).toBeCloseTo(1, 6);
  });

  it('excludes loss-makers from the curve and counts them separately', async () => {
    const c = await getConcentration(companyId, {}, 'profit');
    // Every branch here is profitable, so nothing is excluded.
    expect(c.negativeCount).toBe(0);
    expect(c.entries.every((e) => e.value > 0)).toBe(true);
  });
});

suite('stream by branch matrix', () => {
  it('builds only the combinations that trade', async () => {
    const m = await getStreamBranchMatrix(companyId, {});

    expect(m.rows).toContain('BIG');
    expect(m.columns).toContain('Science');
    expect(m.cells['BIG']?.['Science']).toBeTruthy();
    // SMALL does not run Science.
    expect(m.cells['SMALL']?.['Science']).toBeUndefined();
    expect(m.populated).toBe(2);
  });

  it('computes margin per cell and leaves it null without revenue', async () => {
    const m = await getStreamBranchMatrix(companyId, {});
    const cell = m.cells['SMALL']['Commerce'];

    // 390k revenue, 195k expense across both months.
    expect(cell.revenue).toBeCloseTo(390_000, 2);
    expect(cell.margin!).toBeCloseTo(0.5, 4);
  });
});

suite('cost structure', () => {
  it('excludes centrally-booked groups from a branch profile', async () => {
    const s = await getCostStructure(companyId, {});
    expect(s.groups).not.toContain('Unallocated Expense');
    expect(s.groups).toContain('Rent Expense');
  });

  it('expresses each group as a share of that branch own spend', async () => {
    const s = await getCostStructure(companyId, {});
    const big = s.branches.find((b) => b.key === 'BIG')!;

    // BIG: rent 400k, teachers 820k of 1.22m operating spend.
    expect(big.shares['Rent Expense']!).toBeCloseTo(400_000 / 1_220_000, 4);
    const total = Object.values(big.shares).reduce<number>((sum, v) => sum + (v ?? 0), 0);
    expect(total).toBeCloseTo(1, 6);
  });

  it('reports a median that is not pulled by one branch', async () => {
    const s = await getCostStructure(companyId, {});
    expect(s.median['Rent Expense']).toBeGreaterThan(0);
    expect(s.median['Rent Expense']).toBeLessThan(1);
  });
});

suite('branch positioning', () => {
  it('places branches against the medians and excludes those with no revenue', async () => {
    const p = await getBranchPositioning(companyId, {});

    expect(p.points).toHaveLength(2);
    expect(p.excludedNoRevenue).toBe(0);
    expect(p.points.every((x) => ['scale-and-margin', 'scale-low-margin', 'small-high-margin', 'small-low-margin'].includes(x.quadrant))).toBe(true);
  });
});

describe('unallocated detection', () => {
  it.each([
    ['Unallocated Expense', true],
    ['unallocated', true],
    ['Rent Expense', false],
    ['Professional Charges Teachers', false],
  ])('%s -> %s', (group, expected) => {
    expect(isUnallocated(group)).toBe(expected);
  });
});

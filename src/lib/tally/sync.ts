/**
 * Tally sync engine.
 *
 * Read-only: vouchers are fetched and mapped into the same canonical FactEntry
 * rows the file importer produces, so the MIS cannot tell the two apart
 * (build spec §2, §48).
 *
 * Sync is incremental by date range. The default window starts at the last
 * successful sync, so a routine run pulls days rather than years.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { tallyLogger } from '../logger';
import { createAdapter, getConnectionConfig } from './index';
import { normalizeAccountName } from '../parser/values';
import { quarterFromMonth, financialYearFromMonth } from '../normalization/periods';
import type { Voucher } from './types';

export interface SyncOptions {
  from?: Date;
  to?: Date;
  trigger?: 'MANUAL' | 'SCHEDULED';
  userId?: string;
}

export interface SyncResult {
  syncRunId: string;
  status: 'SUCCESS' | 'FAILED' | 'PARTIAL';
  recordsProcessed: number;
  recordsAdded: number;
  message: string;
}

/** How far back a first-ever sync reaches when no window is given. */
const INITIAL_LOOKBACK_DAYS = 400;

export async function runSync(companyId: string, options: SyncOptions = {}): Promise<SyncResult> {
  const config = await getConnectionConfig(companyId);

  const run = await prisma.syncRun.create({
    data: {
      companyId,
      adapter: config.adapter,
      trigger: options.trigger ?? 'MANUAL',
      status: 'RUNNING',
      fromDate: options.from,
      toDate: options.to,
    },
  });

  const startedAt = Date.now();
  const log = tallyLogger.child({ syncRunId: run.id });

  try {
    if (!config.enabled) {
      throw new Error(
        'Tally sync is disabled. Enable it in Admin → Connection after the connection test succeeds against Arihant’s Tally installation.',
      );
    }

    const adapter = createAdapter(config);

    const status = await adapter.testConnection();
    if (!status.reachable) {
      throw new Error(status.message);
    }

    const to = options.to ?? new Date();
    const from = options.from ?? (await defaultSyncStart(companyId, to));

    await prisma.syncRun.update({ where: { id: run.id }, data: { fromDate: from, toDate: to } });

    log.info({ from, to }, 'fetching vouchers');
    const vouchers = await adapter.getVouchers({ from, to, companyName: config.companyName ?? undefined });

    const { added, failed } = await ingestVouchers(companyId, run.id, vouchers);

    const durationMs = Date.now() - startedAt;
    const status_ = failed > 0 ? 'PARTIAL' : 'SUCCESS';

    await prisma.syncRun.update({
      where: { id: run.id },
      data: {
        status: status_,
        recordsProcessed: vouchers.length,
        recordsAdded: added,
        recordsFailed: failed,
        finishedAt: new Date(),
        durationMs,
        details: { tallyVersion: status.version ?? null, latencyMs: status.latencyMs ?? null } as Prisma.InputJsonValue,
      },
    });

    await prisma.tallyConnection.updateMany({
      where: { companyId },
      data: { lastSuccessfulSyncAt: new Date(), detectedVersion: status.version ?? undefined },
    });

    return {
      syncRunId: run.id,
      status: status_,
      recordsProcessed: vouchers.length,
      recordsAdded: added,
      message:
        vouchers.length === 0
          ? `No vouchers found between ${from.toDateString()} and ${to.toDateString()}.`
          : `Processed ${vouchers.length} vouchers, created ${added} entries${failed > 0 ? `, ${failed} could not be mapped` : ''}.`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error({ err: message }, 'sync failed');

    await prisma.syncRun.update({
      where: { id: run.id },
      data: {
        status: 'FAILED',
        finishedAt: new Date(),
        durationMs: Date.now() - startedAt,
        errorMessage: message,
      },
    });

    await prisma.syncError.create({
      data: { syncRunId: run.id, stage: 'SYNC', code: 'SYNC_FAILED', message },
    });

    return {
      syncRunId: run.id,
      status: 'FAILED',
      recordsProcessed: 0,
      recordsAdded: 0,
      message,
    };
  }
}

/** Resume from the last successful sync, or fall back to a bounded lookback. */
async function defaultSyncStart(companyId: string, to: Date): Promise<Date> {
  const last = await prisma.syncRun.findFirst({
    where: { companyId, status: { in: ['SUCCESS', 'PARTIAL'] } },
    orderBy: { finishedAt: 'desc' },
    select: { toDate: true },
  });

  if (last?.toDate) {
    // Overlap by a day: vouchers back-dated after the previous run would
    // otherwise be missed entirely.
    return new Date(last.toDate.getTime() - 86_400_000);
  }

  return new Date(to.getTime() - INITIAL_LOOKBACK_DAYS * 86_400_000);
}

/**
 * Map vouchers into canonical facts.
 *
 * Tally supplies ledger-level detail the spreadsheet path cannot, so voucher
 * date, number, type and party are carried onto the fact. Branch and stream are
 * not concepts Tally exposes directly — they are derived from the ledger's
 * parent group, which is how Arihant's chart of accounts encodes them
 * ("Arihant Academy (CBSE) - Charkop (CKP)"). Where that cannot be parsed the
 * entry is recorded against an explicit "Unassigned" member rather than being
 * dropped or guessed.
 */
async function ingestVouchers(
  companyId: string,
  syncRunId: string,
  vouchers: Voucher[],
): Promise<{ added: number; failed: number }> {
  if (vouchers.length === 0) return { added: 0, failed: 0 };

  let added = 0;
  let failed = 0;

  for (const voucher of vouchers) {
    const date = parseTallyDate(voucher.date);
    if (!date) {
      failed += voucher.entries.length;
      await prisma.syncError.create({
        data: {
          syncRunId,
          stage: 'MAP',
          code: 'BAD_DATE',
          message: `Voucher ${voucher.voucherNumber ?? '(no number)'} has an unreadable date "${voucher.date}".`,
        },
      });
      continue;
    }

    const period = await upsertPeriod(companyId, date);

    for (const entry of voucher.entries) {
      const parsed = parseLedgerContext(entry.ledgerName);
      const branch = await upsertBranch(companyId, parsed.branch);
      const stream = await upsertStream(companyId, parsed.stream);
      const account = await upsertAccount(companyId, entry.ledgerName, entry.isDebit ? 'EXPENSE' : 'REVENUE');

      await prisma.factEntry.create({
        data: {
          companyId,
          periodId: period.id,
          branchId: branch.id,
          streamId: stream.id,
          accountId: account.id,
          kind: account.kind,
          amount: new Prisma.Decimal(entry.amount.toFixed(4)),
          source: 'TALLY_SYNC',
          syncRunId,
          voucherDate: date,
          voucherType: voucher.voucherType || null,
          voucherNumber: voucher.voucherNumber ?? null,
          ledgerName: entry.ledgerName,
          party: voucher.party ?? null,
          narration: voucher.narration ?? null,
        },
      });
      added++;
    }
  }

  return { added, failed };
}

/** `dd-MMM-yyyy` and `yyyyMMdd`, the two forms Tally exports. */
function parseTallyDate(value: string): Date | null {
  if (!value) return null;

  const compact = value.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) {
    return new Date(Date.UTC(Number(compact[1]), Number(compact[2]) - 1, Number(compact[3])));
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Pull branch and stream out of a ledger/group caption of the form
 * "Arihant Academy (CBSE) - Charkop (CKP)". Returns nulls when the caption does
 * not follow that shape — never a guess.
 */
export function parseLedgerContext(name: string): { stream: string | null; branch: string | null } {
  const m = name.match(/\(([^)]+)\)\s*-\s*(.+)$/);
  if (!m) return { stream: null, branch: null };

  const stream = m[1].trim();
  const branchPart = m[2].trim();
  const code = branchPart.match(/\(([^)]+)\)\s*$/);

  return { stream, branch: code ? code[1].trim() : branchPart };
}

async function upsertPeriod(companyId: string, date: Date) {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const label = `${date.toLocaleString('en-IN', { month: 'short', timeZone: 'UTC' })}'${String(year).slice(-2)}`;

  return prisma.period.upsert({
    where: { companyId_year_month: { companyId, year, month } },
    create: {
      companyId,
      label,
      year,
      month,
      quarter: quarterFromMonth(month),
      financialYear: financialYearFromMonth(year, month),
      sortKey: year * 100 + month,
    },
    update: {},
  });
}

async function upsertBranch(companyId: string, abbreviation: string | null) {
  const abbr = abbreviation ?? 'Unassigned';
  return prisma.branch.upsert({
    where: { companyId_abbreviation: { companyId, abbreviation: abbr } },
    create: {
      companyId,
      abbreviation: abbr,
      name: abbreviation ?? 'Unassigned (branch not identifiable from the ledger name)',
    },
    update: {},
  });
}

async function upsertStream(companyId: string, name: string | null) {
  const streamName = name ?? 'Unspecified';
  return prisma.stream.upsert({
    where: { companyId_name: { companyId, name: streamName } },
    create: { companyId, name: streamName },
    update: {},
  });
}

async function upsertAccount(companyId: string, name: string, kind: 'REVENUE' | 'EXPENSE') {
  const normalized = normalizeAccountName(name);

  // An admin mapping wins over the sign-derived guess.
  const rule = await prisma.mappingRule.findUnique({
    where: { companyId_ruleType_sourceValue: { companyId, ruleType: 'ACCOUNT_GROUP', sourceValue: normalized } },
  });

  return prisma.account.upsert({
    where: { companyId_normalized: { companyId, normalized } },
    create: {
      companyId,
      name: name.trim(),
      normalized,
      kind,
      groupHead: rule?.targetValue ?? 'Unclassified',
      groupMapped: Boolean(rule),
    },
    update: {},
  });
}

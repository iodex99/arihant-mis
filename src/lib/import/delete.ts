/**
 * Deleting an import.
 *
 * This removes financial records permanently, so the UI must be able to state
 * the consequence precisely before anything happens — which is what
 * `assessDeletion` is for.
 *
 * The consequence is not obvious. Committing an import *replaces* the
 * file-sourced facts for the periods it covers, so deleting the most recent
 * import does not roll back to the one before it: those facts were already
 * gone. A period ends up with no data at all unless a sync or a
 * different-period import still covers it. `periodsLeftEmpty` is the honest
 * answer to "what will I lose", and the dialog leads with it.
 */

import { unlink } from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '../db';
import { importLogger } from '../logger';

export interface DeletionImpact {
  importId: string;
  filename: string;
  uploadedAt: Date;
  uploadedBy: string | null;
  status: string;
  rowCount: number;
  factCount: number;
  /** Totals this import contributed, as reconciled at import time. */
  totals: { revenue: number; expense: number; profit: number } | null;
  /** Periods this import supplies facts for. */
  periods: { label: string; factCount: number }[];
  /**
   * Periods that will hold no data at all afterwards, because nothing else
   * covers them. This is the part that matters.
   */
  periodsLeftEmpty: string[];
  /** True when the whole MIS would be left with no data. */
  leavesNoData: boolean;
  /** Dimension members that exist only because of this import. */
  orphanedAccounts: number;
  orphanedBranches: number;
}

export async function assessDeletion(companyId: string, importId: string): Promise<DeletionImpact | null> {
  const record = await prisma.import.findFirst({
    where: { id: importId, companyId },
    include: {
      uploadedBy: { select: { name: true } },
      _count: { select: { rows: true, facts: true } },
    },
  });

  if (!record) return null;

  // Which periods this import supplies, and how much of each.
  const byPeriod = await prisma.factEntry.groupBy({
    by: ['periodId'],
    where: { importId },
    _count: { _all: true },
  });

  const periodIds = byPeriod.map((p) => p.periodId);
  const periodRows = await prisma.period.findMany({
    where: { id: { in: periodIds } },
    select: { id: true, label: true, sortKey: true },
    orderBy: { sortKey: 'asc' },
  });
  const labelById = new Map(periodRows.map((p) => [p.id, p.label]));

  // A period survives only if something other than this import covers it.
  const survivorCounts = await Promise.all(
    periodIds.map(async (periodId) => ({
      periodId,
      remaining: await prisma.factEntry.count({
        where: { companyId, periodId, importId: { not: importId } },
      }),
    })),
  );

  const periodsLeftEmpty = survivorCounts
    .filter((s) => s.remaining === 0)
    .map((s) => labelById.get(s.periodId) ?? 'unknown');

  const totalFacts = await prisma.factEntry.count({ where: { companyId } });

  // Accounts and branches referenced only by this import's facts.
  const [orphanedAccounts, orphanedBranches] = await Promise.all([
    countOrphans(companyId, importId, 'accountId'),
    countOrphans(companyId, importId, 'branchId'),
  ]);

  const validation = record.validation as { totals?: { revenue: number; expense: number; profit: number } } | null;

  return {
    importId: record.id,
    filename: record.filename,
    uploadedAt: record.finishedAt ?? record.startedAt,
    uploadedBy: record.uploadedBy?.name ?? null,
    status: record.status,
    rowCount: record._count.rows,
    factCount: record._count.facts,
    totals: validation?.totals ?? null,
    periods: byPeriod.map((p) => ({
      label: labelById.get(p.periodId) ?? 'unknown',
      factCount: p._count._all,
    })),
    periodsLeftEmpty,
    leavesNoData: totalFacts > 0 && totalFacts === record._count.facts,
    orphanedAccounts,
    orphanedBranches,
  };
}

/** Dimension members this import's facts reference that nothing else does. */
async function countOrphans(
  companyId: string,
  importId: string,
  field: 'accountId' | 'branchId',
): Promise<number> {
  const mine = await prisma.factEntry.groupBy({ by: [field], where: { importId } });
  const others = await prisma.factEntry.groupBy({
    by: [field],
    where: { companyId, importId: { not: importId } },
  });

  const elsewhere = new Set(others.map((o) => o[field]));
  return mine.filter((m) => !elsewhere.has(m[field])).length;
}

export interface DeletionResult {
  deleted: true;
  filename: string;
  factsRemoved: number;
  rowsRemoved: number;
  periodsLeftEmpty: string[];
  message: string;
}

/**
 * Delete an import and everything derived from it.
 *
 * Facts, raw rows, sheets and row summaries cascade from the `Import` row (see
 * prisma/schema.prisma). Dimension members are deliberately left in place: they
 * are shared across imports, and a branch that traded in a deleted period is
 * still a real branch. Removing them would also break the historical audit log.
 *
 * The audit entry records what the import contained, so the fact that it
 * existed and was removed survives the deletion itself. Recovery beyond that is
 * a database restore — see docs/backup-and-restore.md.
 */
export async function deleteImport(
  companyId: string,
  importId: string,
  userId: string,
): Promise<DeletionResult | null> {
  const impact = await assessDeletion(companyId, importId);
  if (!impact) return null;

  const files = await prisma.importFile.findMany({
    where: { importId },
    select: { storagePath: true },
  });

  await prisma.$transaction(async (tx) => {
    // Written before the delete, so the record survives it.
    await tx.auditLog.create({
      data: {
        userId,
        action: 'IMPORT_DELETED',
        entity: 'Import',
        entityId: importId,
        metadata: {
          filename: impact.filename,
          uploadedAt: impact.uploadedAt.toISOString(),
          rowCount: impact.rowCount,
          factCount: impact.factCount,
          totals: impact.totals ?? undefined,
          periods: impact.periods.map((p) => p.label),
          periodsLeftEmpty: impact.periodsLeftEmpty,
        },
      },
    });

    await tx.import.delete({ where: { id: importId } });
  });

  // Remove the stored original. Best-effort: a missing file must not fail a
  // deletion that has already succeeded in the database.
  for (const file of files) {
    if (!file.storagePath) continue;
    await unlink(path.resolve(file.storagePath)).catch(() => {});
  }

  importLogger.warn(
    {
      importId,
      filename: impact.filename,
      facts: impact.factCount,
      periodsLeftEmpty: impact.periodsLeftEmpty,
      userId,
    },
    'import deleted',
  );

  return {
    deleted: true,
    filename: impact.filename,
    factsRemoved: impact.factCount,
    rowsRemoved: impact.rowCount,
    periodsLeftEmpty: impact.periodsLeftEmpty,
    message:
      impact.periodsLeftEmpty.length > 0
        ? `Deleted ${impact.filename}. ${impact.periodsLeftEmpty.join(', ')} now ${impact.periodsLeftEmpty.length === 1 ? 'has' : 'have'} no data — re-import to restore ${impact.periodsLeftEmpty.length === 1 ? 'it' : 'them'}.`
        : `Deleted ${impact.filename}. ${impact.factCount.toLocaleString('en-IN')} entries removed; every period is still covered by other data.`,
  };
}

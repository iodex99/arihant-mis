/**
 * Unattended import.
 *
 * Arihant's Tally is a third-party hosted web application. There is no Tally
 * process on a machine we can reach, so the XML/HTTP adapter cannot apply and
 * the file path is not a fallback — it is the integration
 * (docs/tally-integration.md §3).
 *
 * This makes that path unattended: an export dropped in a folder, or pushed to
 * the ingest endpoint, is analysed and imported without anyone opening the
 * browser. The manual step becomes "save the export here".
 *
 * The safety rule is the whole point. A file is imported automatically **only**
 * when nothing about it needs a human: it parses without blockers, every column
 * maps confidently, and all five reconciliation identities hold. Anything else
 * is held for review rather than guessed at. An unattended importer that
 * silently accepted a file whose totals did not balance would be worse than no
 * automation at all.
 */

import { createHash } from 'node:crypto';
import { prisma } from '../db';
import { prepareImport, commitImport, type PreparedImport } from './persist';
import { importLogger } from '../logger';

export type AutoDecision = 'IMPORTED' | 'HELD_FOR_REVIEW' | 'DUPLICATE' | 'FAILED';

export interface AutoImportResult {
  filename: string;
  decision: AutoDecision;
  /** Why, in words an operator can act on. */
  reason: string;
  importId?: string;
  rowCount?: number;
  factCount?: number;
  totals?: { revenue: number; expense: number; profit: number };
  /** Populated when held: exactly what a human needs to resolve. */
  issues?: string[];
}

export interface AutoImportOptions {
  userId?: string;
  /** Import even when reconciliation fails. Off by default, and it should stay off. */
  force?: boolean;
}

/**
 * Decide whether a prepared file is safe to import without a human.
 * Returns the reasons it is not, empty when it is.
 */
export function blockingIssues(prepared: PreparedImport): string[] {
  const issues: string[] = [];

  for (const blocker of prepared.analysis.blockers) {
    issues.push(`${blocker.message}${blocker.remedy ? ` — ${blocker.remedy}` : ''}`);
  }

  for (const sheet of prepared.analysis.sheets) {
    if (sheet.role !== 'FACTS') continue;
    for (const mapping of sheet.mappings) {
      if (!mapping.needsConfirmation) continue;
      issues.push(
        `Column "${mapping.header}" in ${sheet.name} matched "${mapping.field}" with only ` +
          `${Math.round(mapping.confidence * 100)}% confidence and needs confirming.`,
      );
    }
  }

  if (prepared.reconciliation.status === 'FAIL') {
    for (const check of prepared.reconciliation.checks) {
      if (check.status !== 'FAIL') continue;
      issues.push(`${check.label} is off by ${check.difference}.`);
    }
  }

  return issues;
}

/**
 * Analyse a file and import it if nothing needs a human.
 *
 * Never throws for a bad file — a malformed export must not stop the rest of a
 * batch, so the problem is returned as a result.
 */
export async function autoImport(
  companyId: string,
  filename: string,
  buffer: Buffer,
  options: AutoImportOptions = {},
): Promise<AutoImportResult> {
  const log = importLogger.child({ scope: 'auto-import', filename });
  const fileHash = createHash('sha256').update(buffer).digest('hex');

  // The same bytes twice is the normal case for a folder that is scanned
  // repeatedly, not an error.
  const existing = await prisma.import.findFirst({
    where: { companyId, fileHash, status: { in: ['COMPLETED', 'NEEDS_REVIEW'] } },
    select: { id: true, filename: true, startedAt: true },
  });

  if (existing) {
    return {
      filename,
      decision: 'DUPLICATE',
      reason: `Identical content was already imported as "${existing.filename}" on ${existing.startedAt.toISOString().slice(0, 10)}.`,
      importId: existing.id,
    };
  }

  let prepared: PreparedImport;
  try {
    prepared = await prepareImport(companyId, filename, buffer);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn({ err: message }, 'could not read file');
    return {
      filename,
      decision: 'FAILED',
      reason: `The file could not be read: ${message}`,
    };
  }

  const issues = blockingIssues(prepared);

  if (issues.length > 0 && !options.force) {
    log.info({ issues: issues.length }, 'held for review');
    return {
      filename,
      decision: 'HELD_FOR_REVIEW',
      reason:
        issues.length === 1
          ? 'One thing needs a person to confirm it before this can be imported.'
          : `${issues.length} things need a person to confirm them before this can be imported.`,
      issues,
      rowCount: prepared.normalized.rows.length,
      totals: {
        revenue: prepared.reconciliation.totals.revenue,
        expense: prepared.reconciliation.totals.expense,
        profit: prepared.reconciliation.totals.profit,
      },
    };
  }

  const result = await commitImport(companyId, filename, buffer, prepared, {
    userId: options.userId,
    // Remember the mapping, so a recurring export gets easier rather than
    // needing the same confirmation every month.
    saveMapping: true,
  });

  log.info({ importId: result.importId, facts: result.factCount }, 'imported unattended');

  return {
    filename,
    decision: 'IMPORTED',
    reason: result.message,
    importId: result.importId,
    rowCount: result.rowCount,
    factCount: result.factCount,
    totals: {
      revenue: prepared.reconciliation.totals.revenue,
      expense: prepared.reconciliation.totals.expense,
      profit: prepared.reconciliation.totals.profit,
    },
  };
}

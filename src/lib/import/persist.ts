/**
 * Import persistence.
 *
 * Writes an analyzed + normalized workbook into the database inside one
 * transaction, so a failure part-way through leaves no half-imported period.
 *
 * Raw layer (import, sheets, rows) is written verbatim and never mutated
 * afterwards; the canonical layer (dimensions, facts) is derived from it.
 */

import { Prisma, type PrismaClient } from '@prisma/client';
import { prisma } from '../db';
import { analyzeWorkbook, type SavedProfile } from '../parser/analyze';
import { readFile } from '../parser/readers';
import { trimGrid } from '../parser/structure';
import { normalizeWorkbook, type NormalizationResult } from '../normalization/normalize';
import { reconcile, describeFailure, type ReconciliationResult } from '../normalization/reconcile';
import { sheetSignature } from '../parser/mapping';
import type { WorkbookAnalysis } from '../parser/types';
import { logger } from '../logger';

export interface PreparedImport {
  analysis: WorkbookAnalysis;
  normalized: NormalizationResult;
  reconciliation: ReconciliationResult;
  grids: Map<number, unknown[][]>;
}

/**
 * Analyze + normalize + reconcile without writing anything. This is what the
 * import preview screen shows (build spec §21).
 */
export async function prepareImport(
  companyId: string,
  filename: string,
  buffer: Buffer,
  overrides?: Record<string, string | null>,
): Promise<PreparedImport> {
  const savedProfiles = await loadSavedProfiles(companyId);
  const analysis = await analyzeWorkbook(filename, buffer, { savedProfiles, overrides });

  const grids = new Map<number, unknown[][]>();
  for (const g of await readFile(filename, buffer)) {
    grids.set(g.sheetIndex, trimGrid(g).rows);
  }

  const accountGroupOverrides = await loadAccountGroupOverrides(companyId);
  const normalized = normalizeWorkbook(analysis, grids, { accountGroupOverrides });
  const reconciliation = reconcile(normalized);

  return { analysis, normalized, reconciliation, grids };
}

async function loadSavedProfiles(companyId: string): Promise<SavedProfile[]> {
  const rows = await prisma.mappingProfile.findMany({
    where: { companyId, isActive: true },
    orderBy: { version: 'desc' },
  });
  return rows.map((r) => ({ id: r.id, name: r.name, version: r.version, signature: r.signature, mapping: r.mapping }));
}

async function loadAccountGroupOverrides(companyId: string): Promise<Map<string, string>> {
  const rules = await prisma.mappingRule.findMany({
    where: { companyId, ruleType: 'ACCOUNT_GROUP' },
  });
  return new Map(rules.map((r) => [r.sourceValue, r.targetValue]));
}

export interface CommitOptions {
  userId?: string;
  /** Persist the confirmed column mapping for reuse on the next upload. */
  saveMapping?: boolean;
  mappingProfileName?: string;
  /** Where the original file was stored, if it was kept. */
  storagePath?: string;
}

export interface CommitResult {
  importId: string;
  status: 'COMPLETED' | 'NEEDS_REVIEW';
  factCount: number;
  rowCount: number;
  message: string;
}

/**
 * Write a prepared import.
 *
 * Re-importing a period replaces that period's facts rather than adding to
 * them, so a corrected file supersedes the original instead of doubling every
 * figure. Previous *imports* are never deleted — the raw rows and their history
 * remain queryable (build spec §23).
 */
export async function commitImport(
  companyId: string,
  filename: string,
  buffer: Buffer,
  prepared: PreparedImport,
  options: CommitOptions = {},
): Promise<CommitResult> {
  const { analysis, normalized, reconciliation } = prepared;
  const log = logger.child({ scope: 'import', filename });

  const status = reconciliation.status === 'PASS' ? 'COMPLETED' : 'NEEDS_REVIEW';

  const importId = await prisma.$transaction(
    async (tx) => {
      const created = await tx.import.create({
        data: {
          companyId,
          filename,
          fileSize: buffer.byteLength,
          fileHash: analysis.fileHash,
          sourceType: 'FILE_IMPORT',
          status: 'IMPORTING',
          analysis: toJson(summariseAnalysis(analysis)),
          appliedMapping: toJson(extractMapping(analysis)),
          uploadedById: options.userId,
        },
      });

      if (options.storagePath) {
        await tx.importFile.create({
          data: { importId: created.id, filename, storagePath: options.storagePath, byteSize: buffer.byteLength },
        });
      }

      const sheetIds = await writeSheetsAndRows(tx, created.id, analysis, normalized);
      const dimensionIds = await upsertDimensions(tx, companyId, normalized);
      await replacePeriodFacts(tx, companyId, normalized, dimensionIds);
      const factCount = await writeFacts(tx, companyId, created.id, normalized, dimensionIds, sheetIds);
      await writeRowSummaries(tx, created.id, normalized, dimensionIds, sheetIds);

      if (options.saveMapping) {
        await saveMappingProfile(tx, companyId, analysis, options.mappingProfileName);
      }

      await tx.import.update({
        where: { id: created.id },
        data: {
          status,
          rowCount: normalized.rows.length,
          factCount,
          validationStatus: reconciliation.status,
          validation: toJson(reconciliation),
          errorMessage: describeFailure(reconciliation),
          finishedAt: new Date(),
        },
      });

      await tx.auditLog.create({
        data: {
          userId: options.userId,
          action: 'IMPORT_COMMITTED',
          entity: 'Import',
          entityId: created.id,
          metadata: toJson({
            filename,
            rows: normalized.rows.length,
            facts: factCount,
            reconciliation: reconciliation.status,
            totals: reconciliation.totals,
          }),
        },
      });

      return created.id;
    },
    // A full workbook is tens of thousands of rows; the default 5s is not
    // enough and a partial import would be worse than a slow one.
    { timeout: 180_000, maxWait: 20_000 },
  );

  log.info({ importId, status, facts: normalized.facts.length }, 'import committed');

  return {
    importId,
    status,
    factCount: normalized.facts.length,
    rowCount: normalized.rows.length,
    message:
      status === 'COMPLETED'
        ? `Imported ${normalized.rows.length} rows into ${normalized.facts.length} entries. All reconciliation checks passed.`
        : `Imported with warnings: ${describeFailure(reconciliation)}. Review before relying on these figures.`,
  };
}

type Tx = Prisma.TransactionClient;

async function writeSheetsAndRows(
  tx: Tx,
  importId: string,
  analysis: WorkbookAnalysis,
  normalized: NormalizationResult,
): Promise<Map<string, { sheetId: string; rowIds: Map<number, string> }>> {
  const out = new Map<string, { sheetId: string; rowIds: Map<number, string> }>();

  for (const sheet of analysis.sheets) {
    const created = await tx.importSheet.create({
      data: {
        importId,
        name: sheet.name,
        sheetIndex: sheet.sheetIndex,
        headerRow: sheet.headerRow,
        dataStartRow: sheet.dataStartRow,
        rowCount: sheet.rowCount,
        columnCount: sheet.columnCount,
        role: sheet.role,
        roleReason: sheet.roleReason,
        headers: toJson(sheet.headers),
      },
    });
    out.set(sheet.name, { sheetId: created.id, rowIds: new Map() });
  }

  // Only fact-sheet rows are stored individually; that is what drill-down and
  // reconciliation need.
  const rowsBySheet = new Map<string, typeof normalized.rows>();
  for (const row of normalized.rows) {
    const list = rowsBySheet.get(row.sheetName) ?? [];
    list.push(row);
    rowsBySheet.set(row.sheetName, list);
  }

  for (const [sheetName, rows] of rowsBySheet) {
    const entry = out.get(sheetName);
    if (!entry) continue;

    await tx.importRow.createMany({
      data: rows.map((r) => ({
        importId,
        sheetId: entry.sheetId,
        rowNumber: r.rowNumber,
        raw: toJson(r.raw) as Prisma.InputJsonValue,
      })),
    });

    const created = await tx.importRow.findMany({
      where: { sheetId: entry.sheetId },
      select: { id: true, rowNumber: true },
    });
    for (const c of created) entry.rowIds.set(c.rowNumber, c.id);
  }

  return out;
}

interface DimensionIds {
  periods: Map<string, string>;
  branches: Map<string, string>;
  streams: Map<string, string>;
  centres: Map<string, string>;
  accounts: Map<string, string>;
}

/**
 * Upsert dimensions. Existing members keep their id so historical facts stay
 * attached; only descriptive attributes are refreshed.
 */
async function upsertDimensions(
  tx: Tx,
  companyId: string,
  normalized: NormalizationResult,
): Promise<DimensionIds> {
  const ids: DimensionIds = {
    periods: new Map(),
    branches: new Map(),
    streams: new Map(),
    centres: new Map(),
    accounts: new Map(),
  };

  for (const [key, centre] of normalized.dimensions.centres) {
    const row = await tx.centre.upsert({
      where: { companyId_name: { companyId, name: centre.name } },
      create: { companyId, name: centre.name },
      update: {},
    });
    ids.centres.set(key, row.id);
  }

  for (const [key, stream] of normalized.dimensions.streams) {
    const row = await tx.stream.upsert({
      where: { companyId_name: { companyId, name: stream.name } },
      create: { companyId, name: stream.name },
      update: {},
    });
    ids.streams.set(key, row.id);
  }

  for (const [key, branch] of normalized.dimensions.branches) {
    const centreId = branch.centreKey ? (ids.centres.get(branch.centreKey) ?? null) : null;
    const row = await tx.branch.upsert({
      where: { companyId_abbreviation: { companyId, abbreviation: branch.abbreviation } },
      create: { companyId, abbreviation: branch.abbreviation, name: branch.name, centreId, status: branch.status },
      update: { name: branch.name, centreId, status: branch.status },
    });
    ids.branches.set(key, row.id);
  }

  for (const [key, period] of normalized.dimensions.periods) {
    const row = await tx.period.upsert({
      where: { companyId_year_month: { companyId, year: period.year, month: period.month } },
      create: {
        companyId,
        label: period.label,
        year: period.year,
        month: period.month,
        quarter: period.quarter,
        financialYear: period.financialYear,
        sortKey: period.sortKey,
        sourceQuarter: period.sourceQuarter,
      },
      update: { label: period.label, quarter: period.quarter, financialYear: period.financialYear, sourceQuarter: period.sourceQuarter },
    });
    ids.periods.set(key, row.id);
  }

  for (const [key, account] of normalized.dimensions.accounts) {
    const row = await tx.account.upsert({
      where: { companyId_normalized: { companyId, normalized: key } },
      create: {
        companyId,
        name: account.name,
        normalized: key,
        kind: account.kind,
        groupHead: account.groupHead,
        groupMapped: account.groupMapped,
        sortOrder: account.sortOrder,
      },
      // An admin may have reassigned the group; do not overwrite that with the
      // workbook's mapping on every re-import.
      update: { name: account.name, kind: account.kind },
    });
    ids.accounts.set(key, row.id);
  }

  return ids;
}

/**
 * Delete facts for the periods this import covers, so re-importing a corrected
 * file replaces rather than duplicates.
 */
async function replacePeriodFacts(
  tx: Tx,
  companyId: string,
  normalized: NormalizationResult,
  ids: DimensionIds,
): Promise<void> {
  const periodIds = [...normalized.dimensions.periods.keys()]
    .map((k) => ids.periods.get(k))
    .filter((id): id is string => Boolean(id));

  if (periodIds.length === 0) return;

  await tx.factEntry.deleteMany({
    where: { companyId, periodId: { in: periodIds }, source: 'FILE_IMPORT' },
  });
}

async function writeFacts(
  tx: Tx,
  companyId: string,
  importId: string,
  normalized: NormalizationResult,
  ids: DimensionIds,
  sheets: Map<string, { sheetId: string; rowIds: Map<number, string> }>,
): Promise<number> {
  const data: Prisma.FactEntryCreateManyInput[] = [];

  for (const fact of normalized.facts) {
    const row = normalized.rows[fact.rowRef];
    const periodId = ids.periods.get(fact.periodKey);
    const branchId = ids.branches.get(fact.branchKey);
    const streamId = ids.streams.get(fact.streamKey);
    const accountId = ids.accounts.get(fact.accountKey);
    if (!periodId || !branchId || !streamId || !accountId) continue;

    data.push({
      companyId,
      periodId,
      branchId,
      streamId,
      centreId: fact.centreKey ? (ids.centres.get(fact.centreKey) ?? null) : null,
      accountId,
      kind: fact.kind,
      amount: new Prisma.Decimal(fact.amount.toFixed(4)),
      source: 'FILE_IMPORT',
      importId,
      importRowId: row ? (sheets.get(row.sheetName)?.rowIds.get(row.rowNumber) ?? null) : null,
    });
  }

  // Chunked so a large workbook does not build one enormous statement.
  const CHUNK = 5000;
  for (let i = 0; i < data.length; i += CHUNK) {
    await tx.factEntry.createMany({ data: data.slice(i, i + CHUNK) });
  }

  return data.length;
}

async function writeRowSummaries(
  tx: Tx,
  importId: string,
  normalized: NormalizationResult,
  ids: DimensionIds,
  sheets: Map<string, { sheetId: string; rowIds: Map<number, string> }>,
): Promise<void> {
  const data: Prisma.SourceRowSummaryCreateManyInput[] = [];

  for (const row of normalized.rows) {
    const importRowId = sheets.get(row.sheetName)?.rowIds.get(row.rowNumber);
    const periodId = ids.periods.get(row.periodKey);
    const branchId = ids.branches.get(row.branchKey);
    const streamId = ids.streams.get(row.streamKey);
    if (!importRowId || !periodId || !branchId || !streamId) continue;
    if (row.reported.revenue === null && row.reported.expense === null && row.reported.profit === null) continue;

    data.push({
      importId,
      importRowId,
      periodId,
      branchId,
      streamId,
      totalIncome: new Prisma.Decimal((row.reported.revenue ?? 0).toFixed(4)),
      totalExpense: new Prisma.Decimal((row.reported.expense ?? 0).toFixed(4)),
      profit: new Prisma.Decimal((row.reported.profit ?? 0).toFixed(4)),
      totalRevenue: row.reported.totalRevenue === null ? null : new Prisma.Decimal(row.reported.totalRevenue.toFixed(4)),
      indirectExpenses: row.reported.indirectExpenses === null ? null : new Prisma.Decimal(row.reported.indirectExpenses.toFixed(4)),
    });
  }

  const CHUNK = 5000;
  for (let i = 0; i < data.length; i += CHUNK) {
    await tx.sourceRowSummary.createMany({ data: data.slice(i, i + CHUNK) });
  }
}

async function saveMappingProfile(
  tx: Tx,
  companyId: string,
  analysis: WorkbookAnalysis,
  name?: string,
): Promise<void> {
  const profileName = name ?? 'Arihant export profile';
  const latest = await tx.mappingProfile.findFirst({
    where: { companyId, name: profileName },
    orderBy: { version: 'desc' },
  });

  const mapping = extractMapping(analysis);
  const signature = analysis.signature;

  // Nothing changed — keep the existing version rather than churning.
  if (latest && latest.signature === signature) return;

  await tx.mappingProfile.create({
    data: {
      companyId,
      name: profileName,
      version: (latest?.version ?? 0) + 1,
      signature,
      mapping: toJson(mapping) as Prisma.InputJsonValue,
    },
  });
}

function extractMapping(analysis: WorkbookAnalysis) {
  return analysis.sheets
    .filter((s) => s.role !== 'SKIPPED')
    .map((s) => ({
      sheet: s.name,
      role: s.role,
      layout: s.layout,
      headerRow: s.headerRow,
      signature: sheetSignature(s.name, s.headers),
      columns: s.mappings
        .filter((m) => m.field || m.role === 'account-measure' || m.role === 'subtotal')
        .map((m) => ({ header: m.header, field: m.field, role: m.role, confidence: m.confidence })),
    }));
}

/** Trim the analysis to what is worth storing and rendering. */
function summariseAnalysis(analysis: WorkbookAnalysis) {
  return {
    filename: analysis.filename,
    fileHash: analysis.fileHash,
    fileSize: analysis.fileSize,
    signature: analysis.signature,
    warnings: analysis.warnings,
    blockers: analysis.blockers,
    matchedProfile: analysis.matchedProfile,
    sheets: analysis.sheets.map((s) => ({
      name: s.name,
      role: s.role,
      roleReason: s.roleReason,
      layout: s.layout,
      headerRow: s.headerRow,
      dataStartRow: s.dataStartRow,
      rowCount: s.rowCount,
      columnCount: s.columnCount,
      totalRowNumbers: s.totalRowNumbers.slice(0, 50),
      warnings: s.warnings,
      mappings: s.mappings.map((m) => ({
        header: m.header,
        field: m.field,
        role: m.role,
        confidence: m.confidence,
        reasons: m.reasons,
        needsConfirmation: m.needsConfirmation,
        alternatives: m.alternatives,
        accountName: m.accountName,
        accountKind: m.accountKind,
      })),
      columns: s.columns.map((c) => ({
        index: c.index,
        header: c.header,
        kind: c.kind,
        nonEmpty: c.stats.nonEmpty,
        distinct: c.stats.distinct,
        samples: c.stats.samples.slice(0, 5),
        sum: c.stats.sum,
      })),
    })),
  };
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

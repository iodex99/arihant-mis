/**
 * Import every export dropped in a folder.
 *
 * Arihant's Tally is a hosted web application, so the MIS cannot pull from it —
 * the export has to come out of that product and in through this door. Run from
 * cron; see docs/tally-integration.md.
 *
 *   npm run ingest                  # process INGEST_DIR
 *   npm run ingest -- --dry-run     # report what would happen, change nothing
 *   npm run ingest -- --dir /mnt/tally-exports
 *
 * A file is imported only when nothing about it needs a person: it parses
 * cleanly, every column maps confidently, and all five reconciliation
 * identities hold. Anything else moves to `needs-review/` with the reasons
 * written beside it, and waits.
 *
 * Source files are moved, never deleted, so a wrong decision is always
 * recoverable from disk as well as from the database.
 */

import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '../src/lib/db';
import { getActiveCompany } from '../src/lib/company';
import { autoImport, type AutoImportResult } from '../src/lib/import/auto-import';

const EXTENSIONS = new Set(['.xlsx', '.xlsm', '.csv', '.tsv']);

/** Files still being written are skipped until they stop changing. */
const SETTLE_MS = 30_000;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const root = arg('dir') ?? process.env.INGEST_DIR ?? './uploads/inbox';

  const dirs = {
    inbox: root,
    imported: path.join(root, 'imported'),
    review: path.join(root, 'needs-review'),
  };

  for (const dir of Object.values(dirs)) await mkdir(dir, { recursive: true });

  const company = await getActiveCompany();
  if (!company) throw new Error('No company is configured. Run the seed-admin command first.');

  const entries = await readdir(dirs.inbox, { withFileTypes: true });
  const candidates: string[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    // Exports written by another process may still be in flight.
    const info = await stat(path.join(dirs.inbox, entry.name));
    if (Date.now() - info.mtimeMs < SETTLE_MS) {
      console.log(`  skipping ${entry.name} — modified in the last 30s, may still be copying`);
      continue;
    }
    candidates.push(entry.name);
  }

  console.log(`Ingest folder: ${path.resolve(dirs.inbox)}`);
  console.log(`${candidates.length} file${candidates.length === 1 ? '' : 's'} to consider${dryRun ? ' (dry run)' : ''}\n`);

  if (candidates.length === 0) return;

  const results: AutoImportResult[] = [];

  for (const name of candidates.sort()) {
    const full = path.join(dirs.inbox, name);
    const buffer = await readFile(full);

    const result = dryRun
      ? await previewOnly(company.id, name, buffer)
      : await autoImport(company.id, name, buffer);

    results.push(result);
    report(result);

    if (dryRun) continue;

    // Move the file where its outcome says it belongs. Never delete it.
    const destination =
      result.decision === 'IMPORTED' || result.decision === 'DUPLICATE' ? dirs.imported : dirs.review;

    await rename(full, path.join(destination, stamped(name)));

    if (result.decision === 'HELD_FOR_REVIEW' || result.decision === 'FAILED') {
      await writeFile(
        path.join(destination, `${stamped(name)}.txt`),
        [
          `File:     ${result.filename}`,
          `Decision: ${result.decision}`,
          `Reason:   ${result.reason}`,
          '',
          ...(result.issues ?? []).map((issue, i) => `  ${i + 1}. ${issue}`),
          '',
          'Upload this file through Imports -> Upload a file to resolve it there.',
        ].join('\n'),
        'utf8',
      );
    }
  }

  const counts = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.decision] = (acc[r.decision] ?? 0) + 1;
    return acc;
  }, {});

  console.log(
    '\n' +
      Object.entries(counts)
        .map(([decision, n]) => `${n} ${decision.toLowerCase().replace(/_/g, ' ')}`)
        .join(', '),
  );

  // Non-zero exit when something needs attention, so cron reports it.
  if ((counts.HELD_FOR_REVIEW ?? 0) + (counts.FAILED ?? 0) > 0) process.exitCode = 1;
}

/** Dry run: everything except the write. */
async function previewOnly(companyId: string, filename: string, buffer: Buffer): Promise<AutoImportResult> {
  const { prepareImport } = await import('../src/lib/import/persist');
  const { blockingIssues } = await import('../src/lib/import/auto-import');

  try {
    const prepared = await prepareImport(companyId, filename, buffer);
    const issues = blockingIssues(prepared);
    return {
      filename,
      decision: issues.length === 0 ? 'IMPORTED' : 'HELD_FOR_REVIEW',
      reason: issues.length === 0 ? 'Would import — nothing needs confirming.' : 'Would be held for review.',
      issues: issues.length > 0 ? issues : undefined,
      rowCount: prepared.normalized.rows.length,
      totals: {
        revenue: prepared.reconciliation.totals.revenue,
        expense: prepared.reconciliation.totals.expense,
        profit: prepared.reconciliation.totals.profit,
      },
    };
  } catch (error) {
    return {
      filename,
      decision: 'FAILED',
      reason: `The file could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function report(r: AutoImportResult) {
  const money = (n?: number) =>
    n === undefined ? '' : n.toLocaleString('en-IN', { maximumFractionDigits: 0 });

  console.log(`  ${r.decision.padEnd(16)} ${r.filename}`);
  console.log(`  ${''.padEnd(16)} ${r.reason}`);
  if (r.totals) {
    console.log(
      `  ${''.padEnd(16)} revenue ${money(r.totals.revenue)}  expense ${money(r.totals.expense)}  profit ${money(r.totals.profit)}`,
    );
  }
  for (const issue of r.issues ?? []) console.log(`  ${''.padEnd(16)} - ${issue}`);
  console.log();
}

/** Prefix with a timestamp so re-dropping the same filename never overwrites. */
function stamped(name: string): string {
  // yyyymmddhhmmss — 14 chars. Slicing 15 kept the dot before the milliseconds.
  const now = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `${now}-${name}`;
}

main()
  .catch((error) => {
    console.error('Ingest failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

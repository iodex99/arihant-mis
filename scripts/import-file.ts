/**
 * Import a spreadsheet from the command line — the same code path the web
 * uploader uses.
 *
 *   npm run import:file -- "for reference/Arihant.xlsx"
 *   npm run import:file -- file.xlsx --dry-run
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { prisma } from '../src/lib/db';
import { prepareImport, commitImport } from '../src/lib/import/persist';

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error('Usage: npm run import:file -- <path-to-file> [--dry-run]');
  const dryRun = process.argv.includes('--dry-run');

  const company = await prisma.company.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!company) throw new Error('No company found. Run `npm run seed:admin` first.');

  const buffer = readFileSync(file);
  const filename = path.basename(file);

  console.log(`Analyzing ${filename} ...`);
  const prepared = await prepareImport(company.id, filename, buffer);

  for (const s of prepared.analysis.sheets) {
    console.log(`  ${s.name.padEnd(14)} ${s.role.padEnd(8)} ${s.rowCount} rows — ${s.roleReason || 'n/a'}`);
  }
  for (const w of [...prepared.analysis.warnings, ...prepared.normalized.warnings]) {
    console.log(`  [${w.severity}] ${w.code}: ${w.message}`);
  }
  if (prepared.analysis.blockers.length > 0) {
    for (const b of prepared.analysis.blockers) console.error(`  BLOCKER ${b.code}: ${b.message}`);
    process.exitCode = 1;
    return;
  }

  console.log('\nReconciliation:');
  for (const c of prepared.reconciliation.checks) {
    console.log(`  ${c.status.padEnd(8)} ${c.label}`);
  }
  const t = prepared.reconciliation.totals;
  const f = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  console.log(`\n  Revenue ${f(t.revenue)}   Expense ${f(t.expense)}   Profit ${f(t.profit)}   Facts ${t.factCount}`);

  if (dryRun) {
    console.log('\nDry run — nothing written.');
    return;
  }

  console.log('\nCommitting ...');
  const result = await commitImport(company.id, filename, buffer, prepared, { saveMapping: true });
  console.log(`  ${result.status}: ${result.message}`);
  console.log(`  import id ${result.importId}`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());

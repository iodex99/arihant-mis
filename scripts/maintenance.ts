/**
 * Periodic housekeeping.
 *
 * Run from cron on the server — see docs/deployment.md. There is deliberately
 * no in-process scheduler: the app runs in a container that may be restarted or
 * scaled, and a timer inside it would run zero times or several, depending on
 * how many copies happen to be up.
 *
 *   npm run maintenance            # do the work
 *   npm run maintenance -- --dry-run
 *
 * Everything here is safe to run repeatedly and touches only derived artefacts:
 * original uploaded files past their retention window, abandoned staging files,
 * and expired sessions. **No financial record is ever removed** — parsed rows,
 * facts, imports and the audit log are kept indefinitely.
 */

import { prisma } from '../src/lib/db';
import { pruneStoredFiles, sweepStaging } from '../src/lib/import/storage';
import { pruneSessions } from '../src/lib/auth';
import { logger } from '../src/lib/logger';

const dryRun = process.argv.includes('--dry-run');

async function main() {
  const retentionDays = Number(process.env.UPLOAD_RETENTION_DAYS ?? 180);
  const log = logger.child({ scope: 'maintenance' });

  console.log(dryRun ? 'Maintenance (dry run — nothing will be removed)\n' : 'Maintenance\n');

  // 1. Abandoned staging files: uploads analysed but never confirmed.
  const swept = dryRun ? 0 : await sweepStaging();
  console.log(`  staging files swept:        ${swept}`);

  // 2. Original uploaded files past the retention window. The parsed rows and
  //    every figure derived from them are untouched — only the source file goes.
  const pruned = dryRun ? [] : await pruneStoredFiles(retentionDays);
  console.log(`  source files pruned:        ${pruned.length}  (retention ${retentionDays} days)`);
  for (const name of pruned.slice(0, 10)) console.log(`    - ${name}`);
  if (pruned.length > 10) console.log(`    … and ${pruned.length - 10} more`);

  // 3. Expired sessions.
  const sessions = dryRun ? 0 : await pruneSessions();
  console.log(`  expired sessions removed:   ${sessions}`);

  // What is deliberately never pruned, stated so nobody goes looking.
  const [facts, imports, rows, audit] = await Promise.all([
    prisma.factEntry.count(),
    prisma.import.count(),
    prisma.importRow.count(),
    prisma.auditLog.count(),
  ]);

  console.log('\n  retained indefinitely:');
  console.log(`    entries      ${facts.toLocaleString('en-IN')}`);
  console.log(`    imports      ${imports.toLocaleString('en-IN')}`);
  console.log(`    source rows  ${rows.toLocaleString('en-IN')}`);
  console.log(`    audit log    ${audit.toLocaleString('en-IN')}`);

  if (!dryRun) {
    log.info({ swept, pruned: pruned.length, sessions, retentionDays }, 'maintenance complete');
  }
}

main()
  .catch((error) => {
    console.error('Maintenance failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

/**
 * Scheduled Tally sync.
 *
 * Run from cron on the server — see docs/tally-integration.md. As with
 * maintenance, there is no in-process scheduler: the app is containerised, and
 * a timer inside it would fire once per running copy.
 *
 *   npm run sync:tally
 *   npm run sync:tally -- --from 2026-04-01 --to 2026-04-30
 *
 * Refuses to run unless `TALLY_SYNC_ENABLED=true` **and** the connection is
 * enabled in Admin → Connection, so a cron entry left in place cannot start
 * hammering a Tally installation that is not ready for it.
 *
 * Read-only, like every other Tally path.
 */

import { prisma } from '../src/lib/db';
import { getActiveCompany } from '../src/lib/company';
import { getConnectionConfig } from '../src/lib/tally';
import { runSync } from '../src/lib/tally/sync';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function parseDate(value: string | undefined, label: string): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`--${label} is not a valid date: "${value}". Use YYYY-MM-DD.`);
  }
  return d;
}

async function main() {
  if (process.env.TALLY_SYNC_ENABLED !== 'true') {
    console.log(
      'Scheduled sync is off (TALLY_SYNC_ENABLED is not "true"). Nothing was done.\n' +
        'Set it in .env once the connection test succeeds against the Tally machine.',
    );
    return;
  }

  const company = await getActiveCompany();
  if (!company) {
    throw new Error('No company is configured. Run `npm run seed:admin` first.');
  }

  const config = await getConnectionConfig(company.id);
  if (!config.enabled) {
    console.log(
      'The Tally connection is disabled in Admin → Connection, so the scheduled sync was skipped.\n' +
        'Test the connection there and enable it before scheduling.',
    );
    return;
  }

  const from = parseDate(arg('from'), 'from');
  const to = parseDate(arg('to'), 'to');

  console.log(`Syncing from Tally (${config.adapter} at ${config.host}:${config.port}) …`);

  const result = await runSync(company.id, { from, to, trigger: 'SCHEDULED' });

  console.log(`  ${result.status}: ${result.message}`);
  console.log(`  sync run ${result.syncRunId}`);

  // A non-zero exit lets cron mail the failure rather than swallowing it.
  if (result.status === 'FAILED') process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error('Sync failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

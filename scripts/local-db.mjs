/**
 * Local development PostgreSQL.
 *
 * Production runs PostgreSQL in Docker (see docker-compose.yml). This script
 * exists only so a developer on a machine without Docker can still run the
 * full stack: it downloads real PostgreSQL binaries and runs them against a
 * data directory under ./.pgdata.
 *
 *   node scripts/local-db.mjs start   # start and stay in the foreground
 *   node scripts/local-db.mjs stop    # stop a detached instance
 *
 * It is never used in production and is a devDependency only.
 */

import EmbeddedPostgres from 'embedded-postgres';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve('.pgdata');
const PORT = Number(process.env.LOCAL_DB_PORT ?? 55432);
const USER = 'arihant';
const PASSWORD = 'arihant_local_dev';
const DATABASE = 'arihant_mis';

const command = process.argv[2] ?? 'start';

const pg = new EmbeddedPostgres({
  databaseDir: DATA_DIR,
  user: USER,
  password: PASSWORD,
  port: PORT,
  persistent: true,
  // Must match docker-compose.yml. Without this, initdb on Windows creates a
  // WIN1252 cluster, and every non-ASCII character — the rupee sign, a curly
  // quote, an arrow in an error message, any Devanagari in a branch name —
  // fails to write with "no equivalent in encoding WIN1252". Production would
  // have been fine and only development broken, which is the worst way round:
  // the bug would not surface until real data hit the real server.
  initdbFlags: ['--encoding=UTF8', '--locale=C'],
});

async function start() {
  const fresh = !existsSync(DATA_DIR);
  if (fresh) {
    console.log(`Initialising a new PostgreSQL cluster in ${DATA_DIR} ...`);
    await pg.initialise();
  }

  await pg.start();

  if (fresh) {
    await pg.createDatabase(DATABASE);
  }

  const url = `postgresql://${USER}:${PASSWORD}@localhost:${PORT}/${DATABASE}`;
  console.log('\nPostgreSQL is running.');
  console.log(`  DATABASE_URL="${url}"\n`);
  console.log('Add that line to .env, then in another terminal:');
  console.log('  npx prisma migrate dev');
  console.log('  npm run seed:admin');
  console.log('  npm run dev\n');
  console.log('Press Ctrl+C to stop.');

  const shutdown = async () => {
    console.log('\nStopping PostgreSQL ...');
    try {
      await pg.stop();
    } catch {
      // Already gone; nothing to do.
    }
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Hold the process open.
  await new Promise(() => {});
}

async function stop() {
  await pg.stop();
  console.log('PostgreSQL stopped.');
}

function reset() {
  if (existsSync(DATA_DIR)) {
    rmSync(DATA_DIR, { recursive: true, force: true });
    console.log(`Removed ${DATA_DIR}. The next start will create a fresh cluster.`);
  } else {
    console.log('Nothing to remove.');
  }
}

switch (command) {
  case 'start':
    await start();
    break;
  case 'stop':
    await stop();
    break;
  case 'reset':
    reset();
    break;
  default:
    console.error(`Unknown command "${command}". Use start | stop | reset.`);
    process.exit(1);
}

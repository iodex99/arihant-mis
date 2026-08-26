/**
 * Temporary staging for an uploaded file between analysis and confirmation.
 *
 * The preview step must not re-upload the file, and must analyse exactly the
 * bytes that get committed. Files land under UPLOAD_DIR/staging keyed by their
 * content hash, and are moved to UPLOAD_DIR on commit or swept if abandoned.
 */

import { mkdir, readFile, rename, stat, unlink, readdir } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.env.UPLOAD_DIR ?? './uploads';
const STAGING = path.join(ROOT, 'staging');

/** Abandoned staged files older than this are swept. */
const STAGING_TTL_MS = 6 * 60 * 60 * 1000;

export async function stageFile(hash: string, filename: string, buffer: Buffer): Promise<string> {
  await mkdir(STAGING, { recursive: true });
  const target = path.join(STAGING, `${hash}${path.extname(filename)}`);
  await writeFile(target, buffer);
  return target;
}

export async function readStagedFile(stagedPath: string): Promise<Buffer> {
  // Never read outside the staging directory, whatever the client sends.
  const resolved = path.resolve(stagedPath);
  if (!resolved.startsWith(path.resolve(STAGING))) {
    throw new Error('Refusing to read a file outside the staging directory.');
  }
  return readFile(resolved);
}

/** Move a staged file into permanent storage once its import is committed. */
export async function keepFile(stagedPath: string, importId: string): Promise<string> {
  const dir = path.join(ROOT, 'imports');
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, `${importId}${path.extname(stagedPath)}`);
  await rename(path.resolve(stagedPath), target);
  return target;
}

export async function discardStaged(stagedPath: string): Promise<void> {
  await unlink(path.resolve(stagedPath)).catch(() => {});
}

/** Remove staged files nobody came back to confirm. */
export async function sweepStaging(now = Date.now()): Promise<number> {
  let removed = 0;
  const entries = await readdir(STAGING).catch(() => [] as string[]);
  for (const name of entries) {
    const full = path.join(STAGING, name);
    const info = await stat(full).catch(() => null);
    if (info && now - info.mtimeMs > STAGING_TTL_MS) {
      await unlink(full).catch(() => {});
      removed++;
    }
  }
  return removed;
}

/**
 * Delete stored source files past the retention window. Parsed rows and all MIS
 * figures are unaffected — only the original files are pruned (build spec §32).
 */
export async function pruneStoredFiles(retentionDays: number, now = Date.now()): Promise<string[]> {
  const dir = path.join(ROOT, 'imports');
  const cutoff = now - retentionDays * 86_400_000;
  const removed: string[] = [];

  const entries = await readdir(dir).catch(() => [] as string[]);
  for (const name of entries) {
    const full = path.join(dir, name);
    const info = await stat(full).catch(() => null);
    if (info && info.mtimeMs < cutoff) {
      await unlink(full).catch(() => {});
      removed.push(name);
    }
  }
  return removed;
}

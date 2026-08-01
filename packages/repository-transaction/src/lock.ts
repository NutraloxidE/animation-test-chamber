/**
 * Repository write lock (PLAN Part I §8). Exclusive-create is the only atomic
 * primitive this relies on; everything else — staleness, takeover — is built
 * on top of it, not instead of it.
 */
import { hostname as osHostname } from 'node:os';
import { join } from 'node:path';
import type { FilesystemOps } from './filesystem.ts';
import { WRITE_LOCK_FILE, readJournal, transactionDir, transactionRootDir } from './journal.ts';
import { rollbackTransaction } from './rollback.ts';
import type { WriteLockPayload } from './types.ts';

export interface LockDependencies {
  now: () => string;
  isProcessAlive: (pid: number, hostname: string) => boolean;
  staleLockAfterMs: number;
}

export function defaultIsProcessAlive(pid: number, hostname: string): boolean {
  if (hostname !== osHostname()) return true; // cannot check a remote host; assume alive
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function encodeLock(payload: WriteLockPayload): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(payload, null, 2));
}

function decodeLock(bytes: Uint8Array): WriteLockPayload {
  return JSON.parse(new TextDecoder().decode(bytes)) as WriteLockPayload;
}

export type LockAcquisition =
  | { acquired: true }
  | {
      acquired: false;
      /**
       * `held` is ordinary contention and the caller may retry. An
       * `unresolved-transaction` is not contention at all: the lock belongs to
       * a transaction whose outcome nobody can establish, and taking it over
       * would mean writing on top of a repository in an unknown state.
       */
      reason: 'held' | 'unresolved-transaction';
    };

/**
 * Acquires the repository write lock, taking over a stale one (dead process,
 * old enough) after resolving whatever transaction it was holding. A lock that
 * is merely held past some ordinary wait time is *not* stale — that returns a
 * refusal for the caller to surface as a conflict, per plan §8.
 */
export function acquireWriteLock(
  fs: FilesystemOps,
  repoRoot: string,
  payload: WriteLockPayload,
  deps: LockDependencies,
): LockAcquisition {
  const rootDir = transactionRootDir(repoRoot);
  fs.mkdirRecursive(rootDir);
  const lockPath = join(rootDir, WRITE_LOCK_FILE);

  if (fs.createExclusive(lockPath, encodeLock(payload))) {
    return { acquired: true };
  }

  const existingBytes = fs.readFileIfExists(lockPath);
  if (!existingBytes) {
    if (fs.createExclusive(lockPath, encodeLock(payload))) return { acquired: true };
    return { acquired: false, reason: 'held' };
  }

  const existing = decodeLock(existingBytes);
  const ageMs = Date.parse(deps.now()) - Date.parse(existing.createdAt);
  const alive = deps.isProcessAlive(existing.pid, existing.hostname);
  if (alive || !Number.isFinite(ageMs) || ageMs < deps.staleLockAfterMs) {
    return { acquired: false, reason: 'held' };
  }

  const staleTxDir = transactionDir(repoRoot, existing.transactionId);
  const staleJournal = readJournal(fs, staleTxDir);
  if (staleJournal && (staleJournal.state === 'promoting' || staleJournal.state === 'rolling-back')) {
    rollbackTransaction(fs, repoRoot, staleTxDir, staleJournal);
  }
  fs.remove(lockPath);
  if (fs.createExclusive(lockPath, encodeLock(payload))) return { acquired: true };
  return { acquired: false, reason: 'held' };
}

export function releaseWriteLock(fs: FilesystemOps, repoRoot: string, transactionId: string): void {
  const lockPath = join(transactionRootDir(repoRoot), WRITE_LOCK_FILE);
  const existingBytes = fs.readFileIfExists(lockPath);
  if (!existingBytes) return;
  const existing = decodeLock(existingBytes);
  if (existing.transactionId !== transactionId) return;
  fs.remove(lockPath);
}

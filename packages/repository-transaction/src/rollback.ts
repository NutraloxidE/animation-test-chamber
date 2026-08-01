/**
 * Rollback is one function, used by both an in-flight promotion failure and
 * startup recovery after a crash. Sharing it is what makes recovery idempotent
 * "for free": it only ever looks at current on-disk state plus the journal,
 * never at how far a previous attempt got, so running it twice in a row does
 * the same thing the second time (nothing) as the first time already did.
 */
import { join } from 'node:path';
import { backupsDir, sha256Hex, writeJournal } from './journal.ts';
import type { FilesystemOps } from './filesystem.ts';
import type { TransactionFatalReason, TransactionJournal } from './types.ts';

function nowIso(): string {
  return new Date().toISOString();
}

export function rollbackTransaction(
  fs: FilesystemOps,
  repoRoot: string,
  txDir: string,
  journalIn: TransactionJournal,
): TransactionJournal {
  let journal = journalIn;
  if (journal.state !== 'rolling-back') {
    journal = { ...journal, state: 'rolling-back', updatedAt: nowIso() };
    writeJournal(fs, txDir, journal);
  }

  const unrestored: string[] = [];
  const reasons: TransactionFatalReason[] = [];
  const writes = journal.writes.map((entry) => ({ ...entry }));

  for (const entry of writes) {
    const canonicalAbs = join(repoRoot, entry.repositoryPath);

    if (entry.mode === 'create') {
      const current = fs.readFileIfExists(canonicalAbs);
      if (current === null) {
        // Nothing there: never promoted, or a previous rollback attempt (or
        // the prepare-phase collision check) already ensured absence.
        entry.promoted = false;
        continue;
      }
      const currentHash = sha256Hex(current);
      if (!entry.promoted) {
        // This transaction never renamed anything to this path, yet
        // something is there. It could be a concurrent writer's file — never
        // delete a path this transaction cannot prove it created.
        unrestored.push(entry.repositoryPath);
        reasons.push({ path: entry.repositoryPath, code: 'ownership-unknown' });
        continue;
      }
      if (currentHash !== entry.preparedSha256) {
        // Promoted by this transaction, but the bytes no longer match what
        // it wrote: something else touched the file afterward. Deleting it
        // would destroy that other write.
        unrestored.push(entry.repositoryPath);
        reasons.push({ path: entry.repositoryPath, code: 'content-changed-after-promotion' });
        continue;
      }
      // Promoted by this transaction and byte-identical to what it wrote:
      // provably ours to remove.
      fs.remove(canonicalAbs);
      const stillThere = fs.readFileIfExists(canonicalAbs);
      if (stillThere !== null) {
        unrestored.push(entry.repositoryPath);
        continue;
      }
      entry.promoted = false;
      continue;
    }

    // mode === 'replace'
    const currentBytes = fs.readFileIfExists(canonicalAbs);
    const currentHash = currentBytes ? sha256Hex(currentBytes) : null;
    if (currentHash === entry.originalSha256) {
      // Either never promoted, or a previous rollback attempt already restored it.
      entry.promoted = false;
      continue;
    }
    if (entry.originalSha256 === null) {
      // A replace target that supposedly had no original is a contradiction
      // (replace requires a pre-existing file); treat as unrestorable rather
      // than guess.
      unrestored.push(entry.repositoryPath);
      continue;
    }
    const backupAbs = join(backupsDir(txDir), entry.repositoryPath);
    const backupBytes = fs.readFileIfExists(backupAbs);
    if (!backupBytes) {
      unrestored.push(entry.repositoryPath);
      reasons.push({ path: entry.repositoryPath, code: 'backup-missing' });
      continue;
    }
    fs.writeFile(canonicalAbs, backupBytes);
    fs.fsyncFile(canonicalAbs);
    const restoredHash = sha256Hex(backupBytes);
    if (restoredHash !== entry.originalSha256) {
      unrestored.push(entry.repositoryPath);
      reasons.push({ path: entry.repositoryPath, code: 'restore-hash-mismatch' });
      continue;
    }
    entry.promoted = false;
  }

  if (unrestored.length > 0) {
    const fatalJournal: TransactionJournal = {
      ...journal,
      writes,
      state: 'rolling-back',
      updatedAt: nowIso(),
      fatal: {
        message: `rollback could not restore ${unrestored.length} file(s): ${unrestored.join(', ')}`,
        unrestoredPaths: unrestored,
        ...(reasons.length > 0 ? { reasons } : {}),
      },
    };
    writeJournal(fs, txDir, fatalJournal);
    return fatalJournal;
  }

  const resolved: TransactionJournal = {
    ...journal,
    writes,
    state: 'rolled-back',
    updatedAt: nowIso(),
  };
  writeJournal(fs, txDir, resolved);
  return resolved;
}

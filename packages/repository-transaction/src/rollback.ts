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
import type { TransactionFatalCode, TransactionJournal } from './types.ts';

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
  const reasons: { path: string; code: TransactionFatalCode }[] = [];
  const writes = journal.writes.map((entry) => ({ ...entry }));

  function cannotRestore(repositoryPath: string, code: TransactionFatalCode): void {
    unrestored.push(repositoryPath);
    reasons.push({ path: repositoryPath, code });
  }

  for (const entry of writes) {
    const canonicalAbs = join(repoRoot, entry.repositoryPath);

    if (entry.mode === 'create') {
      const current = fs.readFileIfExists(canonicalAbs);
      if (current === null) {
        // Nothing there: either never promoted, or a previous rollback pass
        // already removed it. Both are the state we want.
        entry.promoted = false;
        continue;
      }

      // Undoing a create means deleting a file, which is the one rollback
      // action that destroys data rather than restoring it. It is allowed only
      // where this transaction can prove the bytes are its own: it recorded
      // promoting them, and they are still exactly the bytes it promoted.
      // Anything else — a file that appeared in the window between the
      // prepare-time absence check and the promotion, or one we promoted that
      // has since been rewritten — belongs to somebody else.
      if (!entry.promoted) {
        cannotRestore(entry.repositoryPath, 'ownership-unknown');
        continue;
      }
      if (sha256Hex(current) !== entry.preparedSha256) {
        cannotRestore(entry.repositoryPath, 'content-changed-after-promotion');
        continue;
      }

      fs.remove(canonicalAbs);
      if (fs.readFileIfExists(canonicalAbs) !== null) {
        cannotRestore(entry.repositoryPath, 'remove-failed');
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
      cannotRestore(entry.repositoryPath, 'replace-without-original');
      continue;
    }
    const backupAbs = join(backupsDir(txDir), entry.repositoryPath);
    const backupBytes = fs.readFileIfExists(backupAbs);
    if (!backupBytes) {
      cannotRestore(entry.repositoryPath, 'backup-missing');
      continue;
    }
    fs.writeFile(canonicalAbs, backupBytes);
    fs.fsyncFile(canonicalAbs);
    const restoredHash = sha256Hex(backupBytes);
    if (restoredHash !== entry.originalSha256) {
      cannotRestore(entry.repositoryPath, 'restore-hash-mismatch');
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
        reasons,
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

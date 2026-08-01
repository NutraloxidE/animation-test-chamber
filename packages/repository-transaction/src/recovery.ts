/**
 * Startup recovery (PLAN Part I §9). Run before the write API accepts a
 * request: it resolves every transaction directory left behind by a process
 * that died mid-flight, then reports whether the repository is safe to write
 * to. Idempotent by construction — it re-derives everything from the journal
 * and current disk state, never from "how far the last recovery got."
 */
import { createNodeFilesystem, type FilesystemOps } from './filesystem.ts';
import {
  journalNextFilePath,
  listTransactionIds,
  readJournal,
  transactionDir,
} from './journal.ts';
import { rollbackTransaction } from './rollback.ts';

export interface RecoveryOptions {
  fs?: FilesystemOps;
}

export type RecoveredOutcome = 'cleaned-up' | 'rolled-back' | 'fatal';

export interface RecoveredTransactionSummary {
  transactionId: string;
  outcome: RecoveredOutcome;
  message?: string;
}

export interface RecoveryResult {
  transactions: RecoveredTransactionSummary[];
  /** True when at least one transaction could not be fully rolled back. */
  readOnly: boolean;
}

export function recoverRepository(repoRoot: string, options: RecoveryOptions = {}): RecoveryResult {
  const fs = options.fs ?? createNodeFilesystem();
  const ids = listTransactionIds(fs, repoRoot);
  const transactions: RecoveredTransactionSummary[] = [];
  let readOnly = false;

  for (const transactionId of ids) {
    const txDir = transactionDir(repoRoot, transactionId);
    const read = readJournal(fs, txDir);
    const nextPath = journalNextFilePath(txDir);
    const hasOrphanNext = fs.exists(nextPath);

    // Safety over convenience for every ambiguous journal state below: the
    // cost of preserving a directory that turns out to be resolvable is a
    // human reading one file. The cost of guessing wrong is a repository that
    // silently disagrees with its own history.
    if (read.status === 'corrupt') {
      transactions.push({ transactionId, outcome: 'fatal', message: read.error });
      readOnly = true;
      continue;
    }

    if (read.status === 'missing') {
      if (hasOrphanNext) {
        // A complete `.next` with no primary cannot say whether the rename
        // ever happened, and that is exactly the fact that decides whether
        // these files are committed. Promoting it would be inventing it.
        transactions.push({
          transactionId,
          outcome: 'fatal',
          message:
            'journal-incomplete: a journal.json.next exists with no journal.json, so this ' +
            'transaction cannot be shown to have committed or to have not committed',
        });
        readOnly = true;
        continue;
      }
      fs.remove(txDir, { recursive: true });
      transactions.push({ transactionId, outcome: 'cleaned-up' });
      continue;
    }

    const journal = read.journal;
    // The primary is authoritative, so a leftover temp file is a write that
    // never landed. Dropping it keeps the next pass from seeing an ambiguity
    // that is not there.
    if (hasOrphanNext) fs.remove(nextPath);

    if (journal.state === 'preparing' || journal.state === 'prepared') {
      // Promotion never began; the canonical repository was never touched.
      fs.remove(txDir, { recursive: true });
      transactions.push({ transactionId, outcome: 'cleaned-up' });
      continue;
    }

    if (journal.state === 'committed') {
      fs.remove(txDir, { recursive: true });
      transactions.push({ transactionId, outcome: 'cleaned-up' });
      continue;
    }

    if (journal.state === 'rolled-back' && !journal.fatal) {
      fs.remove(txDir, { recursive: true });
      transactions.push({ transactionId, outcome: 'cleaned-up' });
      continue;
    }

    // 'promoting', 'rolling-back', or a previously-fatal 'rolled-back': resolve it now.
    const resolved = rollbackTransaction(fs, repoRoot, txDir, journal);
    if (resolved.fatal) {
      readOnly = true;
      transactions.push({ transactionId, outcome: 'fatal', message: resolved.fatal.message });
      continue;
    }
    fs.remove(txDir, { recursive: true });
    transactions.push({ transactionId, outcome: 'rolled-back' });
  }

  return { transactions, readOnly };
}

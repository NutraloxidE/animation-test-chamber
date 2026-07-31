/**
 * Startup recovery (PLAN Part I §9). Run before the write API accepts a
 * request: it resolves every transaction directory left behind by a process
 * that died mid-flight, then reports whether the repository is safe to write
 * to. Idempotent by construction — it re-derives everything from the journal
 * and current disk state, never from "how far the last recovery got."
 */
import { createNodeFilesystem, type FilesystemOps } from './filesystem.ts';
import { listTransactionIds, readJournal, transactionDir } from './journal.ts';
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
    const journal = readJournal(fs, txDir);

    if (!journal) {
      fs.remove(txDir, { recursive: true });
      transactions.push({ transactionId, outcome: 'cleaned-up' });
      continue;
    }

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

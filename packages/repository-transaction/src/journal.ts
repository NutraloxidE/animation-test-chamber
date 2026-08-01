import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { FilesystemOps } from './filesystem.ts';
import type { TransactionJournal } from './types.ts';

export const TRANSACTION_ROOT = '.chamber-transactions';
export const WRITE_LOCK_FILE = 'write.lock';

export function transactionRootDir(repoRoot: string): string {
  return join(repoRoot, TRANSACTION_ROOT);
}

export function transactionDir(repoRoot: string, transactionId: string): string {
  return join(transactionRootDir(repoRoot), transactionId);
}

export function preparedDir(txDir: string): string {
  return join(txDir, 'prepared');
}

export function backupsDir(txDir: string): string {
  return join(txDir, 'backups');
}

export function journalFilePath(txDir: string): string {
  return join(txDir, 'journal.json');
}

/**
 * Where a journal update is assembled before it becomes the journal.
 *
 * A crash while this file is being written leaves a torn `.next` and an intact
 * `journal.json`, which is a state recovery can read and reason about. A crash
 * while `journal.json` itself is being written leaves neither.
 */
export function journalNextFilePath(txDir: string): string {
  return `${journalFilePath(txDir)}.next`;
}

export function reportFilePath(txDir: string): string {
  return join(txDir, 'report.json');
}

export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function generateTransactionId(): string {
  return `tx-${Date.now().toString(36)}-${randomBytes(5).toString('hex')}`;
}

/**
 * Replaces the journal atomically: complete bytes into `journal.json.next`,
 * fsync, then rename over `journal.json`.
 *
 * Writing the primary file directly would mean truncating the only record of
 * what this transaction was doing and then filling it back in — and a crash
 * inside that window leaves a prefix of JSON, which is not a journal and not
 * an absent journal either. Rename is atomic on the filesystems this runs on,
 * so a reader sees the old journal or the new one and never half of either.
 */
export function writeJournal(fs: FilesystemOps, txDir: string, journal: TransactionJournal): void {
  const target = journalFilePath(txDir);
  const temp = journalNextFilePath(txDir);
  const bytes = new TextEncoder().encode(`${JSON.stringify(journal, null, 2)}\n`);
  fs.writeFile(temp, bytes);
  fs.fsyncFile(temp);
  fs.rename(temp, target);
  // Best-effort: without it the rename may not be durable across a power cut,
  // but the atomicity the rest of this depends on does not need it.
  fs.fsyncDirectory(txDir);
}

/**
 * What is at the journal path, as three distinct answers.
 *
 * A `null`-or-object return conflated "no journal" with "unreadable journal",
 * and the difference is the whole question at recovery time: the first means
 * there is nothing to resolve, the second means there is something to resolve
 * and no way to know what.
 */
export type JournalReadResult =
  | { status: 'missing' }
  | { status: 'valid'; journal: TransactionJournal }
  | { status: 'corrupt'; error: string };

/**
 * Never throws. A malformed journal is a fact about the repository to be
 * reported, not an exception to be raised at whoever happened to read it —
 * recovery is the caller here, and it runs before the server accepts anything.
 */
export function readJournal(fs: FilesystemOps, txDir: string): JournalReadResult {
  const bytes = fs.readFileIfExists(journalFilePath(txDir));
  if (!bytes) return { status: 'missing' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    return {
      status: 'corrupt',
      error: `journal-corrupt: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // Parseable is not the same as usable: rollback indexes into `writes`, and a
  // journal that parses to something else would fail further from the cause.
  const candidate = parsed as Partial<TransactionJournal>;
  if (
    typeof candidate !== 'object' ||
    candidate === null ||
    typeof candidate.transactionId !== 'string' ||
    typeof candidate.state !== 'string' ||
    !Array.isArray(candidate.writes)
  ) {
    return { status: 'corrupt', error: 'journal-corrupt: not a transaction journal' };
  }

  return { status: 'valid', journal: candidate as TransactionJournal };
}

/** Every transaction id with a directory under `.chamber-transactions/`, oldest first by name. */
export function listTransactionIds(fs: FilesystemOps, repoRoot: string): string[] {
  const root = transactionRootDir(repoRoot);
  if (!fs.exists(root)) return [];
  // listFilesRecursive only returns files; we need the transaction directory
  // names themselves, so derive them from the journal file paths it finds.
  const files = fs.listFilesRecursive(root);
  const ids = new Set<string>();
  for (const relativeFile of files) {
    const [id] = relativeFile.split('/');
    if (id) ids.add(id);
  }
  return [...ids].sort();
}

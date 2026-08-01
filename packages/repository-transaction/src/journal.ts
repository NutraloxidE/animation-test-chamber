import { createHash, randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
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
 * The staging path a journal write lands at before the atomic rename onto
 * `journal.json`. A leftover file here after a crash means the write never
 * completed; recovery treats it as a stale temp, never as the source of
 * truth.
 */
export function journalNextFilePath(txDir: string): string {
  return join(txDir, 'journal.json.next');
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
 * Never truncates `journal.json` in place. A process that dies mid-write to
 * the primary file would leave a torn, unparseable JSON document behind —
 * exactly the file the next startup's recovery has to be able to read. The
 * write lands at `journal.json.next`, fsynced, then swapped onto the primary
 * by rename, which is atomic on the same filesystem: recovery only ever sees
 * either the old primary or the fully-written new one, never a partial one.
 */
export function writeJournal(fs: FilesystemOps, txDir: string, journal: TransactionJournal): void {
  const path = journalFilePath(txDir);
  const nextPath = journalNextFilePath(txDir);
  const bytes = new TextEncoder().encode(`${JSON.stringify(journal, null, 2)}\n`);
  fs.writeFile(nextPath, bytes);
  fs.fsyncFile(nextPath);
  fs.rename(nextPath, path);
  fs.fsyncDirectory(dirname(path));
}

export type JournalReadResult =
  | { status: 'missing' }
  | { status: 'valid'; journal: TransactionJournal }
  | { status: 'corrupt'; error: string };

/**
 * Never throws. A journal a previous process died in the middle of writing —
 * before atomic writes existed, or from a `.next` promoted by a filesystem
 * that does not make rename atomic — must not take down the recovery path
 * that is specifically there to clean it up.
 */
export function readJournal(fs: FilesystemOps, txDir: string): JournalReadResult {
  const bytes = fs.readFileIfExists(journalFilePath(txDir));
  if (!bytes) return { status: 'missing' };
  try {
    const journal = JSON.parse(new TextDecoder().decode(bytes)) as TransactionJournal;
    return { status: 'valid', journal };
  } catch (error) {
    return { status: 'corrupt', error: error instanceof Error ? error.message : String(error) };
  }
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

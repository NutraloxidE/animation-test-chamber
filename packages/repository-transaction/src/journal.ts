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

export function reportFilePath(txDir: string): string {
  return join(txDir, 'report.json');
}

export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function generateTransactionId(): string {
  return `tx-${Date.now().toString(36)}-${randomBytes(5).toString('hex')}`;
}

export function writeJournal(fs: FilesystemOps, txDir: string, journal: TransactionJournal): void {
  const path = journalFilePath(txDir);
  const bytes = new TextEncoder().encode(`${JSON.stringify(journal, null, 2)}\n`);
  fs.writeFile(path, bytes);
  fs.fsyncFile(path);
}

export function readJournal(fs: FilesystemOps, txDir: string): TransactionJournal | null {
  const bytes = fs.readFileIfExists(journalFilePath(txDir));
  if (!bytes) return null;
  return JSON.parse(new TextDecoder().decode(bytes)) as TransactionJournal;
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

import { join } from 'node:path';
import { hostname as osHostname } from 'node:os';
import { createNodeFilesystem, type FilesystemOps } from './filesystem.ts';
import {
  backupsDir,
  generateTransactionId,
  journalFilePath,
  preparedDir,
  reportFilePath,
  sha256Hex,
  transactionDir,
  writeJournal,
} from './journal.ts';
import { acquireWriteLock, defaultIsProcessAlive, releaseWriteLock } from './lock.ts';
import { rollbackTransaction } from './rollback.ts';
import type {
  JournalWriteEntry,
  PreparedRepositoryView,
  RepositoryTransactionRequest,
  RepositoryTransactionResult,
  RepositoryTransactionState,
  TransactionIssue,
  TransactionJournal,
} from './types.ts';

export interface RunTransactionOptions {
  fs?: FilesystemOps;
  pid?: number;
  hostname?: string;
  now?: () => string;
  isProcessAlive?: (pid: number, hostname: string) => boolean;
  staleLockAfterMs?: number;
}

const DEFAULT_STALE_LOCK_MS = 60_000;

class PromotionFailure extends Error {}

function toBytes(content: Uint8Array | string): Uint8Array {
  return typeof content === 'string' ? new TextEncoder().encode(content) : content;
}

/** Rejects absolute paths, empty paths, backslashes and `..` traversal. */
export function invalidRepositoryPathReason(repositoryPath: string): string | null {
  if (repositoryPath.length === 0) return 'empty path';
  if (repositoryPath.startsWith('/')) return 'must be repository-relative, not absolute';
  if (/^[a-zA-Z]:/.test(repositoryPath)) return 'must not be a drive-qualified path';
  if (repositoryPath.includes('\\')) return 'must use forward slashes';
  const segments = repositoryPath.split('/');
  if (segments.some((segment) => segment === '..')) return 'must not contain ".." segments';
  if (segments.some((segment) => segment.length === 0)) return 'must not contain empty segments';
  return null;
}

function buildPreparedView(
  fs: FilesystemOps,
  repoRoot: string,
  txPreparedDir: string,
  writes: RepositoryTransactionRequest['writes'],
): PreparedRepositoryView {
  const writtenPaths = writes.map((write) => write.repositoryPath);
  const writtenSet = new Set(writtenPaths);
  function resolveBytes(repositoryPath: string): Uint8Array | null {
    if (writtenSet.has(repositoryPath)) {
      return fs.readFileIfExists(join(txPreparedDir, repositoryPath));
    }
    return fs.readFileIfExists(join(repoRoot, repositoryPath));
  }
  return {
    exists(repositoryPath) {
      return resolveBytes(repositoryPath) !== null;
    },
    readBytes(repositoryPath) {
      const bytes = resolveBytes(repositoryPath);
      if (!bytes) throw new Error(`prepared repository view: no such file "${repositoryPath}"`);
      return bytes;
    },
    readText(repositoryPath) {
      return new TextDecoder().decode(this.readBytes(repositoryPath));
    },
    writtenPaths() {
      return [...writtenPaths];
    },
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Runs one file-set transaction against `repoRoot` to completion: committed,
 * or refused/rolled-back with the repository byte-identical to before the
 * call. Never throws for an ordinary validation or conflict outcome — the
 * caller needs the issue list, and an exception would lose it.
 */
export async function runRepositoryTransaction(
  repoRoot: string,
  request: RepositoryTransactionRequest,
  options: RunTransactionOptions = {},
): Promise<RepositoryTransactionResult> {
  const fs = options.fs ?? createNodeFilesystem();
  const pid = options.pid ?? process.pid;
  const hostname = options.hostname ?? osHostname();
  const now = options.now ?? nowIso;
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const staleLockAfterMs = options.staleLockAfterMs ?? DEFAULT_STALE_LOCK_MS;

  const transactionId = generateTransactionId();
  const txDir = transactionDir(repoRoot, transactionId);
  const journalPath = journalFilePath(txDir);

  function refusal(
    state: RepositoryTransactionState,
    issues: TransactionIssue[],
  ): RepositoryTransactionResult {
    return { ok: false, transactionId, state, written: [], issues, journalPath };
  }

  const lock = acquireWriteLock(
    fs,
    repoRoot,
    { pid, hostname, createdAt: now(), transactionId },
    { now, isProcessAlive, staleLockAfterMs },
  );
  if (!lock.acquired) {
    const message =
      lock.reason === 'blocked-by-unresolved-transaction'
        ? 'a prior transaction could not be fully rolled back and needs manual resolution ' +
          'under .chamber-transactions/ before the write lock can be taken over'
        : 'another repository transaction is in progress';
    return refusal('conflict-refused', [
      { code: 'write-lock-held', severity: 'error', message },
    ]);
  }

  // Point of no return: once true, every exit from this function must be
  // committed / rolled-back / fatal. A refusal that deletes the transaction
  // directory is only legal while this is still false, i.e. before the
  // canonical repository has been touched. Declared outside the try below so
  // the outer catch — reachable only if rollback itself throws — can still
  // see it; a `let` declared inside a try block is out of scope in its catch.
  let promotionStarted = false;

  try {
    // 1. Validate paths before touching disk at all.
    const pathIssues: TransactionIssue[] = [];
    for (const write of request.writes) {
      const reason = invalidRepositoryPathReason(write.repositoryPath);
      if (reason) {
        pathIssues.push({
          code: 'invalid-repository-path',
          severity: 'error',
          message: `${write.repositoryPath}: ${reason}`,
          path: write.repositoryPath,
        });
      }
    }
    if (pathIssues.length > 0) {
      releaseWriteLock(fs, repoRoot, transactionId);
      return refusal('validation-refused', pathIssues);
    }

    // 2. Optimistic concurrency: every file the caller's plan depends on must
    // still match what the caller last saw, checked fresh now that the lock
    // is held (not trusting anything computed before acquiring it).
    const conflictIssues: TransactionIssue[] = [];
    for (const expectation of request.expected.files ?? []) {
      const bytes = fs.readFileIfExists(join(repoRoot, expectation.repositoryPath));
      const actualHash = bytes ? sha256Hex(bytes) : null;
      if (actualHash !== expectation.expectedSha256) {
        conflictIssues.push({
          code: 'stale-expectation',
          severity: 'error',
          message:
            `${expectation.repositoryPath} no longer matches the expected snapshot ` +
            `(expected ${expectation.expectedSha256 ?? '<absent>'}, found ${actualHash ?? '<absent>'})`,
          path: expectation.repositoryPath,
        });
      }
    }
    if (conflictIssues.length > 0) {
      releaseWriteLock(fs, repoRoot, transactionId);
      return refusal('conflict-refused', conflictIssues);
    }

    // From here on, a crash must be recoverable, so the journal exists before
    // any write lands.
    let journal: TransactionJournal = {
      schemaVersion: 1,
      transactionId,
      intent: request.intent,
      state: 'preparing',
      startedAt: now(),
      updatedAt: now(),
      expected: request.expected,
      writes: [],
    };
    writeJournal(fs, txDir, journal);

    // 3-5. Every proposal lands under prepared/ first, fsynced.
    const writeEntries: JournalWriteEntry[] = [];
    for (const write of request.writes) {
      const bytes = toBytes(write.content);
      const preparedAbs = join(preparedDir(txDir), write.repositoryPath);
      fs.writeFile(preparedAbs, bytes);
      fs.fsyncFile(preparedAbs);

      const canonicalAbs = join(repoRoot, write.repositoryPath);
      const originalBytes = fs.readFileIfExists(canonicalAbs);
      if (write.mode === 'create' && originalBytes !== null) {
        fs.remove(txDir, { recursive: true });
        releaseWriteLock(fs, repoRoot, transactionId);
        return refusal('conflict-refused', [
          {
            code: 'create-target-exists',
            severity: 'error',
            message: `${write.repositoryPath} already exists; publish a new version instead`,
            path: write.repositoryPath,
          },
        ]);
      }
      if (write.mode === 'replace' && originalBytes === null) {
        fs.remove(txDir, { recursive: true });
        releaseWriteLock(fs, repoRoot, transactionId);
        return refusal('conflict-refused', [
          {
            code: 'replace-target-missing',
            severity: 'error',
            message: `${write.repositoryPath} does not exist; nothing to replace`,
            path: write.repositoryPath,
          },
        ]);
      }
      writeEntries.push({
        repositoryPath: write.repositoryPath,
        mode: write.mode,
        preparedSha256: sha256Hex(bytes),
        originalSha256: originalBytes ? sha256Hex(originalBytes) : null,
        promoted: false,
      });
    }
    journal = { ...journal, writes: writeEntries, updatedAt: now() };
    writeJournal(fs, txDir, journal);

    // 6-7. Build the prepared view and run every validator against it.
    const view = buildPreparedView(fs, repoRoot, preparedDir(txDir), request.writes);
    const validation = await request.validatePreparedView(view);
    const validationErrors = validation.issues.filter((issue) => issue.severity === 'error');
    if (validationErrors.length > 0) {
      fs.remove(txDir, { recursive: true });
      releaseWriteLock(fs, repoRoot, transactionId);
      return refusal('validation-refused', validation.issues);
    }

    // 8. Validators passed: this transaction is now committed-to-promote.
    journal = { ...journal, state: 'prepared', updatedAt: now() };
    writeJournal(fs, txDir, journal);

    // 9. Backups for every replace target.
    for (const entry of writeEntries) {
      if (entry.mode !== 'replace') continue;
      const canonicalAbs = join(repoRoot, entry.repositoryPath);
      const bytes = fs.readFileIfExists(canonicalAbs);
      if (bytes) {
        const backupAbs = join(backupsDir(txDir), entry.repositoryPath);
        fs.writeFile(backupAbs, bytes);
        fs.fsyncFile(backupAbs);
      }
    }

    // 10. Cross the point of no return.
    try {
      promotionStarted = true;

      journal = { ...journal, state: 'promoting', updatedAt: now() };
      writeJournal(fs, txDir, journal);

      // 11-12. Promote by same-filesystem rename, journaling each success.
      for (const entry of writeEntries) {
        const preparedAbs = join(preparedDir(txDir), entry.repositoryPath);
        const canonicalAbs = join(repoRoot, entry.repositoryPath);
        if (entry.mode === 'create' && fs.exists(canonicalAbs)) {
          throw new PromotionFailure(`${entry.repositoryPath} was created concurrently during promotion`);
        }
        fs.rename(preparedAbs, canonicalAbs);
        entry.promoted = true;
        journal = { ...journal, writes: writeEntries.map((e) => ({ ...e })), updatedAt: now() };
        writeJournal(fs, txDir, journal);
      }

      // 13. Verify every promoted file's hash before declaring victory.
      for (const entry of writeEntries) {
        const canonicalAbs = join(repoRoot, entry.repositoryPath);
        const bytes = fs.readFileIfExists(canonicalAbs);
        const actual = bytes ? sha256Hex(bytes) : null;
        if (actual !== entry.preparedSha256) {
          throw new PromotionFailure(`${entry.repositoryPath} hash mismatch after promotion`);
        }
      }

      // 14. The final journal write is still inside the point-of-no-return
      // guard: canonical files are already promoted, so a failure writing
      // this journal must roll back those files too, not be reported as a
      // refusal that leaves them changed.
      journal = { ...journal, state: 'committed', updatedAt: now() };
      writeJournal(fs, txDir, journal);
    } catch (error) {
      const rolledBack = rollbackTransaction(fs, repoRoot, txDir, journal);
      releaseWriteLock(fs, repoRoot, transactionId);
      if (rolledBack.fatal) {
        return refusal('rolled-back', [
          { code: 'rollback-incomplete', severity: 'error', message: rolledBack.fatal.message },
        ]);
      }
      writeReportBestEffort(fs, txDir, rolledBack, []);
      return refusal('rolled-back', [
        {
          code: 'promotion-failed',
          severity: 'error',
          message: error instanceof Error ? error.message : String(error),
        },
      ]);
    }

    // 15. Committed. Release the lock before the non-critical report write.
    // Best-effort like the report write below: the commit already happened
    // and is already durably journaled, so a failure releasing the lock must
    // not turn a success into a reported failure.
    try {
      releaseWriteLock(fs, repoRoot, transactionId);
    } catch {
      // A leaked lock here is recoverable by the normal stale-lock path;
      // silently failing the caller's successful commit is not recoverable.
    }

    const written = writeEntries.map((entry) => entry.repositoryPath);
    // 16. Report failures must never undo a commit that already happened.
    writeReportBestEffort(fs, txDir, journal, written);

    return { ok: true, transactionId, state: 'committed', written, issues: [], journalPath };
  } catch (error) {
    if (promotionStarted) {
      // The inner catch above owns every ordinary promotion-phase failure;
      // this is reached only if rollback itself (or releasing the lock)
      // threw. Canonical files may already be promoted, so evidence must be
      // kept and this must never be reported as a refusal.
      return refusal('rolled-back', [
        {
          code: 'rollback-incomplete',
          severity: 'error',
          message: error instanceof Error ? error.message : String(error),
        },
      ]);
    }
    // A failure before promotion began (path/optimistic validation,
    // prepare-phase writes, or the validator itself) — the canonical
    // repository has not been touched, so it is still safe to discard the
    // transaction directory and refuse.
    fs.remove(txDir, { recursive: true });
    releaseWriteLock(fs, repoRoot, transactionId);
    return refusal('validation-refused', [
      {
        code: 'transaction-error',
        severity: 'error',
        message: error instanceof Error ? error.message : String(error),
      },
    ]);
  }
}

function writeReportBestEffort(
  fs: FilesystemOps,
  txDir: string,
  journal: TransactionJournal,
  written: string[],
): void {
  try {
    const report = {
      transactionId: journal.transactionId,
      intent: journal.intent,
      state: journal.state,
      startedAt: journal.startedAt,
      updatedAt: journal.updatedAt,
      written,
      writes: journal.writes,
      fatal: journal.fatal ?? null,
    };
    const bytes = new TextEncoder().encode(`${JSON.stringify(report, null, 2)}\n`);
    fs.writeFile(reportFilePath(txDir), bytes);
  } catch {
    // Never let a report-write failure affect the outcome already decided.
  }
}

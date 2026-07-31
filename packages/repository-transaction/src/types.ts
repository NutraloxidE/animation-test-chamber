/**
 * Generic, domain-agnostic file-set transaction over a repository checkout.
 *
 * This package knows nothing about animation assets, scenes or prefabs. It
 * knows how to take a set of proposed file writes, validate them against a
 * caller-supplied predicate, and land all of them or none of them even if the
 * process crashes mid-promotion. Domain adapters (the animation asset system
 * today; scenes, materials, build presets later) build a
 * `RepositoryTransactionRequest` and hand it to `runRepositoryTransaction`.
 */

export type WriteMode = 'create' | 'replace';

export interface PlannedFileWrite {
  /** Path relative to the repository root, forward-slash separated. */
  repositoryPath: string;
  mode: WriteMode;
  content: Uint8Array | string;
}

export interface RepositorySnapshotExpectation {
  /** Expected `ProjectDefinition.revisionId` (or equivalent), if relevant. */
  projectRevisionId?: string;
  /**
   * Optimistic-concurrency checks against files the transaction *depends on*
   * but does not necessarily write (e.g. a referenced asset version). `null`
   * means "expected not to exist".
   */
  files?: {
    repositoryPath: string;
    expectedSha256: string | null;
  }[];
}

/** Read-only view of the repository as it would be after the proposed writes land. */
export interface PreparedRepositoryView {
  /** True if the path exists either on disk or among the proposed writes (and was not itself absent-checked). */
  exists(repositoryPath: string): boolean;
  readText(repositoryPath: string): string;
  readBytes(repositoryPath: string): Uint8Array;
  /** Every repository-relative path touched by this transaction's writes. */
  writtenPaths(): string[];
}

export type TransactionIssueSeverity = 'error' | 'warning';

export interface TransactionIssue {
  code: string;
  severity: TransactionIssueSeverity;
  message: string;
  path?: string;
}

export interface TransactionValidationResult {
  issues: TransactionIssue[];
}

export interface RepositoryTransactionRequest {
  /** Human-readable reason, recorded in the journal and report. */
  intent: string;
  expected: RepositorySnapshotExpectation;
  writes: PlannedFileWrite[];
  validatePreparedView(
    view: PreparedRepositoryView,
  ): Promise<TransactionValidationResult> | TransactionValidationResult;
}

export type RepositoryTransactionState =
  | 'committed'
  | 'validation-refused'
  | 'conflict-refused'
  | 'rolled-back'
  | 'recovered';

export interface RepositoryTransactionResult {
  ok: boolean;
  transactionId: string;
  state: RepositoryTransactionState;
  /** Repository-relative paths actually promoted to canonical locations. */
  written: string[];
  issues: TransactionIssue[];
  journalPath: string;
}

export type JournalState =
  | 'preparing'
  | 'prepared'
  | 'promoting'
  | 'committed'
  | 'rolling-back'
  | 'rolled-back';

export interface JournalWriteEntry {
  repositoryPath: string;
  mode: WriteMode;
  preparedSha256: string;
  /** sha256 of the file at its canonical path before this transaction, or null if it did not exist. */
  originalSha256: string | null;
  promoted: boolean;
}

export interface TransactionJournal {
  schemaVersion: 1;
  transactionId: string;
  intent: string;
  state: JournalState;
  startedAt: string;
  updatedAt: string;
  expected: RepositorySnapshotExpectation;
  writes: JournalWriteEntry[];
  /**
   * Set when rollback could not fully restore every target. A transaction in
   * this condition must not be treated as resolved by recovery; the write API
   * is expected to fall back to read-only until a human intervenes.
   */
  fatal?: { message: string; unrestoredPaths: string[] };
}

export interface WriteLockPayload {
  pid: number;
  hostname: string;
  createdAt: string;
  transactionId: string;
}

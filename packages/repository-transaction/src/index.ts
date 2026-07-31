export type {
  PlannedFileWrite,
  PreparedRepositoryView,
  RepositorySnapshotExpectation,
  RepositoryTransactionRequest,
  RepositoryTransactionResult,
  RepositoryTransactionState,
  TransactionIssue,
  TransactionIssueSeverity,
  TransactionValidationResult,
  TransactionJournal,
  JournalWriteEntry,
  JournalState,
  WriteLockPayload,
  WriteMode,
} from './types.ts';

export {
  createNodeFilesystem,
  withFaultInjection,
  type FilesystemOps,
  type FaultInjectionContext,
  type FaultInjectionHook,
  type FsOpName,
} from './filesystem.ts';

export {
  TRANSACTION_ROOT,
  WRITE_LOCK_FILE,
  transactionRootDir,
  transactionDir,
  preparedDir,
  backupsDir,
  journalFilePath,
  reportFilePath,
  sha256Hex,
  generateTransactionId,
  writeJournal,
  readJournal,
  listTransactionIds,
} from './journal.ts';

export { rollbackTransaction } from './rollback.ts';

export {
  runRepositoryTransaction,
  invalidRepositoryPathReason,
  type RunTransactionOptions,
} from './transaction.ts';

export {
  recoverRepository,
  type RecoveryOptions,
  type RecoveryResult,
  type RecoveredTransactionSummary,
  type RecoveredOutcome,
} from './recovery.ts';

export {
  acquireWriteLock,
  releaseWriteLock,
  defaultIsProcessAlive,
  type LockAcquisition,
  type LockDependencies,
} from './lock.ts';

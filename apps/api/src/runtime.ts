/**
 * Everything a write path needs to know about *which* repository it is writing
 * to and whether it is still allowed to.
 *
 * This exists so the answer to both questions is a value that can be handed to
 * a route, rather than a module-level constant decided at import time. A test —
 * and, more importantly, the same-process fatal-lockdown behaviour this guards —
 * needs a second server over a different checkout, and needs the read-only flag
 * to be a thing that can change while the process runs.
 */
import type { RunTransactionOptions } from '@atc/repository-transaction';
import { REPO_ROOT } from './context.ts';
import { createRepositoryHealth, type RepositoryHealth } from './repository-health.ts';
import { runStartupRecovery } from './read-only-guard.ts';

export interface RepositoryRuntime {
  /** Absolute path of the repository checkout this server writes to. */
  repoRoot: string;
  /** The single mutable read-only/fatal state for this process. */
  health: RepositoryHealth;
  /** Passed straight to the transaction engine; the seam tests inject faults through. */
  transactionOptions: RunTransactionOptions;
}

export interface CreateRuntimeOptions {
  repoRoot?: string;
  transactionOptions?: RunTransactionOptions;
}

/**
 * Runs startup recovery over `repoRoot` and returns the runtime seeded from it,
 * so a process that boots onto an unresolved repository is read-only from its
 * very first request rather than from the first failure it happens to hit.
 */
export function createRepositoryRuntime(options: CreateRuntimeOptions = {}): RepositoryRuntime {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const startupRecovery = runStartupRecovery(repoRoot);
  if (startupRecovery.transactions.length > 0) {
    console.log(
      `[repository-transaction] startup recovery resolved ${startupRecovery.transactions.length} ` +
        `transaction(s): ${startupRecovery.transactions
          .map((transaction) => `${transaction.transactionId}=${transaction.outcome}`)
          .join(', ')}`,
    );
  }
  const health = createRepositoryHealth(startupRecovery);
  if (health.readOnly) {
    console.error(
      '[repository-transaction] one or more transactions could not be fully rolled back; ' +
        'the write API is disabled until a human resolves .chamber-transactions/',
    );
  }
  return { repoRoot, health, transactionOptions: options.transactionOptions ?? {} };
}

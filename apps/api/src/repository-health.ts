/**
 * Whether *this* process may still write to the repository (PLAN Part I §9).
 *
 * Startup recovery answers that question once, at boot. It is not the only
 * moment it can change: a transaction that fails and cannot certify its own
 * rollback leaves the canonical repository in a state nobody can describe, and
 * that happens while the server is running. A boot-time constant would keep
 * answering "writable" for the rest of the process lifetime, so the next POST
 * would land on top of a repository the previous one could not account for.
 *
 * One mutable object, owned by the server context, is deliberately the whole
 * design here — no event bus, no store. The invariant that matters is that
 * there is exactly one of them and every write path reads it.
 */
import type { RecoveryResult } from '@atc/repository-transaction';

export interface RepositoryHealth {
  /** True when no write may be accepted until a human resolves the repository. */
  readOnly: boolean;
  /** Human-readable cause, shown to whoever hits the refusal. */
  reason: string | null;
  /** The transaction whose outcome could not be established, if known. */
  fatalTransactionId: string | null;
}

const STARTUP_FALLBACK_REASON = 'startup recovery found an unresolved transaction';

/** Seeds the health of a process from what startup recovery found on disk. */
export function createRepositoryHealth(startupRecovery: RecoveryResult): RepositoryHealth {
  const fatal = startupRecovery.transactions.find((transaction) => transaction.outcome === 'fatal');
  return {
    readOnly: startupRecovery.readOnly,
    reason: startupRecovery.readOnly ? (fatal?.message ?? STARTUP_FALLBACK_REASON) : null,
    fatalTransactionId: fatal?.transactionId ?? null,
  };
}

/**
 * Flips this process to read-only, immediately.
 *
 * One-way on purpose: nothing in the running server may clear it. The repository
 * becomes writable again when a human has resolved `.chamber-transactions/` and
 * the next startup recovery can say so — not because a later request happened to
 * succeed. The first fatal transaction keeps the attribution; a second one adds
 * nothing a human needs and would bury the one that started it.
 */
export function markRepositoryFatal(
  health: RepositoryHealth,
  transactionId: string,
  reason: string,
): void {
  if (health.readOnly) return;
  health.readOnly = true;
  health.reason = reason;
  health.fatalTransactionId = transactionId;
}

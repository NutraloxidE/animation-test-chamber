/**
 * The rule that decides whether this process may accept a write (PLAN Part I §9).
 *
 * Kept out of `server.ts` because that module boots a listener as a side
 * effect of being imported, which makes the decision itself untestable — and
 * "does a repository that failed recovery actually refuse writes" is exactly
 * the thing that must not be assumed.
 */
import { recoverRepository, type RecoveryResult } from '@atc/repository-transaction';

export const READ_ONLY_MESSAGE =
  'the repository is in read-only mode: a prior transaction could not be fully rolled back ' +
  'and needs manual resolution under .chamber-transactions/';

/** Runs startup recovery and reports whether writes may be accepted after it. */
export function runStartupRecovery(repoRoot: string): RecoveryResult {
  return recoverRepository(repoRoot);
}

/**
 * Whether a request must be refused with 503.
 *
 * Reads stay available deliberately: a repository nobody can write to is still
 * one a human needs to look at, and taking the whole API down would remove the
 * only view of what went wrong.
 */
export function refusesWrite(readOnly: boolean, method: string): boolean {
  return readOnly && method !== 'GET';
}

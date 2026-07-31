/**
 * Transaction recovery smoke check (PLAN Part I §9, Part VII §28).
 *
 * Runs the same startup recovery the API server runs before it accepts a
 * write, directly against the live repository, twice in a row. A repository
 * left behind by a process that died mid-promotion must resolve to a clean,
 * writable state, and running recovery again afterward must change nothing —
 * that is what "idempotent" means here, not just an assertion in a test with
 * a synthetic filesystem.
 */
import { recoverRepository } from '@atc/repository-transaction';
import { REPO_ROOT, stage, type StageIssue, type StageResult } from './lib.ts';

export function transactionRecoveryStage(): StageResult {
  return stage(
    'transaction recovery is clean and idempotent',
    {
      reproduce: 'npx tsx -e "import(\'@atc/repository-transaction\').then(m => console.log(m.recoverRepository(process.cwd())))"',
      suggestion:
        'a fatal or unresolved transaction under .chamber-transactions/ means a promotion crashed and was not (or could not be) rolled back — inspect its journal.json before touching anything else',
    },
    () => {
      const first = recoverRepository(REPO_ROOT);
      const second = recoverRepository(REPO_ROOT);
      const issues: StageIssue[] = [];

      if (first.readOnly) {
        issues.push({
          files: ['.chamber-transactions'],
          expected: 'the repository to be writable',
          actual: 'readOnly=true after the first recovery pass',
          message: 'at least one transaction could not be fully rolled back',
        });
      }
      for (const summary of first.transactions) {
        if (summary.outcome === 'fatal') {
          issues.push({
            files: [`.chamber-transactions/${summary.transactionId}`],
            expected: 'every transaction to resolve to cleaned-up or rolled-back',
            actual: summary.message ?? 'fatal',
            message: `transaction ${summary.transactionId} is fatal and unresolved`,
          });
        }
      }
      if (second.transactions.length !== 0 || second.readOnly) {
        issues.push({
          files: ['.chamber-transactions'],
          expected: 'a second recovery pass to find nothing left to do',
          actual: JSON.stringify(second),
          message: 'recovery is not idempotent: the second pass still found work',
        });
      }

      return {
        ok: issues.length === 0,
        issues,
        output: `first pass resolved ${first.transactions.length} transaction(s); second pass resolved ${second.transactions.length}`,
      };
    },
  );
}

function main(): void {
  const result = transactionRecoveryStage();
  process.stdout.write(`${result.ok ? 'PASS' : 'FAIL'}: ${result.name}\n`);
  if (!result.ok) {
    for (const issue of result.issues) process.stdout.write(`  - ${issue.message}\n`);
  }
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1]?.includes('check-transaction-recovery')) main();

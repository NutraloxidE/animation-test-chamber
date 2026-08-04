/**
 * Machine-readable apply reports.
 *
 * Written after the repository write succeeds, never before, and deliberately
 * carrying no Git commit SHA: an Apply does not commit, and a report that
 * invented a SHA before a commit existed would be the most convincing possible
 * form of a fabricated result.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface RepositoryApplyReport {
  target: { kind: string; id: string };
  baseRevisionId: string;
  newRevisionId: string;
  actor: string;
  intent: string;
  changedPaths: string[];
  operations: string[];
  files: string[];
}

/**
 * The report as a planned file, rather than a file already on disk.
 *
 * Apply writes the project and this report as one transaction, so the report
 * cannot be written here: a report written before the project promoted would
 * describe a revision that may never exist, and one written after is a second
 * outcome that can fail on its own.
 */
export function repositoryReportFile(report: RepositoryApplyReport): {
  path: string;
  contents: string;
} {
  return {
    path: `reports/apply/${report.target.kind}-${report.target.id}-${report.newRevisionId}.json`,
    contents: `${JSON.stringify({ ...report, generated: true }, null, 2)}\n`,
  };
}

/** Writes the report and returns its repository-relative path. */
export function writeRepositoryReport(root: string, report: RepositoryApplyReport): string {
  const file = repositoryReportFile(report);
  mkdirSync(resolve(root, 'reports/apply'), { recursive: true });
  writeFileSync(resolve(root, file.path), file.contents, 'utf8');
  return file.path;
}

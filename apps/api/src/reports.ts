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

/** Writes the report and returns its repository-relative path. */
export function writeRepositoryReport(root: string, report: RepositoryApplyReport): string {
  const directory = 'reports/apply';
  const relative = `${directory}/${report.target.kind}-${report.target.id}-${report.newRevisionId}.json`;
  mkdirSync(resolve(root, directory), { recursive: true });
  writeFileSync(
    resolve(root, relative),
    `${JSON.stringify({ ...report, generated: true }, null, 2)}\n`,
    'utf8',
  );
  return relative;
}

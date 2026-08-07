/**
 * Machine-readable apply reports.
 *
 * Written as part of the Apply transaction, never before and never after, and
 * deliberately carrying no Git commit SHA: an Apply does not commit, and a
 * report that invented a SHA before a commit existed would be the most
 * convincing possible form of a fabricated result.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ProtectionApproval } from '@atc/schema';

export interface RepositoryApplyReport {
  /**
   * This Apply's own identity, independent of what it wrote.
   *
   * Content revisions legitimately repeat: rename A→B, rename back B→A, rename
   * A→B again, and the third state is byte-identical to the first, so it
   * carries the same content-derived revision. That is correct — identical
   * content *should* have identical identity — but it means a report path
   * derived from the new revision collides with the earlier report of the same
   * transition, and the create-mode write refuses. The second B→A is a real
   * Apply that must not fail because an earlier one happened to reach the same
   * bytes.
   *
   * So the report is identified by the *event*, and the project by its
   * *content*. Two different questions, two different identities.
   */
  applyId: string;
  target: { kind: string; id: string };
  baseRevisionId: string;
  newRevisionId: string;
  actor: string;
  intent: string;
  changedPaths: string[];
  operations: string[];
  files: string[];
  /**
   * The human's exact sign-off, when the Apply needed one.
   *
   * Recorded as the paths that were approved and the reason given, never as a
   * bare `approved: true`. A boolean records that someone clicked something; it
   * cannot be checked against what the operations actually changed, so it is
   * evidence of nothing. Absent entirely when no protected path was touched.
   */
  protectionApproval?: ProtectionApproval;
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
    path:
      `reports/apply/${report.target.kind}-${report.target.id}-` +
      `${report.newRevisionId}-${report.applyId}.json`,
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

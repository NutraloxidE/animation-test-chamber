import type { ProjectDefinition, RevisionDefinition } from '@atc/schema';
import type { DiffReport, FieldChange } from '@atc/runtime-core';

export interface CommitDraft {
  message: string;
  body: string;
  revision: RevisionDefinition;
  document: ProjectDefinition;
}

function summarizeChange(change: FieldChange): string {
  const format = (value: unknown): string =>
    typeof value === 'number' ? String(Number(value.toFixed(4))) : JSON.stringify(value);
  if (change.kind === 'added') return `+ ${change.path} = ${format(change.after)}`;
  if (change.kind === 'removed') return `- ${change.path} (was ${format(change.before)})`;
  return `~ ${change.path}: ${format(change.before)} -> ${format(change.after)}`;
}

/**
 * Builds the commit for one tuning session. A session is one commit by default
 * (PLAN 9.3), and the body records what changed, what it was before, and the
 * human's stated intent — so the next agent reads the decision, not just the diff.
 */
export function buildCommitDraft(options: {
  document: ProjectDefinition;
  diff: DiffReport;
  author: string;
  intent?: string;
  parentRevisionId: string;
  now?: string;
}): CommitDraft {
  const { document, diff, author, intent, parentRevisionId } = options;
  const now = options.now ?? new Date().toISOString();

  const changedPaths = diff.changes.map((change) => change.path);
  const revisionNumber = document.revisions.length + 1;
  const revisionId = `rev-${String(revisionNumber).padStart(4, '0')}`;

  const scope = describeScope(changedPaths);
  const message = `tune(${scope}): ${changedPaths.length} value${changedPaths.length === 1 ? '' : 's'} adjusted in the chamber`;

  const lines: string[] = [];
  if (intent) {
    lines.push('Intent:', intent, '');
  }
  lines.push('Changes:');
  for (const change of diff.changes) lines.push(`  ${summarizeChange(change)}`);

  const warnings = diff.findings.filter((finding) => finding.severity !== 'informational');
  if (warnings.length > 0) {
    lines.push('', 'Diff policy notes:');
    for (const finding of warnings) {
      lines.push(`  [${finding.severity}] ${finding.rule} ${finding.path}: ${finding.message}`);
    }
  }

  const revision: RevisionDefinition = {
    schemaVersion: 1,
    id: revisionId,
    parentId: parentRevisionId,
    createdAt: now,
    author,
    message,
    changedPaths,
    provenance: {
      source: 'human-adjustment',
      at: now,
      ...(intent ? { intent } : {}),
    },
  };

  const committedDocument: ProjectDefinition = {
    ...document,
    revisionId,
    revisions: [...document.revisions, revision],
  };

  return { message, body: lines.join('\n'), revision, document: committedDocument };
}

/** Derives a short conventional-commit scope from the touched paths. */
function describeScope(paths: string[]): string {
  const areas = new Set<string>();
  for (const path of paths) {
    const segment = path.split('/')[1];
    if (segment) areas.add(segment);
  }
  if (areas.size === 0) return 'project';
  if (areas.size === 1) return [...areas][0]!;
  return [...areas].sort().slice(0, 3).join(',');
}

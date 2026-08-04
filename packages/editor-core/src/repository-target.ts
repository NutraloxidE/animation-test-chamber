/**
 * What a page is editing.
 *
 * The route parameter is authoritative (work package §4.2), so the target has
 * to be a *value* the session carries rather than something each panel
 * rediscovers from a global "active" id. The failure this replaces is specific:
 * with four independently writable notions of "the current character" —
 * `activeCharacterId`, a library selection, a preview id, a route param — a
 * panel that reads the wrong one edits the wrong document while looking
 * entirely correct.
 */

export type RepositoryDocumentTarget =
  | { kind: 'character'; id: string }
  | { kind: 'scene'; id: string };

/** A stable, human-readable key for one target. Used in draft keys and logs. */
export function targetKey(target: RepositoryDocumentTarget): string {
  return `${target.kind}:${target.id}`;
}

export function sameTarget(
  left: RepositoryDocumentTarget,
  right: RepositoryDocumentTarget,
): boolean {
  return left.kind === right.kind && left.id === right.id;
}

/**
 * The browser-draft key for one target at one repository revision.
 *
 * Every component of identity participates, and the revision is not optional.
 * A draft keyed on the target alone survives a repository change and is then
 * reapplied on top of a document it was never based on — silently, and looking
 * exactly like a successful restore (work package §16.3).
 */
export function draftKey(input: {
  projectId: string;
  repositoryRevisionId: string;
  target: RepositoryDocumentTarget;
}): string {
  return [
    'atc-draft',
    input.projectId,
    input.repositoryRevisionId,
    input.target.kind,
    input.target.id,
  ]
    .map((part) => encodeURIComponent(part))
    .join(':');
}

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
 *
 * The type itself is the `Static<>` derivation of the runtime schema, not a
 * second hand-written copy of it. A target arrives over HTTP as JSON, so the
 * shape the server validates and the shape the editor passes around have to be
 * the same shape or the compile-time one is describing a document the runtime
 * one would refuse.
 */
export type { RepositoryDocumentTarget } from '@atc/schema';

import type { RepositoryDocumentTarget } from '@atc/schema';

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

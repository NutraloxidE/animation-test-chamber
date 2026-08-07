import type { GameObjectPrefabReference } from '@atc/schema';

/**
 * Every way a Prefab graph can be wrong, named.
 *
 * The codes are part of the contract, not debug strings: the harness asserts on
 * them, the Asset Library groups by them, and the delete policy refuses by
 * quoting them. A new failure mode gets a new code rather than being folded
 * into a neighbouring one.
 */
export type PrefabIssueCode =
  /* Reference integrity — the same three questions the animation registry asks. */
  | 'missing-prefab'
  | 'prefab-version-not-found'
  | 'prefab-hash-mismatch'
  /* Storage integrity. */
  | 'schema-invalid'
  | 'duplicate-prefab-key'
  | 'prefab-metadata-mismatch'
  | 'prefab-path-mismatch'
  | 'published-prefab-modified'
  | 'unsealed-published-prefab'
  /* Composition integrity. */
  | 'duplicate-node-id'
  | 'duplicate-component-id'
  | 'unknown-component-type'
  | 'invalid-component-constraint'
  | 'nested-prefab-cycle'
  | 'variant-parent-cycle'
  /* Override addressing. */
  | 'invalid-override-target'
  | 'invalid-override-path'
  /* Placement. */
  | 'abstract-prefab-placed'
  | 'invalid-instance-binding'
  | 'invalid-instance-relation'
  /* Canonical purity. */
  | 'runtime-state-in-canonical-document';

export interface PrefabIssue {
  code: PrefabIssueCode;
  severity: 'error' | 'warning';
  message: string;
  /** Canonical path inside the Prefab, when the problem has one. */
  path?: string;
  reference?: GameObjectPrefabReference;
}

export interface PrefabValidationReport {
  valid: boolean;
  issues: PrefabIssue[];
}

export function prefabError(
  code: PrefabIssueCode,
  message: string,
  extra: { path?: string; reference?: GameObjectPrefabReference } = {},
): PrefabIssue {
  return { code, severity: 'error', message, ...extra };
}

/**
 * Component patching.
 *
 * A Prefab variant, a nested Prefab instance and a Scene instance all change
 * the same thing in the same way: some fields of one component, addressed by
 * stable node and component id. This is the one place that happens.
 *
 * Two rules make the difference between an override and a rewrite:
 *
 *  1. A patch may not touch a component's identity (`componentId`,
 *     `componentType`, `schemaVersion`). An override that could change
 *     `componentType` would be a component replacement wearing an override's
 *     name, and every consumer that had already narrowed on the type would be
 *     holding the wrong shape.
 *
 *  2. A `set` must address a path that already exists. Variants patch values
 *     the parent has; letting a typo invent `/assignmnet/motionSet` would
 *     produce a resolved component that no schema describes and no validator
 *     would ever look at again.
 *
 * What a patch *may* do is repoint a reference: `/assignment/motionSet` to a
 * different Motion Set version is the canonical case. What it may not do is
 * reach through that reference into the Motion Set's contents — the reference
 * has four fields and none of them is `bindings`, so the schema already makes
 * that unrepresentable, and `invalid-override-path` reports it when someone
 * tries anyway.
 */
import { getAtPath, setAtPath, splitPath } from '@atc/runtime-core';
import type { CanonicalPatch, GameObjectComponentDefinition } from '@atc/schema';
import { type PrefabIssue, prefabError } from './issues.ts';

/** Fields that name what a component *is*, and so are never patchable. */
const IDENTITY_FIELDS = new Set(['componentId', 'componentType', 'schemaVersion']);

export interface ComponentPatchResult {
  component: GameObjectComponentDefinition;
  issues: PrefabIssue[];
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Applies one override's patches to one component.
 *
 * Rejections are reported, never thrown and never silently dropped: a Prefab
 * whose override no longer addresses anything is a Prefab someone needs to fix,
 * and resolving it to "the unpatched value, quietly" is how a variant stops
 * meaning what its author wrote.
 */
export function applyComponentPatches(
  component: GameObjectComponentDefinition,
  patches: readonly CanonicalPatch[],
  where: { nodeId: string; componentId: string },
): ComponentPatchResult {
  let next: unknown = clone(component);
  const issues: PrefabIssue[] = [];
  const at = `/nodes/${where.nodeId}/components/${where.componentId}`;

  for (const patch of patches) {
    const segments = splitPath(patch.path);
    const head = segments[0];
    if (head !== undefined && IDENTITY_FIELDS.has(head)) {
      issues.push(
        prefabError(
          'invalid-override-path',
          `"${patch.path}" would change what component "${where.componentId}" is, not what it holds`,
          { path: `${at}${patch.path}` },
        ),
      );
      continue;
    }
    if (segments.length === 0) {
      issues.push(
        prefabError(
          'invalid-override-path',
          `an override must address a field, not the whole of component "${where.componentId}"`,
          { path: at },
        ),
      );
      continue;
    }
    if (patch.op !== 'set') {
      // `append` and `remove` restructure. A component's shape is its schema;
      // changing it belongs to a new Prefab version, not to an override.
      issues.push(
        prefabError(
          'invalid-override-path',
          `"${patch.op}" would restructure component "${where.componentId}"; publish a Prefab version instead`,
          { path: `${at}${patch.path}` },
        ),
      );
      continue;
    }
    if (getAtPath(next, patch.path) === undefined) {
      issues.push(
        prefabError(
          'invalid-override-path',
          `component "${where.componentId}" has no "${patch.path}" to override`,
          { path: `${at}${patch.path}` },
        ),
      );
      continue;
    }
    next = setAtPath(next, patch.path, patch.value);
  }

  return { component: next as GameObjectComponentDefinition, issues };
}

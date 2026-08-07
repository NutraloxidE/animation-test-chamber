/**
 * What a Prefab document must be true about *itself*, before anything else
 * looks at it.
 *
 * Split from the registry deliberately: these checks need one document and no
 * neighbours, so the migration can run them on a Prefab it has just built in
 * memory, and the publish endpoint can run them on a draft that is not in any
 * registry yet.
 *
 * Cross-document questions — does the nested Prefab exist, does the variant
 * parent cycle, does the hash still match — live in `registry.ts`, because they
 * cannot be answered without the other files.
 */
import type {
  GameObjectComponentDefinition,
  GameObjectPrefabAsset,
  GameObjectPrefabReference,
  PrefabNodeDefinition,
} from '@atc/schema';
import {
  GAME_OBJECT_COMPONENT_TYPES,
  PREFAB_SCHEMA_NAME_BY_DERIVATION,
  prefabAssetFilePath,
  prefabHasStoredRoot,
  validateAgainst,
} from '@atc/schema';
import { type PrefabIssue, prefabError } from './issues.ts';
import { validateProperties, type GameplayScriptRegistry } from '@atc/gameplay-sdk';

/**
 * Field names that only ever exist because something wrote runtime state into a
 * canonical file (§3.6, §17).
 *
 * A denylist is a blunt instrument and that is the point: this check has to
 * survive component types nobody has written yet, so it looks for the shape of
 * the mistake rather than for a known-bad schema. Every name here is a thing
 * that changes on a tick.
 */
const RUNTIME_STATE_FIELDS = new Set([
  'animationTime',
  'velocity',
  'mixer',
  'activeState',
  'transitionProgress',
  'runtimeHandle',
  'inputBuffer',
  'currentAction',
  'currentHp',
  'hp',
  'dead',
  'stamina',
  'cooldownRemaining',
  'lastDamageTick',
  'skeletonInstance',
]);

export function referenceOf(asset: GameObjectPrefabAsset): GameObjectPrefabReference {
  return {
    assetType: asset.metadata.assetType,
    assetId: asset.metadata.id,
    version: asset.metadata.version,
    contentHash: asset.metadata.contentHash,
  };
}

/** Every node in a stored Prefab's own tree, in declaration order. */
export function walkStoredNodes(root: PrefabNodeDefinition): PrefabNodeDefinition[] {
  const out: PrefabNodeDefinition[] = [];
  const visit = (node: PrefabNodeDefinition): void => {
    out.push(node);
    for (const child of node.children) {
      if (child.kind === 'inline') visit(child.node);
    }
  };
  visit(root);
  return out;
}

/** Every nested-Prefab reference a stored Prefab makes, in declaration order. */
export function nestedPrefabReferences(root: PrefabNodeDefinition): GameObjectPrefabReference[] {
  const out: GameObjectPrefabReference[] = [];
  for (const node of walkStoredNodes(root)) {
    for (const child of node.children) {
      if (child.kind === 'prefab-instance') out.push(child.prefab);
    }
  }
  return out;
}

function checkComponent(
  component: GameObjectComponentDefinition,
  nodeId: string,
  gameplayRegistry?: GameplayScriptRegistry,
): PrefabIssue[] {
  const issues: PrefabIssue[] = [];
  const at = `/nodes/${nodeId}/components/${component.componentId}`;
  const bad = (message: string): void => {
    issues.push(prefabError('invalid-component-constraint', message, { path: at }));
  };

  switch (component.componentType) {
    case 'model-renderer':
      if (component.model.kind === 'repository-model') {
        const path = component.model.assetPath;
        // The same refusal `validateSceneReferences` makes: these resolve
        // exactly once, in the tab that minted them, so a document containing
        // one looked fine when it was written and is broken for everyone else.
        if (path.startsWith('blob:') || path.startsWith('data:')) {
          bad(`model asset path "${path.slice(0, 24)}…" is a session-local URL`);
        }
      }
      break;
    case 'capsule-collider':
      if (component.height < component.radius * 2) {
        bad(
          `capsule height ${component.height} is shorter than its own diameter ${component.radius * 2}`,
        );
      }
      break;
    case 'equipment-sockets': {
      const seen = new Set<string>();
      for (const socket of component.sockets) {
        if (seen.has(socket.socketId)) bad(`socket "${socket.socketId}" is declared twice`);
        seen.add(socket.socketId);
      }
      break;
    }
    case 'camera':
      if (component.projection === 'perspective' && component.fieldOfViewDeg === undefined) {
        bad('a perspective camera needs a field of view');
      }
      if (component.projection === 'orthographic' && component.orthographicSize === undefined) {
        bad('an orthographic camera needs an orthographic size');
      }
      break;
    case 'light':
      if (component.lightType === 'spot' && component.spotAngleRad === undefined) {
        bad('a spot light needs a cone angle');
      }
      if (component.lightType === 'directional' && component.range !== undefined) {
        bad('a directional light has no range');
      }
      break;
    case 'tags': {
      const seen = new Set<string>();
      for (const tag of component.tags) {
        if (seen.has(tag)) bad(`tag "${tag}" is declared twice`);
        seen.add(tag);
      }
      break;
    }
    case 'script': {
      const entry = gameplayRegistry?.find(component.script);
      if (!entry) {
        issues.push(prefabError('gameplay-script-not-found', `${component.script.assetId}@${component.script.version} is unavailable`, { path: at }));
      } else if (entry.reference.contentHash !== component.script.contentHash) {
        issues.push(prefabError('gameplay-script-hash-mismatch', `${component.script.assetId}@${component.script.version} hash mismatch`, { path: at }));
      } else {
        for (const issue of validateProperties(entry.definition.properties, component.properties)) {
          issues.push(prefabError('gameplay-script-invalid-properties', issue.message, { path: `${at}/properties${issue.path}` }));
        }
      }
      break;
    }
    case 'animator':
    case 'character-motor':
      break;
  }
  return issues;
}

function findRuntimeState(value: unknown, path: string, into: PrefabIssue[]): void {
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) findRuntimeState(entry, `${path}/${index}`, into);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
      if (RUNTIME_STATE_FIELDS.has(key)) {
        into.push(
          prefabError(
            'runtime-state-in-canonical-document',
            `"${key}" is runtime state and cannot be stored in a canonical Prefab`,
            { path: `${path}/${key}` },
          ),
        );
      }
      findRuntimeState(member, `${path}/${key}`, into);
    }
  }
}

export interface ValidatePrefabDocumentOptions {
  /** Repository path the document was loaded from, when there is one. */
  filePath?: string;
  gameplayRegistry?: GameplayScriptRegistry;
}

/**
 * Everything checkable from one Prefab document.
 *
 * Schema first, because every later check assumes the shape: reading
 * `component.componentType` on something that failed schema validation would
 * report a second, invented problem on top of the real one.
 */
export function validatePrefabDocument(
  asset: GameObjectPrefabAsset,
  options: ValidatePrefabDocumentOptions = {},
): PrefabIssue[] {
  const issues: PrefabIssue[] = [];
  const reference = referenceOf(asset);
  const schemaName = PREFAB_SCHEMA_NAME_BY_DERIVATION[asset.derivation.mode];
  const schemaResult = validateAgainst(schemaName, asset);
  for (const issue of schemaResult.issues) {
    issues.push(
      prefabError('schema-invalid', `${issue.path} ${issue.message}`, {
        path: issue.path,
        reference,
      }),
    );
  }
  if (issues.length > 0) return issues;

  if (options.filePath !== undefined) {
    const expected = prefabAssetFilePath(asset.metadata.id, asset.metadata.version);
    if (options.filePath !== expected) {
      issues.push(
        prefabError(
          'prefab-path-mismatch',
          `${asset.metadata.id}@${asset.metadata.version} is stored at ${options.filePath}, not ${expected}`,
          { reference },
        ),
      );
    }
  }

  findRuntimeState(asset, '', issues);

  if (!prefabHasStoredRoot(asset)) return issues;

  const nodeIds = new Set<string>();
  for (const node of walkStoredNodes(asset.root)) {
    if (nodeIds.has(node.nodeId)) {
      issues.push(
        prefabError('duplicate-node-id', `node id "${node.nodeId}" is used twice`, {
          path: `/nodes/${node.nodeId}`,
          reference,
        }),
      );
    }
    nodeIds.add(node.nodeId);

    const componentIds = new Set<string>();
    for (const component of node.components) {
      if (componentIds.has(component.componentId)) {
        issues.push(
          prefabError(
            'duplicate-component-id',
            `node "${node.nodeId}" has two components called "${component.componentId}"`,
            { path: `/nodes/${node.nodeId}/components/${component.componentId}`, reference },
          ),
        );
      }
      componentIds.add(component.componentId);

      if (!(GAME_OBJECT_COMPONENT_TYPES as readonly string[]).includes(component.componentType)) {
        issues.push(
          prefabError(
            'unknown-component-type',
            `"${component.componentType}" is not a component type`,
            { path: `/nodes/${node.nodeId}/components/${component.componentId}`, reference },
          ),
        );
        continue;
      }
      issues.push(...checkComponent(component, node.nodeId, options.gameplayRegistry));
    }

    const instanceIds = new Set<string>();
    for (const child of node.children) {
      if (child.kind !== 'prefab-instance') continue;
      if (instanceIds.has(child.instanceId)) {
        issues.push(
          prefabError(
            'duplicate-node-id',
            `node "${node.nodeId}" nests two Prefab instances called "${child.instanceId}"`,
            { path: `/nodes/${node.nodeId}/children/${child.instanceId}`, reference },
          ),
        );
      }
      instanceIds.add(child.instanceId);
    }
  }

  return issues;
}

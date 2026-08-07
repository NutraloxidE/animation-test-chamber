/**
 * The production Scene operations, and the session that dispatches them.
 *
 * These sit beside `scene-session.test.ts` rather than replacing it. That file
 * still covers the retired entity operations, which still exist for the
 * migration path and its own tests; this one covers the thirteen operations
 * production actually writes since the Scene cutover (DECISION 0025).
 *
 * The fixture is a Scene whose `entities` collection **contradicts** its
 * `gameObjects` (§13.1). Every assertion below is written so that a fallback to
 * the entity path produces a wrong answer rather than the right one by
 * coincidence — which is the only way to test a cutover while both fields still
 * exist in the schema.
 */
import { describe, expect, it } from 'vitest';
import type {
  GameObjectSceneOperation,
  SceneDefinition,
  TransformDefinition,
} from '@atc/schema';
import { validateSceneGameObjectReferences } from '@atc/schema';
import { prefabCapabilityLookup } from '@atc/prefab-runtime';
import {
  DocumentEditSession,
  applySceneGameObjectOperation,
  changedGameObjectIds,
  exactPrefabReferenceKey,
  overridesClearedByPrefabSourceChange,
  uniqueGameObjectId,
} from '@atc/editor-core';
import { loadDemoProject } from '../../fixtures/project.ts';
import { contradictoryScene, loadTestPrefabRegistry } from '../../fixtures/scene.ts';

const project = loadDemoProject();
const registry = loadTestPrefabRegistry();

const context = {
  knownPrefabKeys: new Set(
    registry
      .all()
      .map((stored) => exactPrefabReferenceKey(registry.referenceTo(stored.id, stored.version))),
  ),
  capabilities: prefabCapabilityLookup(registry),
};

const IDENTITY: TransformDefinition = {
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
  scale: { x: 1, y: 1, z: 1 },
};

function apply(operation: GameObjectSceneOperation, scene = contradictoryScene()) {
  return applySceneGameObjectOperation(scene, operation, context);
}

function session(scene: SceneDefinition = contradictoryScene()) {
  return new DocumentEditSession<SceneDefinition, GameObjectSceneOperation>({
    target: { kind: 'scene', id: scene.id },
    baseRevisionId: project.revisionId,
    document: scene,
    apply: (document, operation) => applySceneGameObjectOperation(document, operation, context),
    validate: (document) => validateSceneGameObjectReferences(document),
  });
}

function gameObject(scene: SceneDefinition, id: string) {
  return (scene.gameObjects ?? []).find((entry) => entry.id === id);
}

describe('the fixture contradicts itself, on purpose', () => {
  it('names entirely different things in its two views', () => {
    const scene = contradictoryScene();
    const entityIds = scene.entities.map((entity) => entity.id);
    const gameObjectIds = (scene.gameObjects ?? []).map((entry) => entry.id);
    expect(entityIds.some((id) => gameObjectIds.includes(id))).toBe(false);
  });
});

describe('scene.place_prefab', () => {
  it('places a GameObject naming the exact Prefab version', () => {
    const result = apply({
      type: 'scene.place_prefab',
      gameObjectId: 'placed',
      displayName: 'Placed',
      prefab: registry.referenceTo('navigator', '1.0.0'),
    });
    expect(result.ok).toBe(true);
    const placed = gameObject(result.document!, 'placed');
    expect(placed?.prefab.version).toBe('1.0.0');
    expect(placed?.prefab.contentHash).toHaveLength(64);
  });

  it('opens unbound rather than stealing player 0', () => {
    const result = apply({
      type: 'scene.place_prefab',
      gameObjectId: 'placed',
      displayName: 'Placed',
      prefab: registry.referenceTo('navigator', '1.0.0'),
    });
    expect(gameObject(result.document!, 'placed')?.bindings).toEqual({});
    expect(gameObject(result.document!, 'placed')?.relations).toEqual({});
  });

  it('refuses a Prefab version the repository does not hold', () => {
    const result = apply({
      type: 'scene.place_prefab',
      gameObjectId: 'ghost',
      displayName: 'Ghost',
      prefab: {
        assetType: 'game-object-prefab',
        assetId: 'navigator',
        version: '9.9.9',
        contentHash: 'f'.repeat(64),
      },
    });
    expect(result.ok).toBe(false);
    expect(result.issues[0]!.message).toContain('never resolved to "latest"');
  });

  it('refuses an abstract Prefab, which has no placement', () => {
    const result = apply({
      type: 'scene.place_prefab',
      gameObjectId: 'abstract',
      displayName: 'Abstract',
      prefab: registry.referenceTo('humanoid-character-base', '1.0.0'),
    });
    expect(result.ok).toBe(false);
    expect(result.issues[0]!.keyword).toBe('abstract');
  });

  it('refuses a duplicate id rather than replacing what is there', () => {
    const result = apply({
      type: 'scene.place_prefab',
      gameObjectId: 'hero',
      displayName: 'Another hero',
      prefab: registry.referenceTo('navigator', '1.0.0'),
    });
    expect(result.ok).toBe(false);
    expect(result.issues[0]!.keyword).toBe('unique');
  });
});

describe('scene.delete_game_object', () => {
  it('refuses while another instance still targets it', () => {
    const result = apply({ type: 'scene.delete_game_object', gameObjectId: 'hero' });
    expect(result.ok).toBe(false);
    expect(result.issues[0]!.message).toContain('watcher');
  });

  it('deletes an untargeted object and clears the active camera it named', () => {
    const result = apply({ type: 'scene.delete_game_object', gameObjectId: 'watcher' });
    expect(result.ok).toBe(true);
    expect(gameObject(result.document!, 'watcher')).toBeUndefined();
    expect(result.document!.activeCameraGameObjectId).toBeUndefined();
  });

  it('refuses an id that is not in the Scene', () => {
    expect(apply({ type: 'scene.delete_game_object', gameObjectId: 'nobody' }).ok).toBe(false);
  });
});

describe('scene.duplicate_game_object', () => {
  it('copies the Prefab reference, transform and overrides', () => {
    const withOverride = apply({
      type: 'scene.set_component_override',
      gameObjectId: 'hero',
      override: {
        nodeId: 'root',
        componentId: 'model',
        patches: [{ path: '/castShadow', op: 'set', value: false }],
      },
    }).document!;
    const result = apply(
      { type: 'scene.duplicate_game_object', gameObjectId: 'hero' },
      withOverride,
    );
    const copy = gameObject(result.document!, 'hero-copy');
    expect(copy?.prefab).toEqual(gameObject(withOverride, 'hero')!.prefab);
    expect(copy?.transform).toEqual(gameObject(withOverride, 'hero')!.transform);
    expect(copy?.componentOverrides).toHaveLength(1);
  });

  it('does not copy a camera relation', () => {
    const result = apply({ type: 'scene.duplicate_game_object', gameObjectId: 'watcher' });
    expect(gameObject(result.document!, 'watcher')?.relations.cameraTargetGameObjectId).toBe(
      'hero',
    );
    // Two cameras following one character is a thing somebody might want and
    // never a thing duplication should decide for them.
    expect(gameObject(result.document!, 'watcher-copy')?.relations).toEqual({});
  });

  it('gives the duplicate a deterministic, collision-free id', () => {
    const once = apply({ type: 'scene.duplicate_game_object', gameObjectId: 'hero' }).document!;
    const twice = apply({ type: 'scene.duplicate_game_object', gameObjectId: 'hero' }, once)
      .document!;
    expect(gameObject(twice, 'hero-copy')).toBeDefined();
    expect(gameObject(twice, 'hero-copy-2')).toBeDefined();
  });

  it('inserts the copy directly after its source, not at the end', () => {
    const result = apply({ type: 'scene.duplicate_game_object', gameObjectId: 'hero' });
    const ids = (result.document!.gameObjects ?? []).map((entry) => entry.id);
    expect(ids.indexOf('hero-copy')).toBe(ids.indexOf('hero') + 1);
  });
});

describe('scene.set_transform and scene.rename_game_object', () => {
  it('writes the authored transform on the named instance only', () => {
    const moved = { ...IDENTITY, position: { x: 7, y: 0, z: -3 } };
    const result = apply({ type: 'scene.set_transform', gameObjectId: 'hero', transform: moved });
    expect(gameObject(result.document!, 'hero')?.transform.position).toEqual(moved.position);
    expect(gameObject(result.document!, 'understudy')?.transform.position).toEqual(
      IDENTITY.position,
    );
  });

  it('refuses a non-finite transform component', () => {
    const result = apply({
      type: 'scene.set_transform',
      gameObjectId: 'hero',
      transform: { ...IDENTITY, position: { x: Number.POSITIVE_INFINITY, y: 0, z: 0 } },
    });
    expect(result.ok).toBe(false);
    expect(result.issues[0]!.keyword).toBe('finite');
  });

  it('renames one instance and reports the id-keyed path', () => {
    const result = apply({
      type: 'scene.rename_game_object',
      gameObjectId: 'hero',
      displayName: 'Protagonist',
    });
    expect(gameObject(result.document!, 'hero')?.displayName).toBe('Protagonist');
    expect(result.changedPaths).toEqual(['/gameObjects/hero/displayName']);
  });
});

describe('scene.set_enabled', () => {
  it('clears the active camera when the camera itself is disabled', () => {
    const result = apply({
      type: 'scene.set_enabled',
      gameObjectId: 'watcher',
      enabled: false,
    });
    expect(result.ok).toBe(true);
    expect(result.document!.activeCameraGameObjectId).toBeUndefined();
  });

  it('leaves the active camera alone when a different object is disabled', () => {
    const result = apply({
      type: 'scene.set_enabled',
      gameObjectId: 'understudy',
      enabled: false,
    });
    expect(result.document!.activeCameraGameObjectId).toBe('watcher');
  });
});

describe('scene.set_prefab_source', () => {
  it('clears overrides the new Prefab graph cannot address', () => {
    const withOverride = apply({
      type: 'scene.set_component_override',
      gameObjectId: 'hero',
      override: {
        nodeId: 'root',
        componentId: 'equipment-sockets',
        patches: [{ path: '/enabled', op: 'set', value: false }],
      },
    }).document!;
    // The navigator Prefab has no equipment-sockets Component, so the override
    // has no target there. Carried across it would either dangle or land on
    // something that merely shares an id.
    const moved = apply(
      {
        type: 'scene.set_prefab_source',
        gameObjectId: 'hero',
        prefab: registry.referenceTo('navigator', '1.0.0'),
      },
      withOverride,
    );
    expect(
      gameObject(moved.document!, 'hero')?.componentOverrides.some(
        (override) => override.componentId === 'equipment-sockets',
      ),
    ).toBe(false);
  });

  it('reports the same cleared set the confirmation UI states', () => {
    const withOverride = apply({
      type: 'scene.set_component_override',
      gameObjectId: 'hero',
      override: {
        nodeId: 'root',
        componentId: 'equipment-sockets',
        patches: [{ path: '/enabled', op: 'set', value: false }],
      },
    }).document!;
    const target = registry.referenceTo('navigator', '1.0.0');
    const announced = overridesClearedByPrefabSourceChange(
      gameObject(withOverride, 'hero')!,
      context.capabilities(target),
    );
    const moved = apply(
      { type: 'scene.set_prefab_source', gameObjectId: 'hero', prefab: target },
      withOverride,
    ).document!;
    const survivors = gameObject(moved, 'hero')!.componentOverrides.length;
    // What the dialog says and what the operation does are one computation.
    expect(announced).toHaveLength(
      gameObject(withOverride, 'hero')!.componentOverrides.length - survivors,
    );
  });

  it('keeps an override the new Prefab still has a target for', () => {
    const withOverride = apply({
      type: 'scene.set_component_override',
      gameObjectId: 'hero',
      override: {
        nodeId: 'root',
        componentId: 'model',
        patches: [{ path: '/castShadow', op: 'set', value: false }],
      },
    }).document!;
    const moved = apply(
      {
        type: 'scene.set_prefab_source',
        gameObjectId: 'hero',
        prefab: registry.referenceTo('navigator', '1.0.0'),
      },
      withOverride,
    ).document!;
    expect(gameObject(moved, 'hero')?.componentOverrides).toHaveLength(1);
  });
});

describe('component overrides', () => {
  it('refuses a node the resolved Prefab does not have', () => {
    const result = apply({
      type: 'scene.set_component_override',
      gameObjectId: 'hero',
      override: {
        nodeId: 'no-such-node',
        componentId: 'model',
        patches: [{ path: '/castShadow', op: 'set', value: false }],
      },
    });
    expect(result.ok).toBe(false);
    expect(result.issues[0]!.message).toContain('no node');
  });

  it('refuses a Component the node does not have', () => {
    const result = apply({
      type: 'scene.set_component_override',
      gameObjectId: 'hero',
      override: {
        nodeId: 'root',
        componentId: 'no-such-component',
        patches: [{ path: '/castShadow', op: 'set', value: false }],
      },
    });
    expect(result.ok).toBe(false);
  });

  it('replaces rather than appends when the same target is set twice', () => {
    const once = apply({
      type: 'scene.set_component_override',
      gameObjectId: 'hero',
      override: {
        nodeId: 'root',
        componentId: 'model',
        patches: [{ path: '/castShadow', op: 'set', value: false }],
      },
    }).document!;
    const twice = apply(
      {
        type: 'scene.set_component_override',
        gameObjectId: 'hero',
        override: {
          nodeId: 'root',
          componentId: 'model',
          patches: [{ path: '/receiveShadow', op: 'set', value: false }],
        },
      },
      once,
    ).document!;
    expect(gameObject(twice, 'hero')?.componentOverrides).toHaveLength(1);
  });

  it('refuses clearing an override that is not there', () => {
    const result = apply({
      type: 'scene.clear_component_override',
      gameObjectId: 'hero',
      nodeId: 'root',
      componentId: 'model',
    });
    expect(result.ok).toBe(false);
  });
});

describe('bindings and relations', () => {
  it('refuses a character intent on a Prefab with no motor', () => {
    const result = apply({
      type: 'scene.set_instance_binding',
      gameObjectId: 'watcher',
      bindings: { characterIntent: { kind: 'human', playerIndex: 0 } },
    });
    expect(result.ok).toBe(false);
    expect(result.issues[0]!.keyword).toBe('capability');
  });

  it('accepts a character intent on a Prefab that has one', () => {
    const result = apply({
      type: 'scene.set_instance_binding',
      gameObjectId: 'hero',
      bindings: { characterIntent: { kind: 'human', playerIndex: 0 } },
    });
    expect(result.ok).toBe(true);
  });

  it('refuses a camera relation from a Prefab with no camera', () => {
    const result = apply({
      type: 'scene.set_relation',
      gameObjectId: 'hero',
      relations: { cameraTargetGameObjectId: 'understudy' },
    });
    expect(result.ok).toBe(false);
  });

  it('refuses a camera that follows itself', () => {
    const result = apply({
      type: 'scene.set_relation',
      gameObjectId: 'watcher',
      relations: { cameraTargetGameObjectId: 'watcher' },
    });
    expect(result.ok).toBe(false);
  });

  it('refuses a relation naming a GameObject that is not in the Scene', () => {
    const result = apply({
      type: 'scene.set_relation',
      gameObjectId: 'watcher',
      relations: { cameraTargetGameObjectId: 'nobody' },
    });
    expect(result.ok).toBe(false);
  });
});

describe('scene.reorder_game_object', () => {
  it('changes declaration order and nothing else', () => {
    const before = contradictoryScene();
    const result = apply({
      type: 'scene.reorder_game_object',
      gameObjectId: 'watcher',
      toIndex: 0,
    });
    expect((result.document!.gameObjects ?? []).map((entry) => entry.id)[0]).toBe('watcher');
    // Relations are id-based, which is what makes reordering safe at all.
    expect(gameObject(result.document!, 'watcher')?.relations).toEqual(
      gameObject(before, 'watcher')?.relations,
    );
  });

  it('refuses an index outside the Scene', () => {
    expect(
      apply({ type: 'scene.reorder_game_object', gameObjectId: 'hero', toIndex: 99 }).ok,
    ).toBe(false);
  });
});

describe('scene.set_active_camera', () => {
  it('refuses an unknown id', () => {
    expect(apply({ type: 'scene.set_active_camera', gameObjectId: 'nobody' }).ok).toBe(false);
  });

  it('refuses a GameObject with no Camera Component', () => {
    const result = apply({ type: 'scene.set_active_camera', gameObjectId: 'hero' });
    expect(result.ok).toBe(false);
    expect(result.issues[0]!.keyword).toBe('capability');
  });

  it('refuses a disabled camera', () => {
    const disabled = apply({
      type: 'scene.set_enabled',
      gameObjectId: 'watcher',
      enabled: false,
    }).document!;
    expect(
      apply({ type: 'scene.set_active_camera', gameObjectId: 'watcher' }, disabled).ok,
    ).toBe(false);
  });

  it('accepts an enabled Camera GameObject', () => {
    expect(apply({ type: 'scene.set_active_camera', gameObjectId: 'watcher' }).ok).toBe(true);
  });

  it('accepts null, which clears it', () => {
    const result = apply({ type: 'scene.set_active_camera', gameObjectId: null });
    expect(result.document!.activeCameraGameObjectId).toBeUndefined();
  });
});

describe('no production operation touches the entity mirror', () => {
  /*
   * Byte-for-byte rather than field-by-field. An operation that reverse-
   * generated an *equivalent* entity list would still be the dual source of
   * truth this cutover removes, and a field comparison would let it through.
   */
  const operations: GameObjectSceneOperation[] = [
    {
      type: 'scene.place_prefab',
      gameObjectId: 'placed',
      displayName: 'Placed',
      prefab: registry.referenceTo('navigator', '1.0.0'),
    },
    { type: 'scene.delete_game_object', gameObjectId: 'understudy' },
    { type: 'scene.duplicate_game_object', gameObjectId: 'hero' },
    { type: 'scene.rename_game_object', gameObjectId: 'hero', displayName: 'Protagonist' },
    { type: 'scene.set_transform', gameObjectId: 'hero', transform: IDENTITY },
    { type: 'scene.set_enabled', gameObjectId: 'understudy', enabled: false },
    {
      type: 'scene.set_prefab_source',
      gameObjectId: 'understudy',
      prefab: registry.referenceTo('navigator', '1.0.0'),
    },
    {
      type: 'scene.set_component_override',
      gameObjectId: 'hero',
      override: {
        nodeId: 'root',
        componentId: 'model',
        patches: [{ path: '/castShadow', op: 'set', value: false }],
      },
    },
    {
      type: 'scene.set_instance_binding',
      gameObjectId: 'hero',
      bindings: { characterIntent: { kind: 'none' } },
    },
    {
      type: 'scene.set_relation',
      gameObjectId: 'watcher',
      relations: { cameraTargetGameObjectId: 'understudy' },
    },
    { type: 'scene.reorder_game_object', gameObjectId: 'watcher', toIndex: 0 },
    { type: 'scene.set_active_camera', gameObjectId: null },
  ];

  it.each(operations.map((operation) => [operation.type, operation] as const))(
    '%s leaves scene.entities byte-identical',
    (_label, operation) => {
      const scene = contradictoryScene();
      const before = JSON.stringify(scene.entities);
      const result = applySceneGameObjectOperation(scene, operation, context);
      expect(result.ok).toBe(true);
      expect(JSON.stringify(result.document!.entities)).toBe(before);
    },
  );

  it('leaves the entity mirror alone through clear_component_override too', () => {
    const withOverride = apply({
      type: 'scene.set_component_override',
      gameObjectId: 'hero',
      override: {
        nodeId: 'root',
        componentId: 'model',
        patches: [{ path: '/castShadow', op: 'set', value: false }],
      },
    }).document!;
    const before = JSON.stringify(withOverride.entities);
    const cleared = apply(
      {
        type: 'scene.clear_component_override',
        gameObjectId: 'hero',
        nodeId: 'root',
        componentId: 'model',
      },
      withOverride,
    );
    expect(JSON.stringify(cleared.document!.entities)).toBe(before);
  });
});

describe('purity and determinism', () => {
  it('never mutates the document it is given', () => {
    const scene = contradictoryScene();
    const before = JSON.stringify(scene);
    apply({ type: 'scene.rename_game_object', gameObjectId: 'hero', displayName: 'X' }, scene);
    expect(JSON.stringify(scene)).toBe(before);
  });

  it('produces the same document from the same input twice', () => {
    const scene = contradictoryScene();
    const operation: GameObjectSceneOperation = {
      type: 'scene.duplicate_game_object',
      gameObjectId: 'hero',
    };
    expect(JSON.stringify(apply(operation, scene).document)).toBe(
      JSON.stringify(apply(operation, scene).document),
    );
  });
});

describe('changedGameObjectIds', () => {
  it('names only what actually changed', () => {
    const scene = contradictoryScene();
    const renamed = apply(
      { type: 'scene.rename_game_object', gameObjectId: 'hero', displayName: 'X' },
      scene,
    ).document!;
    expect(changedGameObjectIds(scene, renamed)).toEqual(['hero']);
  });

  it('names a placement without calling it a reorder of everything', () => {
    const scene = contradictoryScene();
    const placed = apply(
      {
        type: 'scene.place_prefab',
        gameObjectId: 'placed',
        displayName: 'Placed',
        prefab: registry.referenceTo('navigator', '1.0.0'),
      },
      scene,
    ).document!;
    expect(changedGameObjectIds(scene, placed)).toEqual(['placed']);
  });

  it('names a deletion', () => {
    const scene = contradictoryScene();
    const deleted = apply(
      { type: 'scene.delete_game_object', gameObjectId: 'understudy' },
      scene,
    ).document!;
    expect(changedGameObjectIds(scene, deleted)).toContain('understudy');
  });

  it('names every object involved in a reorder, which changes no bytes', () => {
    const scene = contradictoryScene();
    const reordered = apply(
      { type: 'scene.reorder_game_object', gameObjectId: 'watcher', toIndex: 0 },
      scene,
    ).document!;
    expect(changedGameObjectIds(scene, reordered).length).toBeGreaterThan(1);
  });
});

describe('the session dispatches only GameObject operations', () => {
  it('stages an id-keyed path, never an index-keyed one', () => {
    const s = session();
    s.dispatch({ type: 'scene.rename_game_object', gameObjectId: 'hero', displayName: 'X' });
    s.stageAll();
    expect(s.stagedPaths).toEqual(['/gameObjects/hero/displayName']);
  });

  it('keeps a refusal out of the preview document', () => {
    const s = session();
    const before = JSON.stringify(s.previewDocument);
    const result = s.dispatch({ type: 'scene.set_active_camera', gameObjectId: 'hero' });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(s.previewDocument)).toBe(before);
  });

  it('builds an apply request naming the scene target and its operations', () => {
    const s = session();
    s.dispatch({ type: 'scene.rename_game_object', gameObjectId: 'hero', displayName: 'X' });
    s.stageAll();
    const request = s.buildApplyRequest('rename the hero');
    expect(request.target).toEqual({ kind: 'scene', id: contradictoryScene().id });
    expect(request.operations.map((operation) => operation.type)).toEqual([
      'scene.rename_game_object',
    ]);
  });
});

describe('unique ids', () => {
  it('is deterministic and collision-free', () => {
    expect(uniqueGameObjectId('crate', [])).toBe('crate');
    expect(uniqueGameObjectId('crate', [{ id: 'crate' }])).toBe('crate-2');
    expect(uniqueGameObjectId('crate', [{ id: 'crate' }, { id: 'crate-2' }])).toBe('crate-3');
  });
});

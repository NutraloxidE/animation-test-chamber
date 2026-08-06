/**
 * Scene GameObject production cutover harness (§14).
 *
 * These stages exist to answer one question the previous harnesses could not
 * be asked: *is the production Scene path actually running on GameObjects?*
 *
 * The Prefab and GameObject harnesses check that the Prefab spine resolves and
 * that the runtime runs. The renderer harness checks that Components produce
 * drawables. None of them could tell the difference between a Scene Editor that
 * had been cut over and one that still read `scene.entities` and happened to
 * agree with them — because while the two views agreed, every assertion passed
 * either way.
 *
 * So the fixture here is a Scene whose two views **contradict each other**: the
 * `gameObjects` hold the objects that ought to appear, and `entities` holds
 * something else entirely. Any code that falls back to the entity path produces
 * the wrong answer, loudly, instead of the right answer by coincidence.
 *
 * Everything runs in Node with no canvas, no DOM and no GPU, which is what makes
 * it cheap enough to sit inside `harness:one-shot`.
 */
import { deepStrictEqual } from 'node:assert';
import { TERRAIN_PRESETS } from '@atc/terrain-runtime';
import { instantiateScene, type RuntimeScene } from '@atc/game-object-runtime';
import { prefabCapabilityLookup, type PrefabAssetRegistry } from '@atc/prefab-runtime';
import {
  applySceneGameObjectOperation,
  changedGameObjectIds,
  exactPrefabReferenceKey,
  type SceneGameObjectOperationContext,
} from '@atc/editor-core';
import type {
  CameraSceneEntity,
  GameObjectInstanceDefinition,
  GameObjectSceneOperation,
  ProjectDefinition,
  SceneDefinition,
  TransformDefinition,
} from '@atc/schema';
import { sceneHierarchyRows } from '../apps/web/src/scene-editor/scene-hierarchy.ts';
import {
  selectionForRuntimeNode,
  operationTarget,
} from '../apps/web/src/scene-editor/scene-selection.ts';
import {
  drawableNodes,
  projectRuntimeScene,
} from '../apps/web/src/game-objects/render-projection.ts';
import { loadAssetRegistry, loadCanonicalProject } from './animation-assets.ts';
import { printStage, stage, type StageIssue, type StageResult } from './lib.ts';
import { loadPrefabRegistry } from './prefabs.ts';

const PROJECT_FILE = 'projects/demo-character/project.json';

const IDENTITY: TransformDefinition = {
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
  scale: { x: 1, y: 1, z: 1 },
};

function terrain() {
  const project = loadCanonicalProject();
  return (
    TERRAIN_PRESETS.find((preset) => preset.id === project.defaultTerrainPresetId) ??
    TERRAIN_PRESETS[0]!
  );
}

function instance(
  registry: PrefabAssetRegistry,
  id: string,
  prefabId: string,
  overrides: Partial<GameObjectInstanceDefinition> = {},
): GameObjectInstanceDefinition {
  return {
    schemaVersion: 2,
    id,
    displayName: id,
    enabled: true,
    prefab: registry.referenceTo(prefabId, '1.0.0'),
    transform: IDENTITY,
    componentOverrides: [],
    bindings: {},
    relations: {},
    ...overrides,
  } as GameObjectInstanceDefinition;
}

/**
 * A Scene whose two views deliberately disagree (§13.1).
 *
 * `gameObjects` names a character, a camera and a light Prefab. `entities` names
 * three completely different things with completely different ids. There is no
 * reading of this document under which both are right, which is exactly what
 * makes it able to catch a fallback.
 */
function contradictoryScene(registry: PrefabAssetRegistry): SceneDefinition {
  const decoy: CameraSceneEntity = {
    schemaVersion: 2,
    id: 'ENTITY-ONLY-DECOY',
    displayName: 'Entity-only decoy',
    enabled: true,
    transform: IDENTITY,
    kind: 'camera',
    projection: 'perspective',
    fieldOfViewDeg: 60,
  };

  return {
    schemaVersion: 2,
    id: 'cutover-contradiction',
    displayName: 'Cutover contradiction',
    /*
     * Three entities that name nothing in the GameObject view. If any
     * production surface still reads this collection it will report an object
     * called `ENTITY-ONLY-DECOY`, and every stage below asserts that no such
     * name appears anywhere.
     */
    entities: [
      decoy,
      { ...decoy, id: 'ENTITY-ONLY-DECOY-2', displayName: 'Second decoy' },
      { ...decoy, id: 'ENTITY-ONLY-DECOY-3', displayName: 'Third decoy' },
    ],
    gameObjects: [
      instance(registry, 'hero', 'quaternius-knight', {
        transform: { ...IDENTITY, position: { x: 1, y: 0, z: 0 } },
      }),
      instance(registry, 'watcher', 'default-scene-camera', {
        relations: { cameraTargetGameObjectId: 'hero' },
      }),
      instance(registry, 'understudy', 'quaternius-knight'),
    ],
    intentTracks: [],
    activeCameraGameObjectId: 'watcher',
  };
}

function contextFor(registry: PrefabAssetRegistry): SceneGameObjectOperationContext {
  return {
    knownPrefabKeys: new Set(
      registry
        .all()
        .map((stored) => exactPrefabReferenceKey(registry.referenceTo(stored.id, stored.version))),
    ),
    capabilities: prefabCapabilityLookup(registry),
  };
}

function runScene(scene: SceneDefinition, project: ProjectDefinition): RuntimeScene {
  return instantiateScene({
    scene,
    project,
    terrain: terrain(),
    services: {
      animationRegistry: loadAssetRegistry(),
      prefabRegistry: loadPrefabRegistry(),
      clock: { fixedDeltaSeconds: 1 / 60 },
      terrain: terrain(),
    },
  });
}

/** Every string a projection or a hierarchy row could carry, flattened. */
function textOf(value: unknown): string {
  return JSON.stringify(value);
}

/* -------------------------------------------------------------------------- */
/* Stage 1 — production reads gameObjects and ignores entities                */
/* -------------------------------------------------------------------------- */

export function sceneReadsGameObjectsStage(): StageResult {
  return stage(
    'the production Scene resolves gameObjects and ignores entities',
    {
      reproduce: 'npx tsx harness/check-scene-gameobject-cutover.ts',
      suggestion:
        'an entity id appearing here means a production surface still reads scene.entities',
    },
    () => {
      const registry = loadPrefabRegistry();
      const project = loadCanonicalProject();
      const scene = contradictoryScene(registry);
      const issues: StageIssue[] = [];

      const runtime = runScene(scene, project);
      const projection = projectRuntimeScene(runtime, scene.activeCameraGameObjectId);
      const rows = sceneHierarchyRows({ scene, registry });

      const complain = (surface: string, expected: string, actual: string): void => {
        issues.push({
          files: [
            'apps/web/src/scene-editor/use-scene-runtime.ts',
            'apps/web/src/scene-editor/scene-hierarchy.ts',
          ],
          expected,
          actual,
          message: `${surface}: the production Scene path disagrees with scene.gameObjects`,
        });
      };

      const runtimeIds = runtime.gameObjects.map((gameObject) => gameObject.id).sort();
      try {
        deepStrictEqual(runtimeIds, ['hero', 'understudy', 'watcher']);
      } catch {
        complain('RuntimeScene', 'hero, understudy, watcher', runtimeIds.join(', '));
      }

      const rowIds = rows.map((row) => row.instanceId).sort();
      try {
        deepStrictEqual(rowIds, ['hero', 'understudy', 'watcher']);
      } catch {
        complain('hierarchy rows', 'hero, understudy, watcher', rowIds.join(', '));
      }

      /*
       * The decoy must appear nowhere. Checked as a substring over the whole
       * serialised output rather than field by field, because the failure this
       * catches is "some surface leaked an entity through", and which field it
       * came out of is not knowable in advance.
       */
      for (const [surface, value] of [
        ['render projection', projection],
        ['hierarchy rows', rows],
      ] as const) {
        if (textOf(value).includes('ENTITY-ONLY-DECOY')) {
          complain(surface, 'no entity to appear', 'an entity id is present');
        }
      }

      // The active camera resolves through the Camera Component, not by
      // "the first object that looks like a camera".
      if (projection.activeCamera === undefined) {
        complain('active camera', 'the watcher camera node', 'nothing resolved');
      } else if (!projection.activeCamera.gameObjectId.startsWith('watcher')) {
        complain('active camera', 'watcher', projection.activeCamera.gameObjectId);
      }

      runtime.dispose();
      return {
        ok: issues.length === 0,
        issues,
        output: `${runtimeIds.length} GameObject(s) run; ${scene.entities.length} contradictory entities ignored`,
      };
    },
  );
}

/* -------------------------------------------------------------------------- */
/* Stage 2 — the viewport projects the RuntimeScene through the renderer      */
/* -------------------------------------------------------------------------- */

export function sceneViewportProjectionStage(): StageResult {
  return stage(
    'the Scene Viewport projects RuntimeScene through GameObjectRenderer',
    {
      reproduce: 'npx tsx harness/check-scene-gameobject-cutover.ts',
      suggestion: 'a missing drawable means the viewport is not going through the projection layer',
    },
    () => {
      const registry = loadPrefabRegistry();
      const project = loadCanonicalProject();
      const scene = contradictoryScene(registry);
      const issues: StageIssue[] = [];

      const runtime = runScene(scene, project);
      const projection = projectRuntimeScene(runtime, scene.activeCameraGameObjectId);
      const drawable = drawableNodes(projection);

      const expect = (condition: boolean, expected: string, actual: string): void => {
        if (condition) return;
        issues.push({
          files: ['apps/web/src/scene-editor/viewport/SceneViewport.tsx'],
          expected,
          actual,
          message: `the Scene viewport would not draw: ${expected}`,
        });
      };

      const heroNodes = drawable.filter((node) => node.gameObjectId.startsWith('hero'));
      expect(heroNodes.some((node) => node.model !== undefined), 'a model for "hero"', 'none');
      expect(heroNodes.some((node) => node.animator !== undefined), 'an Animator on "hero"', 'none');
      expect(
        drawable.some((node) => node.gameObjectId.startsWith('watcher') && node.camera),
        'a camera gizmo for "watcher"',
        'none',
      );

      // A disabled object contributes nothing, and takes nothing with it.
      const disabled: SceneDefinition = {
        ...scene,
        gameObjects: (scene.gameObjects ?? []).map((gameObject) =>
          gameObject.id === 'understudy' ? { ...gameObject, enabled: false } : gameObject,
        ),
      };
      const disabledRuntime = runScene(disabled, project);
      const disabledDrawable = drawableNodes(
        projectRuntimeScene(disabledRuntime, disabled.activeCameraGameObjectId),
      );
      expect(
        !disabledDrawable.some((node) => node.gameObjectId.startsWith('understudy')),
        'a disabled GameObject to draw nothing',
        'it still draws',
      );
      expect(
        disabledDrawable.some((node) => node.gameObjectId.startsWith('hero')),
        'the other objects to be unaffected',
        'they vanished too',
      );

      runtime.dispose();
      disabledRuntime.dispose();
      return {
        ok: issues.length === 0,
        issues,
        output: `${drawable.length} drawable node(s)`,
      };
    },
  );
}

/* -------------------------------------------------------------------------- */
/* Stage 3 — every operation is deterministic and pure                        */
/* -------------------------------------------------------------------------- */

/** The thirteen production operations, each against the contradictory fixture. */
function everyOperation(registry: PrefabAssetRegistry): GameObjectSceneOperation[] {
  return [
    {
      type: 'scene.place_prefab',
      gameObjectId: 'placed',
      displayName: 'Placed',
      prefab: registry.referenceTo('navigator', '1.0.0'),
    },
    { type: 'scene.delete_game_object', gameObjectId: 'understudy' },
    { type: 'scene.duplicate_game_object', gameObjectId: 'hero' },
    { type: 'scene.rename_game_object', gameObjectId: 'hero', displayName: 'Protagonist' },
    {
      type: 'scene.set_transform',
      gameObjectId: 'hero',
      transform: { ...IDENTITY, position: { x: 4, y: 0, z: 2 } },
    },
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
      bindings: { characterIntent: { kind: 'human', playerIndex: 0 } },
    },
    {
      type: 'scene.set_relation',
      gameObjectId: 'watcher',
      relations: { cameraTargetGameObjectId: 'understudy' },
    },
    { type: 'scene.reorder_game_object', gameObjectId: 'watcher', toIndex: 0 },
    { type: 'scene.set_active_camera', gameObjectId: null },
  ];
}

export function sceneOperationsStage(): StageResult {
  return stage(
    'every GameObject Scene operation is deterministic and leaves entities alone',
    {
      reproduce: 'npx tsx harness/check-scene-gameobject-cutover.ts',
      suggestion:
        'a mutated input means the engine is not pure; a changed entity list means a production write reached the legacy mirror',
    },
    () => {
      const registry = loadPrefabRegistry();
      const context = contextFor(registry);
      const scene = contradictoryScene(registry);
      const issues: StageIssue[] = [];

      const complain = (operation: string, expected: string, actual: string): void => {
        issues.push({
          files: ['packages/editor-core/src/game-object-operations.ts'],
          expected,
          actual,
          message: `${operation}: ${expected}`,
        });
      };

      /*
       * `clear_component_override` needs an override to clear, so it runs after
       * the one that sets it rather than against the bare fixture. Every other
       * operation is independent and runs against a fresh copy.
       */
      const withOverride = applySceneGameObjectOperation(
        scene,
        {
          type: 'scene.set_component_override',
          gameObjectId: 'hero',
          override: {
            nodeId: 'root',
            componentId: 'model',
            patches: [{ path: '/castShadow', op: 'set', value: false }],
          },
        },
        context,
      );
      const operations: { operation: GameObjectSceneOperation; on: SceneDefinition }[] = [
        ...everyOperation(registry).map((operation) => ({ operation, on: scene })),
        {
          operation: {
            type: 'scene.clear_component_override',
            gameObjectId: 'hero',
            nodeId: 'root',
            componentId: 'model',
          },
          on: withOverride.document ?? scene,
        },
      ];

      const applied = new Set<string>();
      for (const { operation, on } of operations) {
        applied.add(operation.type);
        const before = JSON.stringify(on);
        const beforeEntities = JSON.stringify(on.entities);

        const first = applySceneGameObjectOperation(on, operation, context);
        const second = applySceneGameObjectOperation(on, operation, context);

        if (!first.ok || first.document === undefined) {
          complain(
            operation.type,
            'the operation to succeed against the fixture',
            first.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '),
          );
          continue;
        }

        // Pure: the input document is untouched.
        if (JSON.stringify(on) !== before) {
          complain(operation.type, 'the input Scene to be unmodified', 'it was mutated in place');
        }
        // Deterministic: applying twice to one input yields one answer.
        if (JSON.stringify(first.document) !== JSON.stringify(second.document)) {
          complain(operation.type, 'two applications to agree', 'they produced different documents');
        }
        /*
         * The entity mirror is passed through by identity (§9.1, §13.7).
         * Compared byte-for-byte rather than field-by-field: an operation that
         * reverse-generated an *equivalent* entity list would still be the dual
         * source of truth this cutover removes.
         */
        if (JSON.stringify(first.document.entities) !== beforeEntities) {
          complain(operation.type, 'scene.entities to be byte-identical', 'the mirror was written');
        }
        // Changed ids are derived from the documents, never declared.
        const changed = changedGameObjectIds(on, first.document);
        if (changed.length === 0 && operation.type !== 'scene.set_active_camera') {
          complain(operation.type, 'at least one changed GameObject id', 'none reported');
        }
      }

      if (applied.size !== 13) {
        complain(
          'operation coverage',
          'all thirteen operations exercised',
          `${applied.size}: ${[...applied].sort().join(', ')}`,
        );
      }

      return {
        ok: issues.length === 0,
        issues,
        output: `${applied.size} operation(s) exercised`,
      };
    },
  );
}

/* -------------------------------------------------------------------------- */
/* Stage 4 — the refusals §7 and §8 require                                   */
/* -------------------------------------------------------------------------- */

export function sceneOperationRefusalsStage(): StageResult {
  return stage(
    'Scene operations refuse what the Prefab cannot support',
    {
      reproduce: 'npx tsx harness/check-scene-gameobject-cutover.ts',
      suggestion:
        'an accepted refusal case means a capability check is missing from the operation engine',
    },
    () => {
      const registry = loadPrefabRegistry();
      const context = contextFor(registry);
      const scene = contradictoryScene(registry);
      const issues: StageIssue[] = [];

      const refuse = (label: string, operation: GameObjectSceneOperation, on = scene): void => {
        const result = applySceneGameObjectOperation(on, operation, context);
        if (result.ok) {
          issues.push({
            files: ['packages/editor-core/src/game-object-operations.ts'],
            expected: `${label} to be refused`,
            actual: 'it was accepted',
            message: `${label} was accepted`,
          });
        }
      };
      const accept = (label: string, operation: GameObjectSceneOperation, on = scene) => {
        const result = applySceneGameObjectOperation(on, operation, context);
        if (!result.ok) {
          issues.push({
            files: ['packages/editor-core/src/game-object-operations.ts'],
            expected: `${label} to be accepted`,
            actual: result.issues.map((issue) => issue.message).join('; '),
            message: `${label} was refused`,
          });
        }
        return result;
      };

      // §7.4 / §13.11 — the active camera's three refusals and one success.
      refuse('an unknown active camera id', {
        type: 'scene.set_active_camera',
        gameObjectId: 'nobody',
      });
      refuse('an active camera with no Camera Component', {
        type: 'scene.set_active_camera',
        gameObjectId: 'hero',
      });
      const disabled = applySceneGameObjectOperation(
        scene,
        { type: 'scene.set_enabled', gameObjectId: 'watcher', enabled: false },
        context,
      ).document;
      if (disabled) {
        refuse(
          'a disabled active camera',
          { type: 'scene.set_active_camera', gameObjectId: 'watcher' },
          disabled,
        );
      }
      accept('an enabled Camera GameObject as active camera', {
        type: 'scene.set_active_camera',
        gameObjectId: 'watcher',
      });

      // §8.2 — a Prefab reference the repository does not hold.
      refuse('an unknown Prefab reference', {
        type: 'scene.place_prefab',
        gameObjectId: 'ghost',
        displayName: 'Ghost',
        prefab: {
          assetType: 'game-object-prefab',
          assetId: 'no-such-prefab',
          version: '1.0.0',
          contentHash: 'f'.repeat(64),
        },
      });

      // §8.5 — an override addressing a node or Component the Prefab lacks.
      refuse('an override on a node the Prefab has no such node', {
        type: 'scene.set_component_override',
        gameObjectId: 'hero',
        override: {
          nodeId: 'no-such-node',
          componentId: 'model',
          patches: [{ path: '/castShadow', op: 'set', value: false }],
        },
      });
      refuse('an override on a Component the node does not have', {
        type: 'scene.set_component_override',
        gameObjectId: 'hero',
        override: {
          nodeId: 'root',
          componentId: 'no-such-component',
          patches: [{ path: '/castShadow', op: 'set', value: false }],
        },
      });

      // §8.3 — deleting must not leave a dangling relation.
      refuse('deleting a GameObject another instance targets', {
        type: 'scene.delete_game_object',
        gameObjectId: 'hero',
      });

      // §6.1 — a character intent with no motor to drive it.
      refuse('binding a character intent to a Prefab with no motor', {
        type: 'scene.set_instance_binding',
        gameObjectId: 'watcher',
        bindings: { characterIntent: { kind: 'human', playerIndex: 0 } },
      });

      // §6.2 — a camera target on a Prefab with no camera.
      refuse('aiming a camera relation from a Prefab with no camera', {
        type: 'scene.set_relation',
        gameObjectId: 'hero',
        relations: { cameraTargetGameObjectId: 'understudy' },
      });

      // §13.10 — duplicating drops the camera relation.
      const duplicated = accept('duplicating the camera', {
        type: 'scene.duplicate_game_object',
        gameObjectId: 'watcher',
      });
      const copy = duplicated.document?.gameObjects?.find((entry) => entry.id === 'watcher-copy');
      if (copy && copy.relations.cameraTargetGameObjectId !== undefined) {
        issues.push({
          files: ['packages/editor-core/src/game-object-operations.ts'],
          expected: 'the duplicate to carry no camera target',
          actual: String(copy.relations.cameraTargetGameObjectId),
          message: 'duplicating a camera copied its target relation',
        });
      }

      // §7.2 — changing the Prefab source clears incompatible overrides.
      const withOverride = applySceneGameObjectOperation(
        scene,
        {
          type: 'scene.set_component_override',
          gameObjectId: 'hero',
          override: {
            nodeId: 'root',
            componentId: 'equipment-sockets',
            patches: [{ path: '/enabled', op: 'set', value: false }],
          },
        },
        context,
      ).document;
      if (withOverride) {
        const moved = applySceneGameObjectOperation(
          withOverride,
          {
            type: 'scene.set_prefab_source',
            gameObjectId: 'hero',
            prefab: registry.referenceTo('navigator', '1.0.0'),
          },
          context,
        ).document;
        const remaining =
          moved?.gameObjects?.find((entry) => entry.id === 'hero')?.componentOverrides ?? [];
        if (remaining.some((override) => override.componentId === 'equipment-sockets')) {
          issues.push({
            files: ['packages/editor-core/src/game-object-operations.ts'],
            expected: 'an override the new Prefab cannot address to be cleared',
            actual: 'it survived the source change',
            message: 'a Prefab source change carried an incompatible override across',
          });
        }
      }

      // §8.4 — reordering preserves id-based relations.
      const reordered = accept('reordering', {
        type: 'scene.reorder_game_object',
        gameObjectId: 'watcher',
        toIndex: 0,
      });
      const watcher = reordered.document?.gameObjects?.find((entry) => entry.id === 'watcher');
      if (watcher?.relations.cameraTargetGameObjectId !== 'hero') {
        issues.push({
          files: ['packages/editor-core/src/game-object-operations.ts'],
          expected: 'the camera relation to survive a reorder unchanged',
          actual: String(watcher?.relations.cameraTargetGameObjectId),
          message: 'reordering changed an id-based relation',
        });
      }

      return { ok: issues.length === 0, issues, output: '11 refusal/acceptance case(s)' };
    },
  );
}

/* -------------------------------------------------------------------------- */
/* Stage 5 — root instance vs child runtime node identity                     */
/* -------------------------------------------------------------------------- */

export function selectionIdentityStage(): StageResult {
  return stage(
    'a child runtime node selects for inspection and never becomes an operation target',
    {
      reproduce: 'npx tsx harness/check-scene-gameobject-cutover.ts',
      suggestion:
        'an operation target containing a slash means a runtime node id reached a persistent operation',
    },
    () => {
      const registry = loadPrefabRegistry();
      const project = loadCanonicalProject();
      const scene = contradictoryScene(registry);
      const issues: StageIssue[] = [];

      const runtime = runScene(scene, project);
      const projection = projectRuntimeScene(runtime, scene.activeCameraGameObjectId);
      const nodeIds = projection.nodes.map((node) => node.gameObjectId);

      for (const runtimeId of nodeIds) {
        const selection = selectionForRuntimeNode(scene.id, runtimeId);
        const target = operationTarget(selection);
        if (target === null || target.includes('/')) {
          issues.push({
            files: ['apps/web/src/scene-editor/scene-selection.ts'],
            expected: 'a root instance id with no slash',
            actual: String(target),
            message: `selecting runtime node "${runtimeId}" produced an operation target that names a runtime path`,
          });
          continue;
        }
        if (!(scene.gameObjects ?? []).some((gameObject) => gameObject.id === target)) {
          issues.push({
            files: ['apps/web/src/scene-editor/scene-selection.ts'],
            expected: 'an operation target present in scene.gameObjects',
            actual: target,
            message: `selecting runtime node "${runtimeId}" produced a target no Scene instance has`,
          });
        }
      }

      runtime.dispose();
      return {
        ok: issues.length === 0,
        issues,
        output: `${nodeIds.length} runtime node(s) checked`,
      };
    },
  );
}

/* -------------------------------------------------------------------------- */
/* Stage 6 — the hierarchy says what §6 requires                              */
/* -------------------------------------------------------------------------- */

export function sceneHierarchyStage(): StageResult {
  return stage(
    'Scene hierarchy rows carry exact Prefab identity, Components and badges',
    {
      reproduce: 'npx tsx harness/check-scene-gameobject-cutover.ts',
      suggestion: 'a missing badge means the hierarchy is not deriving it from the resolved Prefab',
    },
    () => {
      const registry = loadPrefabRegistry();
      const scene = contradictoryScene(registry);
      const rows = sceneHierarchyRows({ scene, registry });
      const issues: StageIssue[] = [];

      const complain = (expected: string, actual: string): void => {
        issues.push({
          files: ['apps/web/src/scene-editor/scene-hierarchy.ts'],
          expected,
          actual,
          message: `the hierarchy does not report ${expected}`,
        });
      };

      const hero = rows.find((row) => row.instanceId === 'hero');
      if (!hero) return { ok: false, issues: [{ files: [], expected: 'a row for "hero"', actual: 'none', message: 'no row' }] };

      if (hero.prefabId !== 'quaternius-knight' || hero.prefabVersion !== '1.0.0') {
        complain('an exact prefabId@version', `${hero.prefabId}@${hero.prefabVersion}`);
      }
      for (const componentType of ['model-renderer', 'animator', 'character-motor']) {
        if (!hero.componentTypes.includes(componentType)) {
          complain(`a "${componentType}" badge`, hero.componentTypes.join(', '));
        }
      }
      if (hero.derivation !== 'variant') {
        complain('the variant badge for a variant Prefab', hero.derivation);
      }
      if (hero.nodes.length === 0) {
        complain('expandable resolved Prefab nodes', '0 nodes');
      }
      if (!hero.nodes.some((node) => node.components.length > 0)) {
        complain('Components on the expanded nodes', 'none');
      }

      const watcher = rows.find((row) => row.instanceId === 'watcher');
      if (watcher?.relationBadge === undefined) complain('a relation badge on the camera', 'none');
      if (watcher?.activeCamera !== true) complain('the active-camera badge', 'absent');

      // The override badge, from an instance that carries one.
      const context = contextFor(registry);
      const overridden = applySceneGameObjectOperation(
        scene,
        {
          type: 'scene.set_component_override',
          gameObjectId: 'hero',
          override: {
            nodeId: 'root',
            componentId: 'model',
            patches: [{ path: '/castShadow', op: 'set', value: false }],
          },
        },
        context,
      ).document;
      const overriddenRow = overridden
        ? sceneHierarchyRows({ scene: overridden, registry }).find(
            (row) => row.instanceId === 'hero',
          )
        : undefined;
      if (overriddenRow?.overrideCount !== 1) {
        complain('an override badge on an overridden instance', String(overriddenRow?.overrideCount));
      }
      if (
        !overriddenRow?.nodes.some((node) =>
          node.components.some((component) => component.overridden),
        )
      ) {
        complain('the overridden Component marked in the expanded view', 'none marked');
      }

      return { ok: issues.length === 0, issues, output: `${rows.length} row(s)` };
    },
  );
}

/* -------------------------------------------------------------------------- */
/* Stage 7 — real Animator playback                                           */
/* -------------------------------------------------------------------------- */

/**
 * The Animator actually animates, and two instances do not contaminate each
 * other (§13.3).
 *
 * Asserted at two deterministic simulation times, against the *resolved take*
 * rather than against the existence of an Animator: the previous state of the
 * world was that an Animator fact existed and nothing moved, and a stage that
 * only checked for the fact would have passed then too.
 */
export function animatorPlaybackStage(): StageResult {
  return stage(
    'an Animator Component produces deterministic, isolated playback',
    {
      reproduce: 'npx tsx harness/check-scene-gameobject-cutover.ts',
      suggestion:
        'identical animation state at two different tick counts means nothing is advancing the Animator',
    },
    () => {
      const registry = loadPrefabRegistry();
      const project = loadCanonicalProject();
      const scene = contradictoryScene(registry);
      const issues: StageIssue[] = [];
      const complain = (expected: string, actual: string, message: string): void => {
        issues.push({
          files: [
            'packages/game-object-runtime/src/animator-playback.ts',
            'packages/game-object-runtime/src/components.ts',
          ],
          expected,
          actual,
          message,
        });
      };

      const runtime = runScene(scene, project);
      const hero = runtime.get('hero');
      const understudy = runtime.get('understudy');
      if (!hero || !understudy) {
        return {
          ok: false,
          issues: [
            {
              files: [PROJECT_FILE],
              expected: 'two animated GameObjects',
              actual: 'the fixture did not instantiate',
              message: 'cannot demonstrate playback',
            },
          ],
        };
      }

      const animator = hero.animator;
      if (!animator) {
        complain('an Animator runtime on "hero"', 'none', 'the Prefab resolved without an Animator');
        runtime.dispose();
        return { ok: false, issues };
      }

      // §10.4 — the take is named canonically, and it exists.
      const initial = hero.animationState;
      const take = initial ? animator.playback.takeByStateId[initial.stateId] : undefined;
      if (!take) {
        complain(
          'an imported take bound to the opening state',
          `state "${initial?.stateId ?? 'none'}" binds nothing`,
          'the Animator would have nothing to play',
        );
      } else if (!take.assetPath.endsWith('.glb') || take.animationName.length === 0) {
        complain('a take naming a file and an animation', JSON.stringify(take), 'malformed take');
      }

      const sample = (): string => JSON.stringify(hero.animationState);
      const at0 = sample();
      const seconds0 = animator.animationSeconds;

      for (let tick = 0; tick < 30; tick += 1) runtime.step({ cameraYawRad: 0 });
      const at30 = sample();
      const seconds30 = animator.animationSeconds;

      for (let tick = 30; tick < 90; tick += 1) runtime.step({ cameraYawRad: 0 });
      const at90 = sample();

      // §10.3 — time advances from the shared fixed-step clock.
      if (seconds30 <= seconds0) {
        complain(
          'animation seconds to advance with the Scene clock',
          `${seconds0} -> ${seconds30}`,
          'the Animator did not advance',
        );
      }
      const expectedSeconds = seconds0 + 30 / 60;
      if (Math.abs(seconds30 - expectedSeconds) > 1e-9) {
        complain(
          `${expectedSeconds}s after 30 fixed steps`,
          `${seconds30}s`,
          'the Animator is not advancing on the fixed-step clock',
        );
      }

      // §13.3 — the pose differs at two deterministic simulation times.
      if (at0 === at30 && at30 === at90) {
        complain(
          'the animation state to differ across simulation times',
          `identical at ticks 0, 30 and 90: ${at0}`,
          'nothing is animating',
        );
      }

      // §10.2 / §13.3 — a second instance is isolated.
      const understudyAnimator = understudy.animator;
      if (understudyAnimator === animator) {
        complain('one Animator runtime per instance', 'both share one', 'shared Animator runtime');
      }
      if (understudyAnimator && understudyAnimator.playback === animator.playback) {
        // The *plan* may legitimately be equal by value; sharing the object is
        // fine because it is immutable. What must never be shared is the time.
        if (understudyAnimator.animationSeconds !== animator.animationSeconds) {
          // Different times on a shared plan is exactly correct.
        }
      }

      // §13.3 — reset reproduces the initial pose and time.
      runtime.reset();
      const afterReset = runtime.get('hero');
      if (!afterReset) {
        complain('the Scene to rebuild on reset', 'hero is gone', 'reset lost an object');
      } else {
        if (afterReset.animator?.animationSeconds !== 0) {
          complain(
            'zero animation seconds after reset',
            String(afterReset.animator?.animationSeconds),
            'reset did not reproduce the initial animation time',
          );
        }
        if (JSON.stringify(afterReset.animationState) !== at0) {
          complain(
            'the initial animation state after reset',
            JSON.stringify(afterReset.animationState),
            'reset did not reproduce the initial pose',
          );
        }
      }

      runtime.dispose();
      return {
        ok: issues.length === 0,
        issues,
        output: `take "${take?.animationName ?? 'none'}"; ${seconds0}s -> ${seconds30}s over 30 ticks`,
      };
    },
  );
}

/* -------------------------------------------------------------------------- */
/* Stage 8 — two animated instances stay isolated under stepping              */
/* -------------------------------------------------------------------------- */

export function animatedInstanceIsolationStage(): StageResult {
  return stage(
    'two animated instances of one Prefab do not contaminate each other',
    {
      reproduce: 'npx tsx harness/check-scene-gameobject-cutover.ts',
      suggestion:
        'a second instance that moved when only the first was stepped means shared mutable state',
    },
    () => {
      const registry = loadPrefabRegistry();
      const project = loadCanonicalProject();
      const scene = contradictoryScene(registry);
      const runtime = runScene(scene, project);
      const issues: StageIssue[] = [];

      const hero = runtime.get('hero');
      const understudy = runtime.get('understudy');
      if (!hero || !understudy) {
        runtime.dispose();
        return {
          ok: false,
          issues: [
            {
              files: [PROJECT_FILE],
              expected: 'two instances of one Prefab',
              actual: 'the fixture did not instantiate',
              message: 'isolation cannot be demonstrated',
            },
          ],
        };
      }

      const before = {
        seconds: understudy.animator?.animationSeconds ?? 0,
        state: JSON.stringify(understudy.animationState),
        transform: JSON.stringify(understudy.worldTransform),
      };

      // Only the first is stepped.
      for (let tick = 0; tick < 45; tick += 1) hero.step({ tick, cameraYawRad: 0 });

      if ((understudy.animator?.animationSeconds ?? 0) !== before.seconds) {
        issues.push({
          files: ['packages/game-object-runtime/src/components.ts'],
          expected: 'the second instance to keep its own animation time',
          actual: `${before.seconds} -> ${understudy.animator?.animationSeconds}`,
          message: 'two instances share an Animator clock',
        });
      }
      if (JSON.stringify(understudy.animationState) !== before.state) {
        issues.push({
          files: ['packages/game-object-runtime/src/runtime.ts'],
          expected: 'the second instance to keep its own animation state',
          actual: JSON.stringify(understudy.animationState),
          message: 'two instances share an animation state',
        });
      }
      if (JSON.stringify(understudy.worldTransform) !== before.transform) {
        issues.push({
          files: ['packages/game-object-runtime/src/runtime.ts'],
          expected: 'the second instance to stay where it was',
          actual: JSON.stringify(understudy.worldTransform),
          message: 'two instances share a runtime transform',
        });
      }
      if (hero.character === understudy.character) {
        issues.push({
          files: ['packages/game-object-runtime/src/runtime.ts'],
          expected: 'one simulation per instance',
          actual: 'both hold the same one',
          message: 'two instances share a simulation',
        });
      }

      runtime.dispose();
      return { ok: issues.length === 0, issues, output: 'stepped one of two for 45 ticks' };
    },
  );
}

/* -------------------------------------------------------------------------- */
/* Stage 9 — a missing take is visible, never filled in                        */
/* -------------------------------------------------------------------------- */

export function missingTakeVisibilityStage(): StageResult {
  return stage(
    'an Animator with no take for its state is an issue, not a silent substitution',
    {
      reproduce: 'npx tsx harness/check-scene-gameobject-cutover.ts',
      suggestion:
        'no issue here means the renderer would fall back to some other clip and hide a broken binding',
    },
    () => {
      const registry = loadPrefabRegistry();
      const project = loadCanonicalProject();
      const issues: StageIssue[] = [];

      /*
       * The navigator's motion set binds only procedural clips, so pairing it
       * with an *imported* model is exactly the composition §10.5 describes: a
       * skinned mesh whose Animator names no take. The override swaps the model
       * without touching the Animator, which is what makes the gap real rather
       * than staged.
       */
      const scene: SceneDefinition = {
        schemaVersion: 2,
        id: 'missing-take',
        displayName: 'Missing take',
        entities: [],
        gameObjects: [
          instance(registry, 'silent', 'navigator', {
            componentOverrides: [
              {
                nodeId: 'root',
                componentId: 'model',
                patches: [
                  {
                    path: '/model',
                    op: 'set',
                    value: {
                      kind: 'repository-model',
                      assetPath: '/assets/characters/quaternius-knight/KnightCharacter.glb',
                      scale: 0.3,
                      rotationYRad: 0,
                    },
                  },
                ],
              },
            ],
          }),
        ],
        intentTracks: [],
      };

      const runtime = runScene(scene, project);
      const projection = projectRuntimeScene(runtime, undefined);
      const reported = projection.issues.find((issue) => issue.code === 'animator-take-unbound');

      if (!reported) {
        issues.push({
          files: ['apps/web/src/game-objects/render-projection.ts'],
          expected: 'an animator-take-unbound issue',
          actual: projection.issues.map((issue) => issue.code).join(', ') || 'no issues at all',
          message: 'a skinned model whose Animator binds no take was reported as fine',
        });
      } else {
        // §10.5 — the issue names the object, the Component and the asset.
        for (const [what, present] of [
          ['the GameObject identity', reported.gameObjectId === 'silent'],
          ['the Animator componentId', reported.componentId !== undefined],
          ['the animation asset reference', reported.message.includes('motion set')],
          ['the missing state', reported.message.includes('state')],
        ] as const) {
          if (present) continue;
          issues.push({
            files: ['apps/web/src/game-objects/render-projection.ts'],
            expected: `the issue to name ${what}`,
            actual: JSON.stringify(reported),
            message: `the missing-take issue does not name ${what}`,
          });
        }
      }

      runtime.dispose();
      return { ok: issues.length === 0, issues, output: reported?.code ?? 'no issue reported' };
    },
  );
}

/* -------------------------------------------------------------------------- */
/* Stage 10 — one-source edit survives a reload                                */
/* -------------------------------------------------------------------------- */

/**
 * One transform edit, read back through every surface (§13.12).
 *
 * The "reload" here is a fresh resolution and instantiation from the document
 * the operation produced — the same thing the browser does on a route change —
 * with no migration or reconciliation step in between. That absence is the
 * property: if a migration were needed to make the views agree, the migration
 * would be what decides where the object is.
 */
export function oneSourceEditStage(): StageResult {
  return stage(
    'one transform edit agrees across document, hierarchy, runtime and projection',
    {
      reproduce: 'npx tsx harness/check-scene-gameobject-cutover.ts',
      suggestion:
        'a disagreement means one surface is reading a different collection than the operation wrote',
    },
    () => {
      const registry = loadPrefabRegistry();
      const project = loadCanonicalProject();
      const context = contextFor(registry);
      const scene = contradictoryScene(registry);
      const issues: StageIssue[] = [];

      const moved: TransformDefinition = {
        position: { x: 3.5, y: 0, z: -2.25 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1, y: 1, z: 1 },
      };
      // `understudy` rather than `hero`: a CharacterMotor-driven object's world
      // placement belongs to the simulation, and this stage is about the
      // *authored* value surviving. Both are motor-driven here, so the
      // comparison below is against the document and the freshly instantiated
      // runtime at tick 0 — before any step has moved anything.
      const result = applySceneGameObjectOperation(
        scene,
        { type: 'scene.set_transform', gameObjectId: 'understudy', transform: moved },
        context,
      );
      if (!result.ok || !result.document) {
        return {
          ok: false,
          issues: [
            {
              files: ['packages/editor-core/src/game-object-operations.ts'],
              expected: 'the transform edit to succeed',
              actual: result.issues.map((issue) => issue.message).join('; '),
              message: 'the edit was refused',
            },
          ],
        };
      }
      const edited = result.document;

      const complain = (surface: string, actual: string): void => {
        issues.push({
          files: [PROJECT_FILE],
          expected: JSON.stringify(moved.position),
          actual,
          message: `${surface} does not report the edited transform`,
        });
      };

      // 1. The canonical document.
      const persisted = edited.gameObjects?.find((entry) => entry.id === 'understudy');
      if (JSON.stringify(persisted?.transform.position) !== JSON.stringify(moved.position)) {
        complain('scene.gameObjects', JSON.stringify(persisted?.transform.position));
      }

      // 2. The operation's own reported change.
      const changed = changedGameObjectIds(scene, edited);
      if (!changed.includes('understudy')) {
        complain('changedGameObjectIds', changed.join(', ') || 'none');
      }

      // 3. A fresh runtime, instantiated from the edited document with nothing
      //    in between.
      const runtime = runScene(edited, project);
      const runtimeObject = runtime.get('understudy');
      const world = runtimeObject?.worldTransform;
      if (
        world === undefined ||
        Math.abs(world.position.x - moved.position.x) > 1e-6 ||
        Math.abs(world.position.z - moved.position.z) > 1e-6
      ) {
        complain('RuntimeGameObject.worldTransform', JSON.stringify(world?.position));
      }

      // 4. The projection the viewport draws from.
      const projection = projectRuntimeScene(runtime, edited.activeCameraGameObjectId);
      const drawn = projection.nodes.find((node) => node.gameObjectId === 'understudy');
      if (
        drawn === undefined ||
        Math.abs(drawn.worldTransform.position.x - moved.position.x) > 1e-6
      ) {
        complain('the render projection', JSON.stringify(drawn?.worldTransform.position));
      }

      // 5. The hierarchy still names the same instance and Prefab version.
      const row = sceneHierarchyRows({ scene: edited, registry }).find(
        (entry) => entry.instanceId === 'understudy',
      );
      if (!row) complain('the Scene hierarchy', 'no row for the edited instance');

      // 6. And the entity mirror was not consulted or written on the way.
      if (JSON.stringify(edited.entities) !== JSON.stringify(scene.entities)) {
        issues.push({
          files: [PROJECT_FILE],
          expected: 'scene.entities to be byte-identical',
          actual: 'it changed',
          message: 'a transform edit reached the legacy entity mirror',
        });
      }

      runtime.dispose();
      return {
        ok: issues.length === 0,
        issues,
        output: 'document, changed ids, runtime, projection and hierarchy agree',
      };
    },
  );
}

export function sceneGameObjectCutoverStages(): StageResult[] {
  return [
    sceneReadsGameObjectsStage(),
    sceneViewportProjectionStage(),
    sceneOperationsStage(),
    sceneOperationRefusalsStage(),
    selectionIdentityStage(),
    sceneHierarchyStage(),
    animatorPlaybackStage(),
    animatedInstanceIsolationStage(),
    missingTakeVisibilityStage(),
    oneSourceEditStage(),
  ];
}

function main(): void {
  const results = sceneGameObjectCutoverStages();
  for (const result of results) printStage(result);
  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} Scene cutover checks passed`);
  process.exit(failed.length > 0 ? 1 : 0);
}

if (process.argv[1]?.includes('check-scene-gameobject-cutover')) main();

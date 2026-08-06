/**
 * Renderer harness stages (§14, §15).
 *
 * The question these stages answer is the one the entity renderer could not be
 * asked: *does what appears on screen come from Components?* The old renderer
 * switched on `entity.kind`, so "a character carrying a light" had no test
 * because it had no representation. Here every composition §3 requires is
 * built, run, and projected, and the drawables are asserted directly.
 *
 * The projection layer is deliberately React-free, so this runs in Node with no
 * canvas, no DOM and no GPU — which is what makes it cheap enough to be part of
 * `harness:one-shot` rather than a browser suite nobody runs.
 */
import { TERRAIN_PRESETS } from '@atc/terrain-runtime';
import { instantiateScene } from '@atc/game-object-runtime';
import { PrefabAssetRegistry, type StoredPrefab } from '@atc/prefab-runtime';
import { sealAsset } from '@atc/animation-asset-runtime';
import type {
  GameObjectComponentDefinition,
  GameObjectInstanceDefinition,
  GameObjectPrefabAsset,
  SceneDefinition,
  TransformDefinition,
} from '@atc/schema';
import { resolvedComponents, resolveGameObjectPrefab } from '@atc/prefab-runtime';
import {
  drawableNodes,
  projectRuntimeScene,
  type GameObjectRenderNode,
  type SceneRenderProjection,
} from '../apps/web/src/game-objects/render-projection.ts';
import { loadAssetRegistry, loadCanonicalProject } from './animation-assets.ts';
import { printStage, stage, type StageIssue, type StageResult } from './lib.ts';
import { loadPrefabRegistry, loadStoredPrefabs } from './prefabs.ts';

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

/**
 * The Animator assignment every synthetic composition animates against.
 *
 * Borrowed from a real published Prefab rather than invented, because an
 * assignment naming animation assets that do not exist would resolve to issues
 * and the stage would be asserting the failure path by accident.
 */
function canonicalAnimatorComponent(): GameObjectComponentDefinition {
  const registry = loadPrefabRegistry();
  const resolved = resolveGameObjectPrefab(registry, registry.referenceTo('navigator', '1.0.0'));
  const animator = resolvedComponents(resolved.prefab.root).find(
    (component) => component.componentType === 'animator',
  );
  if (!animator) throw new Error('the navigator Prefab has no animator to borrow');
  return animator;
}

function component(partial: Record<string, unknown>): GameObjectComponentDefinition {
  return { schemaVersion: 1, enabled: true, ...partial } as GameObjectComponentDefinition;
}

const MODEL = (): GameObjectComponentDefinition =>
  component({
    componentId: 'model',
    componentType: 'model-renderer',
    model: { kind: 'procedural-humanoid', presetId: 'navigator' },
    castShadow: true,
    receiveShadow: true,
  });

const PROP_MODEL = (): GameObjectComponentDefinition =>
  component({
    componentId: 'model',
    componentType: 'model-renderer',
    model: { kind: 'repository-model', assetPath: 'assets/models/prop.glb' },
    castShadow: true,
    receiveShadow: false,
  });

const MOTOR = (): GameObjectComponentDefinition =>
  component({
    componentId: 'motor',
    componentType: 'character-motor',
    intentChannel: 'primary',
    movementScale: 1,
    turnScale: 1,
  });

const LIGHT = (): GameObjectComponentDefinition =>
  component({
    componentId: 'light',
    componentType: 'light',
    lightType: 'point',
    intensity: 2.5,
    color: '#ffd8a8',
    range: 8,
  });

const CAMERA = (): GameObjectComponentDefinition =>
  component({
    componentId: 'camera',
    componentType: 'camera',
    projection: 'perspective',
    fieldOfViewDeg: 55,
  });

/** A stored base Prefab with exactly the Components it is handed. */
function syntheticPrefab(id: string, components: GameObjectComponentDefinition[]): StoredPrefab {
  const document = sealAsset({
    metadata: {
      schemaVersion: 1,
      assetType: 'game-object-prefab',
      id,
      version: '1.0.0',
      displayName: id,
      description: `Renderer harness composition "${id}".`,
      tags: ['harness'],
      createdAt: '2026-08-06T00:00:00.000Z',
      createdBy: 'harness:game-object-renderer',
      contentHash: '',
    },
    derivation: { mode: 'base' },
    abstract: false,
    root: {
      nodeId: 'root',
      displayName: id,
      enabled: true,
      transform: IDENTITY,
      components,
      children: [],
    },
  } as unknown as GameObjectPrefabAsset) as GameObjectPrefabAsset;
  return { id, version: '1.0.0', document };
}

/** The seven compositions §3 names, each as one Prefab. */
function compositionPrefabs(): StoredPrefab[] {
  const animator = canonicalAnimatorComponent();
  return [
    syntheticPrefab('harness-model-only', [MODEL()]),
    syntheticPrefab('harness-model-animator', [MODEL(), animator]),
    syntheticPrefab('harness-model-animator-motor', [MODEL(), animator, MOTOR()]),
    syntheticPrefab('harness-character-with-light', [MODEL(), animator, MOTOR(), LIGHT()]),
    syntheticPrefab('harness-animated-prop', [PROP_MODEL(), animator]),
    syntheticPrefab('harness-camera-only', [CAMERA()]),
    syntheticPrefab('harness-light-only', [LIGHT()]),
    syntheticPrefab('harness-motor-without-animator', [MODEL(), MOTOR()]),
  ];
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

interface HarnessScene {
  projection: SceneRenderProjection;
  dispose(): void;
}

function projectScene(
  instances: GameObjectInstanceDefinition[],
  registry: PrefabAssetRegistry,
  activeCameraGameObjectId?: string,
): HarnessScene {
  const project = loadCanonicalProject();
  const scene = {
    schemaVersion: 2,
    id: 'harness-renderer-scene',
    displayName: 'Renderer harness',
    entities: [],
    intentTracks: [],
    gameObjects: instances,
    ...(activeCameraGameObjectId ? { activeCameraGameObjectId } : {}),
  } as unknown as SceneDefinition;

  const runtime = instantiateScene({
    scene,
    project,
    terrain: terrain(),
    services: {
      animationRegistry: loadAssetRegistry(),
      prefabRegistry: registry,
      clock: { fixedDeltaSeconds: 1 / 60 },
    },
  });
  return {
    projection: projectRuntimeScene(runtime, activeCameraGameObjectId),
    dispose: () => runtime.dispose(),
  };
}

function harnessRegistry(): PrefabAssetRegistry {
  return new PrefabAssetRegistry([...loadStoredPrefabs(), ...compositionPrefabs()]);
}

function nodeOf(
  projection: SceneRenderProjection,
  gameObjectId: string,
): GameObjectRenderNode | undefined {
  return projection.nodes.find((node) => node.gameObjectId === gameObjectId);
}

/**
 * Every composition §3 requires draws from its Components.
 *
 * Asserted per fact rather than per kind: "this node has a light" and "this
 * node has a model" are separate questions, and a renderer that could only
 * answer one of them per object is the thing being replaced.
 */
export function renderCompositionStage(): StageResult {
  return stage(
    'every required composition renders from its Components',
    {
      reproduce: 'npx tsx harness/check-game-object-renderer.ts',
      suggestion:
        'a missing drawable means the projection dropped a Component; a missing node means resolution failed',
    },
    () => {
      const registry = harnessRegistry();
      const issues: StageIssue[] = [];
      const expectations: Array<{
        prefab: string;
        model: boolean;
        animator: boolean;
        light: boolean;
        camera: boolean;
        simulated: boolean;
      }> = [
        { prefab: 'harness-model-only', model: true, animator: false, light: false, camera: false, simulated: false },
        { prefab: 'harness-model-animator', model: true, animator: true, light: false, camera: false, simulated: false },
        { prefab: 'harness-model-animator-motor', model: true, animator: true, light: false, camera: false, simulated: true },
        { prefab: 'harness-character-with-light', model: true, animator: true, light: true, camera: false, simulated: true },
        { prefab: 'harness-animated-prop', model: true, animator: true, light: false, camera: false, simulated: false },
        { prefab: 'harness-camera-only', model: false, animator: false, light: false, camera: true, simulated: false },
        { prefab: 'harness-light-only', model: false, animator: false, light: true, camera: false, simulated: false },
      ];

      const scene = projectScene(
        expectations.map((expectation) => instance(registry, expectation.prefab, expectation.prefab)),
        registry,
      );

      for (const expectation of expectations) {
        const node = nodeOf(scene.projection, expectation.prefab);
        if (!node) {
          issues.push({
            files: ['apps/web/src/game-objects/render-projection.ts'],
            expected: `a drawable node for "${expectation.prefab}"`,
            actual: 'none',
            message: `composition "${expectation.prefab}" produced no node`,
          });
          continue;
        }
        const complain = (fact: string, expected: boolean, actual: boolean): void => {
          if (expected === actual) return;
          issues.push({
            files: ['apps/web/src/game-objects/render-projection.ts'],
            expected: `${expectation.prefab}: ${fact} ${expected}`,
            actual: String(actual),
            message: `composition "${expectation.prefab}" got ${fact}=${actual}, expected ${expected}`,
          });
        };
        complain('model', expectation.model, node.model !== undefined);
        complain('animator', expectation.animator, node.animator !== undefined);
        complain('light', expectation.light, node.light !== undefined);
        complain('camera', expectation.camera, node.camera !== undefined);
        complain('simulated', expectation.simulated, node.simulated);
      }

      /*
       * The animated prop is the composition the entity renderer could not
       * express at all: an Animator with no motor. Its model binding must be
       * the one its Prefab declared, not a character stand-in.
       */
      const prop = nodeOf(scene.projection, 'harness-animated-prop');
      if (prop && prop.model?.binding.kind !== 'repository-model') {
        issues.push({
          files: ['apps/web/src/game-objects/render-projection.ts'],
          expected: 'the animated prop to keep its repository-model binding',
          actual: String(prop.model?.binding.kind),
          message: 'the prop model binding was substituted',
        });
      }

      const errors = scene.projection.issues.filter((issue) => issue.code !== 'motor-without-animator');
      for (const issue of errors) {
        issues.push({
          files: ['apps/web/src/game-objects/render-projection.ts'],
          expected: 'the composition scene to project cleanly',
          actual: issue.message,
          message: `${issue.code}: ${issue.message}`,
        });
      }

      scene.dispose();
      return {
        ok: issues.length === 0,
        issues,
        output: `${expectations.length} composition(s) projected`,
      };
    },
  );
}

/** Disabled means "does not draw", and it says nothing about the neighbours. */
export function renderEnabledStage(): StageResult {
  return stage(
    'a disabled GameObject draws nothing and takes nothing with it',
    {
      reproduce: 'npx tsx harness/check-game-object-renderer.ts',
      suggestion: 'drawableNodes must filter on the node, not on the scene',
    },
    () => {
      const registry = harnessRegistry();
      const scene = projectScene(
        [
          instance(registry, 'off', 'harness-model-only', { enabled: false }),
          instance(registry, 'on', 'harness-model-only'),
        ],
        registry,
      );
      const drawable = drawableNodes(scene.projection).map((node) => node.gameObjectId);
      const issues: StageIssue[] = [];
      if (drawable.includes('off')) {
        issues.push({
          files: ['apps/web/src/game-objects/render-projection.ts'],
          expected: 'a disabled GameObject to draw nothing',
          actual: 'it was drawable',
          message: 'disabled GameObjects still render',
        });
      }
      if (!drawable.includes('on')) {
        issues.push({
          files: ['apps/web/src/game-objects/render-projection.ts'],
          expected: 'the enabled GameObject to still draw',
          actual: 'it was filtered out',
          message: 'disabling one GameObject removed another',
        });
      }
      scene.dispose();
      return { ok: issues.length === 0, issues, output: `drawable: ${drawable.join(', ')}` };
    },
  );
}

/**
 * The active camera resolves through the Component, or it is an error.
 *
 * No fallback to "the first camera in the scene": a Scene that names a camera
 * it does not have is broken, and playing through a different one hides that
 * for exactly as long as some camera exists.
 */
export function renderActiveCameraStage(): StageResult {
  return stage(
    'the active camera resolves through its Camera Component',
    {
      reproduce: 'npx tsx harness/check-game-object-renderer.ts',
      suggestion: 'activeCameraGameObjectId -> RuntimeScene.get(id) -> CameraRuntime, and nothing else',
    },
    () => {
      const registry = harnessRegistry();
      const issues: StageIssue[] = [];

      const good = projectScene(
        [
          instance(registry, 'lens', 'harness-camera-only'),
          instance(registry, 'lamp', 'harness-light-only'),
        ],
        registry,
        'lens',
      );
      if (good.projection.activeCamera?.gameObjectId !== 'lens') {
        issues.push({
          files: ['apps/web/src/game-objects/render-projection.ts'],
          expected: 'the named camera GameObject',
          actual: String(good.projection.activeCamera?.gameObjectId),
          message: 'the active camera did not resolve to the GameObject the Scene names',
        });
      }
      good.dispose();

      // A named object with no Camera Component is a visible failure, not a
      // silent switch to whichever object does have one.
      const wrong = projectScene(
        [
          instance(registry, 'lamp', 'harness-light-only'),
          instance(registry, 'lens', 'harness-camera-only'),
        ],
        registry,
        'lamp',
      );
      if (wrong.projection.activeCamera !== undefined) {
        issues.push({
          files: ['apps/web/src/game-objects/render-projection.ts'],
          expected: 'no active camera, and an issue',
          actual: String(wrong.projection.activeCamera.gameObjectId),
          message: 'a GameObject with no Camera Component was used as the active camera',
        });
      }
      if (
        !wrong.projection.issues.some(
          (issue) => issue.code === 'active-camera-without-camera-component',
        )
      ) {
        issues.push({
          files: ['apps/web/src/game-objects/render-projection.ts'],
          expected: 'an active-camera-without-camera-component issue',
          actual: wrong.projection.issues.map((issue) => issue.code).join(', ') || 'none',
          message: 'a missing Camera Component on the active camera was not reported',
        });
      }
      wrong.dispose();

      const missing = projectScene([instance(registry, 'lens', 'harness-camera-only')], registry, 'ghost');
      if (!missing.projection.issues.some((issue) => issue.code === 'unknown-active-camera')) {
        issues.push({
          files: ['apps/web/src/game-objects/render-projection.ts'],
          expected: 'an unknown-active-camera issue',
          actual: missing.projection.issues.map((issue) => issue.code).join(', ') || 'none',
          message: 'an active camera id that names nothing was not reported',
        });
      }
      missing.dispose();

      return { ok: issues.length === 0, issues, output: 'named, wrong-kind and unknown cameras checked' };
    },
  );
}

/** A motor with no Animator is reported rather than drawn sliding in a T-pose. */
export function renderValidationStage(): StageResult {
  return stage(
    'a missing required Component is an error, not a fallback',
    {
      reproduce: 'npx tsx harness/check-game-object-renderer.ts',
      suggestion: 'projectGameObject must report motor-without-animator',
    },
    () => {
      const registry = harnessRegistry();
      const scene = projectScene(
        [instance(registry, 'broken', 'harness-motor-without-animator')],
        registry,
      );
      const reported = scene.projection.issues.some(
        (issue) => issue.code === 'motor-without-animator' && issue.gameObjectId === 'broken',
      );
      scene.dispose();
      return {
        ok: reported,
        issues: reported
          ? []
          : [
              {
                files: ['apps/web/src/game-objects/render-projection.ts'],
                expected: 'a motor-without-animator issue',
                actual: 'none',
                message: 'a character-motor with no Animator was accepted silently',
              },
            ],
        output: reported ? 'reported' : 'not reported',
      };
    },
  );
}

/**
 * The canonical Scene projects with no legacy field in the path.
 *
 * The fixture is the real project document, and the only field this stage reads
 * from it is `gameObjects` — which is what makes it evidence that the renderer
 * path no longer depends on `entities` existing.
 */
export function renderCanonicalSceneStage(): StageResult {
  return stage(
    'the canonical Scene renders from gameObjects alone',
    {
      reproduce: 'npx tsx harness/check-game-object-renderer.ts',
      suggestion: 'a failure here means the renderer path still needs data the Scene will stop carrying',
    },
    () => {
      const project = loadCanonicalProject();
      const prefabRegistry = loadPrefabRegistry();
      const issues: StageIssue[] = [];
      const notes: string[] = [];

      for (const scene of project.scenes) {
        // Only `gameObjects` is carried across; `entities` is deliberately
        // dropped, so a projection that still needed it would fail here.
        const canonical = {
          ...scene,
          entities: [],
          activeCameraEntityId: undefined,
        } as unknown as SceneDefinition;
        const runtime = instantiateScene({
          scene: canonical,
          project,
          terrain: terrain(),
          services: {
            animationRegistry: loadAssetRegistry(),
            prefabRegistry,
            clock: { fixedDeltaSeconds: 1 / 60 },
          },
        });
        const projection = projectRuntimeScene(runtime, scene.activeCameraGameObjectId);
        for (const issue of projection.issues) {
          issues.push({
            files: ['projects/demo-character/project.json'],
            expected: `scene "${scene.id}" to project cleanly from gameObjects`,
            actual: issue.message,
            message: `${issue.code}: ${issue.message}`,
          });
        }
        if (scene.activeCameraGameObjectId && !projection.activeCamera) {
          issues.push({
            files: ['projects/demo-character/project.json'],
            expected: `scene "${scene.id}" to resolve its active camera`,
            actual: 'none',
            message: `scene "${scene.id}" names an active camera that did not resolve`,
          });
        }
        notes.push(`${scene.id}: ${drawableNodes(projection).length} drawable node(s)`);
        runtime.dispose();
      }
      return { ok: issues.length === 0, issues, output: notes.join(' | ') };
    },
  );
}

export function gameObjectRendererStages(): StageResult[] {
  return [
    renderCompositionStage(),
    renderEnabledStage(),
    renderActiveCameraStage(),
    renderValidationStage(),
    renderCanonicalSceneStage(),
  ];
}

function main(): void {
  const results = gameObjectRendererStages();
  for (const result of results) printStage(result);
  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} renderer checks passed`);
  process.exit(failed.length > 0 ? 1 : 0);
}

if (process.argv[1]?.includes('check-game-object-renderer')) main();

/**
 * GameObject harness stages (§19).
 *
 * The Prefab stages check documents. These check what happens when the
 * documents are *run*: that every migrated Scene instance resolves, that
 * capability is derived from Components rather than a kind, that the migrated
 * GameObject view still says exactly what the entity view said, and that two
 * instances of one Prefab share nothing mutable.
 */
import { TERRAIN_PRESETS } from '@atc/terrain-runtime';
import {
  instantiateScene,
  isCharacterGameObject,
  resolveSceneGameObjects,
} from '@atc/game-object-runtime';
import { componentOfType } from '@atc/schema';
import { resolvedComponents } from '@atc/prefab-runtime';
import { loadAssetRegistry, loadCanonicalProject } from './animation-assets.ts';
import { printStage, stage, type StageIssue, type StageResult } from './lib.ts';
import { loadPrefabRegistry } from './prefabs.ts';

function terrain() {
  const project = loadCanonicalProject();
  return (
    TERRAIN_PRESETS.find((preset) => preset.id === project.defaultTerrainPresetId) ??
    TERRAIN_PRESETS[0]!
  );
}

/** Every migrated GameObject instance resolves against its exact Prefab version. */
export function gameObjectResolutionStage(): StageResult {
  return stage(
    'every scene GameObject resolves',
    {
      reproduce: 'npx tsx harness/check-game-objects.ts',
      suggestion:
        'a missing-prefab or prefab-hash-mismatch means the Scene names a Prefab version the repository no longer has',
    },
    () => {
      const project = loadCanonicalProject();
      const prefabRegistry = loadPrefabRegistry();
      const issues: StageIssue[] = [];
      const notes: string[] = [];

      for (const scene of project.scenes) {
        const result = resolveSceneGameObjects({ prefabRegistry, scene });
        for (const issue of result.issues.filter((entry) => entry.severity === 'error')) {
          issues.push({
            files: ['projects/demo-character/project.json'],
            expected: `scene "${scene.id}" to resolve every GameObject`,
            actual: issue.message,
            message: `${issue.code}: ${issue.message}`,
          });
        }
        notes.push(`${scene.id}: ${result.definitions.length} GameObject(s)`);
      }
      return { ok: issues.length === 0, issues, output: notes.join(' | ') };
    },
  );
}

/**
 * The migrated GameObject view says exactly what the entity view said.
 *
 * This is the stage that makes it safe for both fields to exist during the
 * migration. Two views of one Scene that are allowed to disagree are two Scenes.
 */
export function gameObjectParityStage(): StageResult {
  return stage(
    'GameObject instances agree with the entities they replaced',
    {
      reproduce: 'npx tsx harness/check-game-objects.ts',
      suggestion: 'run `pnpm prefabs:migrate` — the GameObject view is derived, never hand-edited',
    },
    () => {
      const project = loadCanonicalProject();
      const prefabRegistry = loadPrefabRegistry();
      const issues: StageIssue[] = [];
      let compared = 0;

      for (const scene of project.scenes) {
        const gameObjects = scene.gameObjects ?? [];
        if (gameObjects.length !== scene.entities.length) {
          issues.push({
            files: ['projects/demo-character/project.json'],
            expected: `${scene.entities.length} GameObject(s) in scene "${scene.id}"`,
            actual: `${gameObjects.length}`,
            message: `scene "${scene.id}" has a different number of GameObjects than entities`,
          });
          continue;
        }
        const resolved = resolveSceneGameObjects({ prefabRegistry, scene });
        for (const [index, entity] of scene.entities.entries()) {
          const gameObject = gameObjects[index]!;
          const definition = resolved.definitions.find(
            (candidate) => candidate.gameObjectId === gameObject.id,
          );
          const complain = (field: string, expected: unknown, actual: unknown): void => {
            issues.push({
              files: ['projects/demo-character/project.json'],
              expected: JSON.stringify(expected).slice(0, 160),
              actual: JSON.stringify(actual).slice(0, 160),
              message: `${scene.id}/${entity.id}: ${field} differs between the two views`,
            });
          };
          compared += 1;

          if (entity.id !== gameObject.id) complain('id', entity.id, gameObject.id);
          if (JSON.stringify(entity.transform) !== JSON.stringify(gameObject.transform)) {
            complain('transform', entity.transform, gameObject.transform);
          }
          if (entity.enabled !== gameObject.enabled) {
            complain('enabled', entity.enabled, gameObject.enabled);
          }
          if (!definition) {
            complain('resolution', 'a resolved definition', 'none');
            continue;
          }
          const components = resolvedComponents(definition.root);

          if (entity.kind === 'character') {
            if (
              JSON.stringify(entity.controller) !==
              JSON.stringify(gameObject.bindings.characterIntent)
            ) {
              complain('controller binding', entity.controller, gameObject.bindings.characterIntent);
            }
            if (!isCharacterGameObject(definition)) {
              complain('composition', 'Animator + CharacterMotor', 'neither');
            }
          }
          if (entity.kind === 'camera') {
            const camera = componentOfType(components, 'camera');
            if (!camera) complain('composition', 'a Camera Component', 'none');
            else if (camera.projection !== entity.projection) {
              complain('projection', entity.projection, camera.projection);
            }
            if (
              (entity.targetEntityId ?? undefined) !==
              (gameObject.relations.cameraTargetGameObjectId ?? undefined)
            ) {
              complain(
                'camera target',
                entity.targetEntityId,
                gameObject.relations.cameraTargetGameObjectId,
              );
            }
          }
          if (entity.kind === 'light') {
            const light = componentOfType(components, 'light');
            if (!light) complain('composition', 'a Light Component', 'none');
            else if (light.lightType !== entity.lightType || light.intensity !== entity.intensity) {
              complain(
                'light',
                { lightType: entity.lightType, intensity: entity.intensity },
                { lightType: light.lightType, intensity: light.intensity },
              );
            }
          }
        }
        if (
          (scene.activeCameraEntityId ?? undefined) !==
          (scene.activeCameraGameObjectId ?? undefined)
        ) {
          issues.push({
            files: ['projects/demo-character/project.json'],
            expected: String(scene.activeCameraEntityId),
            actual: String(scene.activeCameraGameObjectId),
            message: `scene "${scene.id}": the two views name different active cameras`,
          });
        }
      }
      return { ok: issues.length === 0, issues, output: `${compared} instance(s) compared` };
    },
  );
}

/**
 * Two instances of one Prefab share nothing mutable (§9.6, §18.6).
 *
 * Asserted by *moving* one and checking the other did not follow, rather than by
 * comparing object identity: two runtimes could hold distinct objects and still
 * share a simulation through a captured reference, and only stepping one of them
 * finds that.
 */
export function gameObjectIsolationStage(): StageResult {
  return stage(
    'two instances of one Prefab have independent runtime state',
    {
      reproduce: 'npx tsx harness/check-game-objects.ts',
      suggestion:
        'shared mutable state means a resolved bundle was reused where a per-instance wrapper was needed',
    },
    () => {
      const project = loadCanonicalProject();
      const scene = project.scenes[0];
      if (!scene) return { ok: true, issues: [], output: 'no scene to run' };

      const runtime = instantiateScene({
        scene,
        project,
        terrain: terrain(),
        services: {
          animationRegistry: loadAssetRegistry(),
          prefabRegistry: loadPrefabRegistry(),
          clock: { fixedDeltaSeconds: 1 / 60 },
        },
      });

      const characters = runtime.gameObjects.filter((entry) => entry.character !== undefined);
      if (characters.length < 2) {
        return {
          ok: false,
          issues: [
            {
              files: ['projects/demo-character/project.json'],
              expected: 'at least two character GameObjects',
              actual: `${characters.length}`,
              message: 'isolation cannot be demonstrated with fewer than two instances',
            },
          ],
        };
      }

      const [first, second] = characters as [(typeof characters)[number], (typeof characters)[number]];
      const issues: StageIssue[] = [];
      const before = JSON.stringify(second.transformState);

      for (let tick = 0; tick < 30; tick += 1) {
        first.step({ tick, cameraYawRad: 0 });
      }

      if (JSON.stringify(second.transformState) !== before) {
        issues.push({
          files: ['packages/game-object-runtime/src/runtime.ts'],
          expected: 'stepping one instance to leave the other untouched',
          actual: 'the second instance moved',
          message: 'two instances of one Prefab share a runtime transform',
        });
      }
      if (first.character === second.character) {
        issues.push({
          files: ['packages/game-object-runtime/src/runtime.ts'],
          expected: 'one ControllableCharacter per instance',
          actual: 'both instances hold the same one',
          message: 'two instances of one Prefab share a simulation',
        });
      }
      for (const component of first.components) {
        const twin = second.componentRuntime(component.componentId);
        if (twin && twin === component) {
          issues.push({
            files: ['packages/game-object-runtime/src/components.ts'],
            expected: 'one component runtime per instance',
            actual: `both instances hold the same "${component.componentId}"`,
            message: 'two instances of one Prefab share a component runtime',
          });
        }
      }

      runtime.dispose();
      return {
        ok: issues.length === 0,
        issues,
        output: `${characters.length} character GameObject(s), independent after 30 ticks`,
      };
    },
  );
}

export function gameObjectStages(): StageResult[] {
  return [gameObjectResolutionStage(), gameObjectParityStage(), gameObjectIsolationStage()];
}

function main(): void {
  const results = gameObjectStages();
  for (const result of results) printStage(result);
  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} GameObject checks passed`);
  process.exit(failed.length > 0 ? 1 : 0);
}

if (process.argv[1]?.includes('check-game-objects')) main();

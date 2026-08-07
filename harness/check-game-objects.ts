/**
 * GameObject harness stages (§19).
 *
 * The Prefab stages check documents. These check what happens when the
 * documents are *run*: that every Scene instance resolves against its exact
 * Prefab version, that every Scene is complete in GameObject terms without
 * consulting the legacy entity mirror, and that two instances of one Prefab
 * share nothing mutable.
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
 * Every Scene carries a complete, self-sufficient GameObject view (§12).
 *
 * This replaces the *agreement* check that stood here until the Scene cutover.
 * That check asserted `gameObjects` said exactly what `entities` said, and it
 * was the right check for as long as `gameObjects` was derived from `entities`
 * by `pnpm prefabs:migrate`. It is the wrong check now, and keeping it would be
 * actively harmful in two directions:
 *
 *   - production writes `gameObjects` directly (DECISION 0025), so the first
 *     Scene edit makes the two views disagree by design. An agreement check
 *     would turn every ordinary edit into a harness failure;
 *   - the only way to satisfy it would be to regenerate `entities` from
 *     `gameObjects` after each write — which is precisely the reverse
 *     generation §9.2 forbids, and which would make the dual source of truth
 *     permanent instead of temporary.
 *
 * What is checked instead is the property the new arrangement actually needs:
 * every Scene has a `gameObjects` collection, every instance in it resolves,
 * and everything the Scene *itself* names — its active camera, its relations —
 * is named in GameObject terms. A Scene that still depended on `entities` to be
 * complete would fail here.
 *
 * The entity mirror is deliberately not inspected. It may be stale; nothing
 * reads it; the final-deletion package removes it.
 */
export function gameObjectSelfSufficiencyStage(): StageResult {
  return stage(
    'every Scene is complete in GameObject terms alone',
    {
      reproduce: 'npx tsx harness/check-game-objects.ts',
      suggestion:
        'a Scene with no gameObjects, or one whose active camera is only named in entity terms, still depends on the legacy mirror',
    },
    () => {
      const project = loadCanonicalProject();
      const prefabRegistry = loadPrefabRegistry();
      const issues: StageIssue[] = [];
      let checked = 0;

      for (const scene of project.scenes) {
        const gameObjects = scene.gameObjects;
        const complain = (expected: string, actual: string, message: string): void => {
          issues.push({
            files: ['projects/demo-character/project.json'],
            expected,
            actual,
            message: `scene "${scene.id}": ${message}`,
          });
        };

        if (gameObjects === undefined) {
          complain(
            'a gameObjects collection',
            'the field is absent',
            'has no GameObject view, so production has nothing to read',
          );
          continue;
        }

        const resolved = resolveSceneGameObjects({ prefabRegistry, scene });
        for (const instance of gameObjects) {
          checked += 1;
          const definition = resolved.definitions.find(
            (candidate) => candidate.gameObjectId === instance.id,
          );
          if (!definition) {
            complain(
              `a resolved definition for "${instance.id}"`,
              'resolution produced none',
              `GameObject "${instance.id}" does not resolve`,
            );
            continue;
          }

          /*
           * A binding or a relation must be supported by the resolved
           * Components. The resolver already refuses these, so reaching them
           * here means a Scene was written that the resolver would reject —
           * which is a document nobody can open.
           */
          const components = resolvedComponents(definition.root);
          if (
            instance.bindings.characterIntent &&
            !componentOfType(components, 'character-motor')
          ) {
            complain(
              'a character-motor to drive the intent binding',
              'the resolved Prefab has none',
              `GameObject "${instance.id}" binds an intent it cannot use`,
            );
          }
          if (
            instance.bindings.characterIntent &&
            !isCharacterGameObject(definition)
          ) {
            complain(
              'Animator + CharacterMotor on an intent-bound object',
              'the composition is incomplete',
              `GameObject "${instance.id}" is driven but not animated`,
            );
          }
          if (
            instance.relations.cameraTargetGameObjectId !== undefined &&
            !componentOfType(components, 'camera')
          ) {
            complain(
              'a Camera Component behind the camera relation',
              'the resolved Prefab has none',
              `GameObject "${instance.id}" aims a camera it does not have`,
            );
          }
        }

        // The Scene's own active camera is named in GameObject terms, and
        // resolves through a Camera Component rather than through a kind.
        const activeId = scene.activeCameraGameObjectId;
        if (activeId !== undefined) {
          const active = resolved.definitions.find(
            (candidate) => candidate.gameObjectId === activeId,
          );
          if (!active) {
            complain(
              `the active camera "${activeId}" to be a resolved GameObject`,
              'it is not in the GameObject view',
              'names an active camera the GameObject view does not have',
            );
          } else if (!componentOfType(resolvedComponents(active.root), 'camera')) {
            complain(
              'the active camera to carry a Camera Component',
              'it carries none',
              `active camera "${activeId}" has no camera to play through`,
            );
          }
        }
      }

      return {
        ok: issues.length === 0,
        issues,
        output: `${checked} GameObject instance(s) checked across ${project.scenes.length} scene(s)`,
      };
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
      const before = JSON.stringify(second.worldTransform);

      for (let tick = 0; tick < 30; tick += 1) {
        first.step({ tick, cameraYawRad: 0 });
      }

      if (JSON.stringify(second.worldTransform) !== before) {
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
  return [
    gameObjectResolutionStage(),
    gameObjectSelfSufficiencyStage(),
    gameObjectIsolationStage(),
  ];
}

function main(): void {
  const results = gameObjectStages();
  for (const result of results) printStage(result);
  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} GameObject checks passed`);
  process.exit(failed.length > 0 ? 1 : 0);
}

if (process.argv[1]?.includes('check-game-objects')) main();

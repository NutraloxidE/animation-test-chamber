/**
 * Transitional Scene-to-World adapter.
 *
 * **Temporary, and deliberately the only one.** The canonical project now owns
 * `scenes[]`; this package still speaks `WorldDefinition`, and its tests are the
 * evidence that the Scene migration preserved behaviour — so they have to keep
 * running against real project data until they are migrated onto `SceneRuntime`
 * (work package Phase 3), at which point this file and the package around it are
 * deleted together.
 *
 * The direction matters. `migrateWorldToScenes` is the *canonical*, forward,
 * one-way migration and it is what writes files. This runs backwards, in memory
 * only, and never produces a document anything persists. A reverse migration
 * that could reach a repository would be a second definition of the canonical
 * shape, and the two would disagree the first time either grew a field.
 */
import type {
  CharacterSceneEntity,
  ProjectDefinition,
  SceneDefinition,
  WorldDefinition,
} from '@atc/schema';
import { quaternionToYaw } from '@atc/schema';

/** The scene a legacy World view should read: the active one, else the first. */
export function defaultScene(project: ProjectDefinition): SceneDefinition | undefined {
  if (project.scenes.length === 0) return undefined;
  const active = project.scenes.find((scene) => scene.id === project.activeSceneId);
  return active ?? project.scenes[0];
}

/**
 * One Scene, viewed as the World this package still understands.
 *
 * Returns `undefined` when the Scene holds no character entities: a
 * `WorldDefinition` requires at least one instance, and inventing one to
 * satisfy the schema would put a character in the caller's world that the
 * author never placed.
 */
export function sceneAsWorld(scene: SceneDefinition): WorldDefinition | undefined {
  const characters = scene.entities.filter(
    (entity): entity is CharacterSceneEntity => entity.kind === 'character',
  );
  if (characters.length === 0) return undefined;

  const camera = scene.entities.find((entity) => entity.id === scene.activeCameraEntityId);
  const cameraTarget =
    camera && camera.kind === 'camera' ? camera.targetEntityId : undefined;
  const focused = characters[0]!.id;

  return {
    schemaVersion: scene.schemaVersion,
    id: scene.id,
    displayName: scene.displayName,
    instances: characters.map((entity) => ({
      schemaVersion: entity.schemaVersion,
      id: entity.id,
      displayName: entity.displayName,
      source: { kind: 'character' as const, characterId: entity.characterId },
      transform: {
        position: { ...entity.transform.position },
        // The scene stores a full rotation; this runtime is yaw-only, so the
        // yaw is projected back out rather than the authored rotation being
        // rewritten to match what the runtime happens to support.
        yawRad: quaternionToYaw(entity.transform.rotation),
      },
      intentSource: controllerAsIntentSource(entity.controller),
      enabled: entity.enabled,
      ...(entity.overrides ? { overrides: { ...entity.overrides } } : {}),
      ...(entity.protection ? { protection: entity.protection } : {}),
    })),
    intentTracks: scene.intentTracks,
    focusedInstanceId: focused,
    cameraTargetInstanceId: cameraTarget ?? focused,
    ...(scene.protection ? { protection: scene.protection } : {}),
  };
}

function controllerAsIntentSource(
  controller: CharacterSceneEntity['controller'],
): WorldDefinition['instances'][number]['intentSource'] {
  switch (controller.kind) {
    case 'human':
      return { kind: 'local-input', playerIndex: controller.playerIndex };
    case 'script':
      return { kind: 'scripted-track', trackId: controller.trackId };
    case 'replay':
      return { kind: 'replay', replayId: controller.replayId };
    /*
     * An AI channel has no legacy equivalent — the World contract predates it —
     * and `none` is the honest projection: this runtime cannot deliver AI
     * intent, so reporting the instance as unbound is better than silently
     * routing it to player 0 and calling the result "AI control".
     */
    case 'ai':
    case 'none':
      return { kind: 'none' };
  }
}

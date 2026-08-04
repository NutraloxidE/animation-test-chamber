/**
 * The one boundary where a legacy World document becomes Scene data.
 *
 * There is exactly one entry point — `loadProjectDocument` — and exactly one
 * mapping function behind it. The alternative, a `project.world ?? …` check at
 * each of the two dozen sites that read a world today, is what this file exists
 * to prevent: with the check scattered, "which shape is this project?" becomes a
 * question every caller answers slightly differently, and the first one to
 * answer it wrong does so silently.
 *
 * Migration is a *read*. It never writes. Rewriting a repository the moment
 * someone opens it would turn "I looked at it" into a diff, and the first
 * casualty would be the guarantee that a read-only checkout stays
 * byte-identical. The caller is handed a migrated document and told it was
 * migrated; persisting it is an explicit Stage/Apply the human performs.
 */
import { CURRENT_SCHEMA_VERSION } from './constants.ts';
import type { ProjectDefinition } from './project.ts';
import type { SceneDefinition, SceneEntityDefinition } from './scene.ts';
import { UNIT_SCALE, yawToQuaternion } from './scene.ts';
import type { RuntimeInstanceDefinition, WorldDefinition } from './world.ts';

/**
 * A project as it was written before Scenes existed.
 *
 * Structurally identical to `ProjectDefinition` except that it carries an
 * optional `world` and no `scenes`. Declared as the *legacy* type rather than
 * as an optional field on the current one so that exactly one type in the
 * codebase names `world`, and every read of it is visibly a read of history.
 */
export type LegacyProjectDefinitionWithWorld = Omit<
  ProjectDefinition,
  'scenes' | 'activeSceneId'
> & {
  world?: WorldDefinition;
};

export interface LoadedProjectDocument {
  project: ProjectDefinition;
  /**
   * True when the input was a legacy document and the returned project is a
   * migration of it. The UI surfaces this — "Legacy World data migrated to
   * Scene in memory" — precisely because nothing was written.
   */
  migrated: boolean;
  /**
   * The migrated Scene ids, in declaration order. Empty when the legacy project
   * had no explicit World, which is not an error: a character-only repository
   * is a legitimate shape and the Rig Editor needs no Scene to open.
   */
  migratedSceneIds: string[];
}

/** True when this document predates `ProjectDefinition.scenes`. */
export function isLegacyProjectDocument(
  raw: unknown,
): raw is LegacyProjectDefinitionWithWorld {
  if (!raw || typeof raw !== 'object') return false;
  return !Array.isArray((raw as { scenes?: unknown }).scenes);
}

/**
 * Reads a project document of either shape and returns the current one.
 *
 * Deliberately not a validator. The caller validates the result with
 * `validateProject` / `validateProjectReferences` as it always did — a migration
 * that also decided what "valid" means would be a second, quietly divergent
 * copy of the schema.
 */
export function loadProjectDocument(raw: unknown): LoadedProjectDocument {
  if (!isLegacyProjectDocument(raw)) {
    const project = raw as ProjectDefinition;
    return { project, migrated: false, migratedSceneIds: [] };
  }

  const project = migrateWorldToScenes(raw);
  return {
    project,
    migrated: true,
    migratedSceneIds: project.scenes.map((scene) => scene.id),
  };
}

/**
 * The World-to-Scene mapping (work package §7.2).
 *
 * Deterministic and idempotent: the same legacy input always produces the same
 * Scene, and running the result back through produces itself. Both properties
 * are asserted by `tests/unit/scene/migration.test.ts`, because a migration
 * that is only *usually* idempotent produces a repository whose diff depends on
 * how many times someone opened it.
 *
 * A legacy project with no explicit `world` migrates to **no scenes at all**.
 * The old runtime synthesized a one-instance world from `activeCharacterId` so
 * that something could tick; persisting that synthesis now would create a Scene
 * file nobody asked for as a side effect of opening the Rig Editor.
 */
export function migrateWorldToScenes(
  legacy: LegacyProjectDefinitionWithWorld,
): ProjectDefinition {
  const { world, ...rest } = legacy;
  if (!world) {
    return { ...rest, scenes: [] };
  }

  const scene = migrateWorldDefinition(world);
  return { ...rest, scenes: [scene], activeSceneId: scene.id };
}

/** One `WorldDefinition` as one `SceneDefinition`. */
export function migrateWorldDefinition(world: WorldDefinition): SceneDefinition {
  const entities: SceneEntityDefinition[] = world.instances.map(migrateInstance);

  /*
   * `cameraTargetInstanceId` named an instance the single world camera followed.
   * A Scene expresses that as an authored Camera entity, so the intent survives
   * as data rather than as a field only the old viewport knew how to read. It is
   * appended last and ticks nothing, so migrating it cannot disturb the
   * character tick order that the replay fixtures depend on.
   *
   * `focusedInstanceId` gets no such treatment. It recorded which instance the
   * chamber *opened on*, which is editor selection — transient by definition —
   * and preserving it as canonical Scene data would make "I clicked a different
   * row" a repository change.
   */
  const target = world.instances.find((instance) => instance.id === world.cameraTargetInstanceId);
  const cameraId = target ? uniqueEntityId('scene-camera', entities) : undefined;
  if (target && cameraId) {
    entities.push({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      id: cameraId,
      displayName: 'Scene Camera',
      kind: 'camera',
      enabled: true,
      transform: {
        position: { x: 0, y: 2, z: 6 },
        rotation: yawToQuaternion(0),
        scale: { ...UNIT_SCALE },
      },
      projection: 'perspective',
      fieldOfViewDeg: 60,
      targetEntityId: target.id,
    });
  }

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: world.id,
    displayName: world.displayName,
    entities,
    intentTracks: world.intentTracks,
    ...(cameraId ? { activeCameraEntityId: cameraId } : {}),
    ...(world.protection ? { protection: world.protection } : {}),
  };
}

function migrateInstance(instance: RuntimeInstanceDefinition): SceneEntityDefinition {
  return {
    schemaVersion: instance.schemaVersion,
    id: instance.id,
    displayName: instance.displayName,
    kind: 'character',
    enabled: instance.enabled,
    characterId: instance.source.characterId,
    transform: {
      position: { ...instance.transform.position },
      // The authored yaw becomes a rotation about world Y. `SceneRuntime`
      // reads it back with `quaternionToYaw` when it spawns the Simulation,
      // so a migrated scene ticks identically to the world it came from.
      rotation: yawToQuaternion(instance.transform.yawRad),
      scale: { ...UNIT_SCALE },
    },
    controller: migrateIntentSource(instance.intentSource),
    ...(instance.overrides ? { overrides: { ...instance.overrides } } : {}),
    ...(instance.protection ? { protection: instance.protection } : {}),
  };
}

function migrateIntentSource(
  source: RuntimeInstanceDefinition['intentSource'],
): Extract<SceneEntityDefinition, { kind: 'character' }>['controller'] {
  switch (source.kind) {
    case 'local-input':
      return { kind: 'human', playerIndex: source.playerIndex };
    case 'scripted-track':
      return { kind: 'script', trackId: source.trackId };
    case 'replay':
      return { kind: 'replay', replayId: source.replayId };
    case 'none':
      return { kind: 'none' };
  }
}

/**
 * A collision-free entity id derived from `base`.
 *
 * A stable counter rather than a random suffix: a migration that produced
 * `scene-camera-7f3a` would be deterministic in no useful sense, and two runs
 * of the same migration would diff against each other.
 */
export function uniqueEntityId(
  base: string,
  existing: readonly { id: string }[],
): string {
  const taken = new Set(existing.map((entry) => entry.id));
  if (!taken.has(base)) return base;
  for (let index = 2; ; index += 1) {
    const candidate = `${base}-${index}`;
    if (!taken.has(candidate)) return candidate;
  }
}

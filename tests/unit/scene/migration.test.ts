import { describe, expect, it } from 'vitest';
import {
  isLegacyProjectDocument,
  loadProjectDocument,
  migrateWorldToScenes,
  quaternionToYaw,
  sceneById,
  sceneEntity,
  validateProject,
  validateProjectReferences,
  validateSceneReferences,
  yawToQuaternion,
  type CharacterSceneEntity,
} from '@atc/schema';
import {
  acceptanceScene,
  currentProjectWithScenes,
  legacyProjectWithoutWorld,
  legacyProjectWithWorld,
  CONTROLLED_ENTITY,
  SCRIPTED_ENTITY,
} from '../../fixtures/scene.ts';
import { loadWorldFixture } from '../../fixtures/world.ts';

function characterEntity(sceneId: string, entityId: string): CharacterSceneEntity {
  const project = migrateWorldToScenes(legacyProjectWithWorld());
  const scene = sceneById(project.scenes, sceneId)!;
  const entity = sceneEntity(scene, entityId)!;
  expect(entity.kind).toBe('character');
  return entity as CharacterSceneEntity;
}

describe('legacy document detection', () => {
  it('recognizes a project written before scenes existed', () => {
    expect(isLegacyProjectDocument(legacyProjectWithWorld())).toBe(true);
    expect(isLegacyProjectDocument(legacyProjectWithoutWorld())).toBe(true);
  });

  it('does not treat a current project as legacy', () => {
    expect(isLegacyProjectDocument(currentProjectWithScenes())).toBe(false);
  });
});

describe('explicit World migration', () => {
  const world = loadWorldFixture();
  const project = migrateWorldToScenes(legacyProjectWithWorld(world));

  it('produces one scene carrying the world identity', () => {
    expect(project.scenes).toHaveLength(1);
    expect(project.scenes[0]!.id).toBe(world.id);
    expect(project.scenes[0]!.displayName).toBe(world.displayName);
  });

  it('defaults activeSceneId to the migrated scene', () => {
    expect(project.activeSceneId).toBe(world.id);
  });

  it('drops the legacy world field entirely', () => {
    expect('world' in project).toBe(false);
  });

  it('carries every instance across as a character entity, in declaration order', () => {
    const characters = project.scenes[0]!.entities.filter((entity) => entity.kind === 'character');
    expect(characters.map((entity) => entity.id)).toEqual(
      world.instances.map((instance) => instance.id),
    );
  });

  it('carries intent tracks across unchanged', () => {
    expect(project.scenes[0]!.intentTracks).toEqual(world.intentTracks);
  });

  it('produces a schema-valid, reference-valid project', () => {
    expect(validateProject(project).issues).toEqual([]);
    expect(validateProjectReferences(project).issues).toEqual([]);
  });
});

describe('transform migration', () => {
  it('preserves position exactly', () => {
    const instance = loadWorldFixture().instances.find((entry) => entry.id === CONTROLLED_ENTITY)!;
    const entity = characterEntity(loadWorldFixture().id, CONTROLLED_ENTITY);
    expect(entity.transform.position).toEqual(instance.transform.position);
  });

  it('turns yaw into a rotation about world Y and nothing else', () => {
    const entity = characterEntity(loadWorldFixture().id, CONTROLLED_ENTITY);
    expect(entity.transform.rotation.x).toBe(0);
    expect(entity.transform.rotation.z).toBe(0);
  });

  it('opens at unit scale', () => {
    const entity = characterEntity(loadWorldFixture().id, CONTROLLED_ENTITY);
    expect(entity.transform.scale).toEqual({ x: 1, y: 1, z: 1 });
  });

  /*
   * The round trip is the property the runtime depends on: SceneRuntime spawns
   * a yaw-only Simulation from an authored quaternion, so a migrated scene that
   * did not recover its original yaw would tick differently from the world it
   * came from — a difference that shows up as a diverged replay, not as an
   * error.
   */
  it.each([0, 0.5, -1.25, Math.PI / 2, -Math.PI / 2, 3, -3])(
    'recovers yaw %s through the quaternion round trip',
    (yaw) => {
      expect(quaternionToYaw(yawToQuaternion(yaw))).toBeCloseTo(yaw, 12);
    },
  );

  it('emits unit-length quaternions', () => {
    for (const yaw of [0, 1, -2.5, Math.PI]) {
      const q = yawToQuaternion(yaw);
      expect(Math.hypot(q.x, q.y, q.z, q.w)).toBeCloseTo(1, 12);
    }
  });
});

describe('controller binding migration', () => {
  it('maps local-input to a human binding with the same player index', () => {
    const entity = characterEntity(loadWorldFixture().id, CONTROLLED_ENTITY);
    expect(entity.controller).toEqual({ kind: 'human', playerIndex: 0 });
  });

  it('maps scripted-track to a script binding with the same track id', () => {
    const instance = loadWorldFixture().instances.find((entry) => entry.id === SCRIPTED_ENTITY)!;
    const entity = characterEntity(loadWorldFixture().id, SCRIPTED_ENTITY);
    expect(entity.controller).toEqual({
      kind: 'script',
      trackId: (instance.intentSource as { trackId: string }).trackId,
    });
  });
});

describe('camera target migration', () => {
  const world = loadWorldFixture();
  const scene = acceptanceScene();

  it('turns cameraTargetInstanceId into an authored camera entity', () => {
    const camera = scene.entities.find((entity) => entity.kind === 'camera');
    expect(camera).toBeDefined();
    expect((camera as { targetEntityId?: string }).targetEntityId).toBe(
      world.cameraTargetInstanceId,
    );
    expect(scene.activeCameraEntityId).toBe(camera!.id);
  });

  /*
   * focusedInstanceId recorded which instance the chamber opened on. That is
   * editor selection, and §4.3 of the work package makes selection incapable of
   * mutating canonical data — so it must not survive as a Scene field at all.
   */
  it('does not preserve focusedInstanceId as canonical scene data', () => {
    expect(JSON.stringify(scene)).not.toContain('focusedInstanceId');
  });

  it('appends the camera after every character, leaving tick order alone', () => {
    const kinds = scene.entities.map((entity) => entity.kind);
    expect(kinds.slice(0, world.instances.length).every((kind) => kind === 'character')).toBe(true);
    expect(kinds[kinds.length - 1]).toBe('camera');
  });
});

describe('legacy project without a World', () => {
  const project = migrateWorldToScenes(legacyProjectWithoutWorld());

  /*
   * The old runtime synthesized a one-instance world from activeCharacterId so
   * that something could tick. Persisting that synthesis would create a Scene
   * file nobody composed as a side effect of opening the Rig Editor, which §7.4
   * forbids by name.
   */
  it('creates no scenes at all', () => {
    expect(project.scenes).toEqual([]);
    expect(project.activeSceneId).toBeUndefined();
  });

  it('still validates', () => {
    expect(validateProject(project).issues).toEqual([]);
    expect(validateProjectReferences(project).issues).toEqual([]);
  });
});

describe('loadProjectDocument', () => {
  it('reports migration for a legacy document and names the scenes', () => {
    const loaded = loadProjectDocument(legacyProjectWithWorld());
    expect(loaded.migrated).toBe(true);
    expect(loaded.migratedSceneIds).toEqual([loadWorldFixture().id]);
  });

  it('reports no migration for a current document', () => {
    const loaded = loadProjectDocument(currentProjectWithScenes());
    expect(loaded.migrated).toBe(false);
    expect(loaded.migratedSceneIds).toEqual([]);
  });

  it('does not mutate the document it was given', () => {
    const legacy = legacyProjectWithWorld();
    const before = JSON.stringify(legacy);
    loadProjectDocument(legacy);
    expect(JSON.stringify(legacy)).toBe(before);
  });

  /*
   * Idempotence is what keeps a repository's diff independent of how many times
   * somebody opened it. A migration that is only usually idempotent produces a
   * file that changes on alternate loads, and the second change looks exactly
   * like an edit.
   */
  it('is idempotent: migrating the migrated document changes nothing', () => {
    const once = loadProjectDocument(legacyProjectWithWorld()).project;
    const twice = loadProjectDocument(once).project;
    expect(twice).toEqual(once);
  });
});

describe('scene reference validation', () => {
  const characterIds = new Set(currentProjectWithScenes().characters.map((entry) => entry.id));

  it('accepts the migrated acceptance scene', () => {
    expect(validateSceneReferences(acceptanceScene(), characterIds).issues).toEqual([]);
  });

  it('refuses an entity naming an unknown character', () => {
    const scene = acceptanceScene();
    (scene.entities[0] as CharacterSceneEntity).characterId = 'no-such-character';
    const result = validateSceneReferences(scene, characterIds);
    expect(result.valid).toBe(false);
    expect(result.issues[0]!.keyword).toBe('reference');
  });

  it('refuses a script binding naming an unknown intent track', () => {
    const scene = acceptanceScene();
    (scene.entities[1] as CharacterSceneEntity).controller = {
      kind: 'script',
      trackId: 'no-such-track',
    };
    expect(validateSceneReferences(scene, characterIds).valid).toBe(false);
  });

  it('refuses duplicate entity ids', () => {
    const scene = acceptanceScene();
    scene.entities[1]!.id = scene.entities[0]!.id;
    const result = validateSceneReferences(scene, characterIds);
    expect(result.issues.some((issue) => issue.keyword === 'unique')).toBe(true);
  });

  it('refuses an un-normalized rotation', () => {
    const scene = acceptanceScene();
    scene.entities[0]!.transform.rotation = { x: 0, y: 0.9, z: 0, w: 0.9 };
    const result = validateSceneReferences(scene, characterIds);
    expect(result.issues.some((issue) => issue.keyword === 'normalized')).toBe(true);
  });

  /*
   * A blob: URL resolves exactly once, in the tab that minted it. A scene file
   * holding one looks correct to its author and is broken for everyone else,
   * so it is refused by name rather than discovered as a missing mesh.
   */
  it('refuses a browser-only object URL as a prop asset', () => {
    const scene = acceptanceScene();
    scene.entities.push({
      schemaVersion: 2,
      id: 'dropped-prop',
      displayName: 'Dropped prop',
      kind: 'prop',
      enabled: true,
      transform: {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1, y: 1, z: 1 },
      },
      asset: { kind: 'model', assetPath: 'blob:http://localhost:5173/9f2a-c1' },
    });
    const result = validateSceneReferences(scene, characterIds);
    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.path.endsWith('/asset/assetPath'))).toBe(true);
  });

  it('refuses an active camera that names a non-camera entity', () => {
    const scene = acceptanceScene();
    scene.activeCameraEntityId = scene.entities[0]!.id;
    expect(validateSceneReferences(scene, characterIds).valid).toBe(false);
  });
});

describe('project-wide scene identity', () => {
  it('refuses duplicate scene ids', () => {
    const project = currentProjectWithScenes();
    project.scenes = [project.scenes[0]!, { ...project.scenes[0]! }];
    const result = validateProjectReferences(project);
    expect(result.issues.some((issue) => issue.keyword === 'unique')).toBe(true);
  });

  it('refuses an activeSceneId naming no scene', () => {
    const project = currentProjectWithScenes();
    project.activeSceneId = 'no-such-scene';
    const result = validateProjectReferences(project);
    expect(result.issues.some((issue) => issue.path === '/activeSceneId')).toBe(true);
  });
});

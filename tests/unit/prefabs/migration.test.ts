/**
 * The Character → Prefab migration (§18.2, §18.3).
 *
 * Run against the repository's real project and its real Prefabs, because the
 * claim being tested is about *this* migration and not about a migration in
 * general. The equivalence assertions compare the migrated Prefabs to the
 * Characters they came from field by field: a golden file would pass just as
 * happily if both sides drifted together, which is the one outcome that matters
 * here.
 */
import { describe, expect, it } from 'vitest';
import { componentOfType, isCharacterComposition } from '@atc/schema';
import { resolveGameObjectPrefab, resolvedComponents } from '@atc/prefab-runtime';
import { loadCanonicalProject } from '../../../harness/animation-assets.ts';
import {
  DEFAULT_SCENE_CAMERA_PREFAB_ID,
  HUMANOID_BASE_PREFAB_ID,
  LEGACY_CHARACTER_PREFAB_IDS,
  runMigration,
  runPrefabMigration,
} from '../../../harness/migrate-character-prefabs.ts';
import { loadPrefabRegistry } from '../../../harness/prefabs.ts';

const project = loadCanonicalProject();
const registry = loadPrefabRegistry();
const migration = runMigration();

describe('the migrated prefab set', () => {
  it('turns the five Characters into five concrete Prefabs', () => {
    expect(project.characters).toHaveLength(5);
    for (const character of project.characters) {
      const reference = migration.identityMap[character.id];
      expect(reference, `no Prefab for "${character.id}"`).toBeDefined();
      expect(registry.find(reference!)?.abstract).toBe(false);
    }
  });

  it('makes the humanoid base abstract', () => {
    const version = registry.latestVersion(HUMANOID_BASE_PREFAB_ID);
    expect(version).toBeDefined();
    expect(registry.get(registry.referenceTo(HUMANOID_BASE_PREFAB_ID, version!)).abstract).toBe(
      true,
    );
  });

  it('maps the old Character ids deterministically', () => {
    expect(migration.identityMap['demo-humanoid']?.assetId).toBe('navigator');
    expect(migration.identityMap['alternate-humanoid-character']?.assetId).toBe('relay');
    for (const [characterId, prefabId] of Object.entries(LEGACY_CHARACTER_PREFAB_IDS)) {
      expect(migration.identityMap[characterId]?.assetId).toBe(prefabId);
    }
  });

  it('stores every concrete Prefab as a variant, never as a copy', () => {
    for (const reference of Object.values(migration.identityMap)) {
      const asset = registry.get(reference);
      expect(asset.derivation.mode).toBe('variant');
      expect('root' in asset).toBe(false);
    }
  });

  it('produces byte-identical output when run twice', () => {
    const first = runPrefabMigration(project);
    const second = runPrefabMigration(project);
    expect(JSON.stringify(first.prefabs)).toBe(JSON.stringify(second.prefabs));
    expect(first.projectContent).toBe(second.projectContent);
  });

  it('leaves no Prefab reference unresolvable', () => {
    for (const stored of registry.all()) {
      const reference = registry.referenceTo(stored.id, stored.version);
      const errors = resolveGameObjectPrefab(registry, reference).issues.filter(
        (issue) => issue.severity === 'error',
      );
      expect(errors, `${stored.id}@${stored.version}`).toEqual([]);
    }
  });
});

describe('effective equivalence with the pre-migration Characters', () => {
  for (const character of project.characters) {
    describe(character.id, () => {
      const reference = migration.identityMap[character.id]!;
      const components = resolvedComponents(
        resolveGameObjectPrefab(registry, reference).prefab.root,
      );

      it('resolves to the same model binding', () => {
        const model = componentOfType(components, 'model-renderer');
        if (character.model.kind === 'procedural-humanoid') {
          expect(model?.model).toEqual({
            kind: 'procedural-humanoid',
            presetId: character.model.presetId,
          });
        } else {
          expect(model?.model).toEqual({
            kind: 'repository-model',
            assetPath: character.model.assetPath,
            scale: character.model.scale,
            rotationYRad: character.model.rotationYRad,
          });
        }
      });

      it('resolves to the same Behavior, Motion Set, Rig and Tuning', () => {
        const animator = componentOfType(components, 'animator');
        expect(animator?.assignment.behavior).toEqual(character.animation.behavior);
        expect(animator?.assignment.motionSet).toEqual(character.animation.motionSet);
        expect(animator?.assignment.rig).toEqual(character.animation.rig);
        expect(animator?.assignment.tuning).toEqual(character.animation.tuning);
        expect(animator?.assignment.instanceOverrides).toEqual(
          character.animation.instanceOverrides,
        );
      });

      it('resolves to the same capsule', () => {
        const capsule = componentOfType(components, 'capsule-collider');
        expect(capsule?.radius).toBe(character.capsuleRadius);
        expect(capsule?.height).toBe(character.capsuleHeight);
      });

      it('preserves every authored grip as a socket', () => {
        if (character.model.kind !== 'repository-model' || !character.model.rightHandBone) return;
        const sockets = componentOfType(components, 'equipment-sockets');
        for (const [mode, grip] of Object.entries(character.model.weaponGrips ?? {})) {
          const socket = sockets?.sockets.find((entry) => entry.socketId === `right-hand-${mode}`);
          expect(socket?.boneName).toBe(character.model.rightHandBone);
          expect(socket?.localPosition).toEqual(grip.position);
          expect(socket?.localRotation).toEqual(grip.rotation);
          expect(socket?.acceptedItemTags).toContain(mode);
        }
      });

      it('is a character by composition rather than by kind', () => {
        expect(isCharacterComposition(components)).toBe(true);
      });
    });
  }
});

describe('the migrated Scenes', () => {
  const scene = migration.project.scenes[0]!;
  const original = project.scenes[0]!;

  it('gives every entity a GameObject instance on an exact Prefab version', () => {
    expect(scene.gameObjects).toHaveLength(original.entities.length);
    for (const gameObject of scene.gameObjects ?? []) {
      expect(gameObject.prefab.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(gameObject.prefab.contentHash).toMatch(/^[a-f0-9]{64}$/);
      expect(registry.find(gameObject.prefab)).toBeDefined();
    }
  });

  it('preserves transforms and enabled state', () => {
    for (const [index, entity] of original.entities.entries()) {
      const gameObject = scene.gameObjects![index]!;
      expect(gameObject.id).toBe(entity.id);
      expect(gameObject.transform).toEqual(entity.transform);
      expect(gameObject.enabled).toBe(entity.enabled);
    }
  });

  it('preserves controller bindings', () => {
    for (const entity of original.entities) {
      if (entity.kind !== 'character') continue;
      const gameObject = scene.gameObjects!.find((candidate) => candidate.id === entity.id);
      expect(gameObject?.bindings.characterIntent).toEqual(entity.controller);
    }
  });

  it('preserves the camera relation as a GameObject id', () => {
    const camera = original.entities.find((entity) => entity.kind === 'camera');
    if (!camera || camera.kind !== 'camera') return;
    const gameObject = scene.gameObjects!.find((candidate) => candidate.id === camera.id);
    expect(gameObject?.relations.cameraTargetGameObjectId).toBe(camera.targetEntityId);
    expect(gameObject?.prefab.assetId).toBe(DEFAULT_SCENE_CAMERA_PREFAB_ID);
    // A relation names an id, never a position in a list.
    expect(Number.isNaN(Number(gameObject?.relations.cameraTargetGameObjectId))).toBe(true);
  });

  it('carries the active camera across as a GameObject id', () => {
    expect(scene.activeCameraGameObjectId).toBe(original.activeCameraEntityId);
  });

  it('writes no runtime state into any GameObject instance', () => {
    const serialized = JSON.stringify(scene.gameObjects);
    for (const forbidden of ['animationTime', 'velocity', 'mixer', 'activeState', 'inputBuffer']) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

/**
 * Hand-built Prefabs for the schema and derivation tests.
 *
 * Deliberately not the migrated ones. The migration output is checked against
 * the Characters it came from; these fixtures exist to exercise the shapes the
 * demo project does not happen to author — a nested Prefab, a cycle, an
 * inherited model that a variant overrides — and a test that could only be
 * written against real data would be a test that stops existing the moment the
 * demo project changes.
 */
import type {
  AnimatorComponent,
  CharacterAnimationAssignment,
  GameObjectComponentDefinition,
  GameObjectPrefabAsset,
  GameObjectPrefabMetadata,
  GameObjectPrefabReference,
  ModelRendererComponent,
  PrefabNodeDefinition,
} from '@atc/schema';
import { IDENTITY_TRANSFORM } from '@atc/schema';
import { PrefabAssetRegistry, type StoredPrefab } from '@atc/prefab-runtime';
import { computeContentHash, sealAsset } from '@atc/animation-asset-runtime';

const HASH = 'a'.repeat(64);

export function animationReference(assetType: string, assetId: string) {
  return { assetType, assetId, version: '1.0.0', contentHash: HASH } as never;
}

export const SAMPLE_ASSIGNMENT: CharacterAnimationAssignment = {
  behavior: animationReference('animation-behavior', 'sample-behavior'),
  motionSet: animationReference('animation-motion-set', 'sample-motion-set'),
  rig: animationReference('humanoid-rig', 'sample-rig'),
  instanceOverrides: [],
};

export function metadata(id: string, version = '1.0.0'): GameObjectPrefabMetadata {
  return {
    schemaVersion: 1,
    assetType: 'game-object-prefab',
    id,
    version,
    displayName: id,
    description: '',
    tags: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'test',
    contentHash: '',
  };
}

export function modelComponent(presetId: string): ModelRendererComponent {
  return {
    schemaVersion: 1,
    componentId: 'model',
    componentType: 'model-renderer',
    enabled: true,
    model: { kind: 'procedural-humanoid', presetId },
    castShadow: true,
    receiveShadow: true,
  };
}

export function animatorComponent(
  assignment: CharacterAnimationAssignment = SAMPLE_ASSIGNMENT,
): AnimatorComponent {
  return {
    schemaVersion: 1,
    componentId: 'animator',
    componentType: 'animator',
    enabled: true,
    assignment,
  };
}

export function node(
  nodeId: string,
  components: GameObjectComponentDefinition[] = [],
  children: PrefabNodeDefinition['children'] = [],
): PrefabNodeDefinition {
  return {
    nodeId,
    displayName: nodeId,
    enabled: true,
    transform: IDENTITY_TRANSFORM,
    components,
    children,
  };
}

export function basePrefab(
  id: string,
  root: PrefabNodeDefinition,
  options: { abstract?: boolean } = {},
): GameObjectPrefabAsset {
  return sealAsset({
    metadata: metadata(id),
    derivation: { mode: 'base' as const },
    abstract: options.abstract ?? false,
    root,
  }) as GameObjectPrefabAsset;
}

export function referenceTo(asset: GameObjectPrefabAsset): GameObjectPrefabReference {
  return {
    assetType: 'game-object-prefab',
    assetId: asset.metadata.id,
    version: asset.metadata.version,
    contentHash: computeContentHash(asset),
  };
}

export function registryOf(...assets: GameObjectPrefabAsset[]): PrefabAssetRegistry {
  return new PrefabAssetRegistry(
    assets.map(
      (document): StoredPrefab => ({
        id: document.metadata.id,
        version: document.metadata.version,
        document,
      }),
    ),
  );
}

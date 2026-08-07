/**
 * Prefab route identity, and the legacy redirect (§14).
 *
 * Negative assertions again, for the same reason: the failure worth preventing
 * is a Prefab Editor that renders perfectly while showing an asset the URL did
 * not name. A resolver that falls back to the first Prefab produces exactly
 * that, and nothing visual would catch it.
 *
 * The redirect gets the same treatment. `/edit/rig/demo-humanoid` must land on
 * `navigator` — the Prefab that Character actually became — and a legacy id
 * with no mapping must be a not-found rather than "some Prefab".
 */
import { describe, expect, it } from 'vitest';
import { LEGACY_CHARACTER_PREFAB_IDS } from '@atc/schema';
import {
  prefabParentReference,
  prefabRedirectForLegacyCharacterId,
  resolvePrefabEditorTarget,
} from '../../../apps/web/src/prefab-editor/resolve-prefab-editor-target.ts';
import {
  filterPrefabRows,
  prefabListRows,
} from '../../../apps/web/src/prefab-editor/prefab-list.ts';
import { prefabEditorPath } from '../../../apps/web/src/app/routes.ts';
import { loadDemoProject } from '../../fixtures/project.ts';
import { loadPrefabRegistry } from '../../../harness/prefabs.ts';

const registry = loadPrefabRegistry();
const project = loadDemoProject();

describe('prefab route identity', () => {
  it('resolves the exact Prefab the route names', () => {
    const target = resolvePrefabEditorTarget(registry, 'navigator');
    expect(target.status).toBe('resolved');
    if (target.status !== 'resolved') return;
    expect(target.prefabId).toBe('navigator');
    expect(target.document.metadata.id).toBe('navigator');
  });

  it('does not fall back to the first Prefab for an unknown id', () => {
    const target = resolvePrefabEditorTarget(registry, 'no-such-prefab');
    expect(target.status).toBe('missing');
    expect(JSON.stringify(target)).not.toContain('"document"');
  });

  it('treats an absent route parameter as no target, not as a default', () => {
    expect(resolvePrefabEditorTarget(registry, null).status).toBe('no-target');
  });

  it('opens the latest version of the lineage', () => {
    const target = resolvePrefabEditorTarget(registry, 'navigator');
    if (target.status !== 'resolved') throw new Error('expected navigator to resolve');
    expect(target.version).toBe(registry.latestVersion('navigator'));
  });

  it('encodes the id exactly once', () => {
    expect(prefabEditorPath('a/b')).toBe('/edit/prefab/a%2Fb');
    expect(prefabEditorPath('navigator', 'animator')).toBe(
      '/edit/prefab/navigator?component=animator',
    );
  });
});

describe('legacy rig redirect', () => {
  it('sends every migrated Character to the Prefab it became', () => {
    for (const [characterId, prefabId] of Object.entries(LEGACY_CHARACTER_PREFAB_IDS)) {
      expect(prefabRedirectForLegacyCharacterId(registry, characterId)).toBe(prefabId);
    }
  });

  it('refuses to guess for an unmapped Character id', () => {
    expect(prefabRedirectForLegacyCharacterId(registry, 'ghost-character')).toBeNull();
    expect(prefabRedirectForLegacyCharacterId(registry, null)).toBeNull();
  });

  it('lands on the Animator, which is what the old editor opened', () => {
    const prefabId = prefabRedirectForLegacyCharacterId(registry, 'demo-humanoid');
    expect(prefabId).not.toBeNull();
    expect(prefabEditorPath(prefabId!, 'animator')).toBe(
      '/edit/prefab/navigator?component=animator',
    );
  });
});

describe('prefab list', () => {
  const rows = prefabListRows({ registry, scenes: project.scenes });

  it('has a row per stored version', () => {
    expect(rows).toHaveLength(registry.all().length);
  });

  it('reports Components from the resolved composition, not the stored patch', () => {
    const navigator = rows.find((row) => row.prefabId === 'navigator');
    // navigator is a variant whose stored payload is one add-component patch.
    expect(navigator?.derivation).toBe('variant');
    expect(navigator?.componentTypes).toContain('animator');
    expect(navigator?.componentTypes).toContain('character-motor');
  });

  it('counts exact Scene usage per version', () => {
    const navigator = rows.find((row) => row.prefabId === 'navigator');
    const placed = project.scenes.flatMap((scene) =>
      (scene.gameObjects ?? []).filter((instance) => instance.prefab.assetId === 'navigator'),
    );
    expect(navigator?.sceneUsageCount).toBe(placed.length);
  });

  it('filters Characters by composition rather than by name', () => {
    const characters = filterPrefabRows(rows, 'characters');
    expect(characters.every((row) => row.isCharacter)).toBe(true);
    expect(characters.map((row) => row.prefabId)).toContain('navigator');
    // The camera Prefab has neither an Animator nor a motor, whatever it is called.
    expect(characters.map((row) => row.prefabId)).not.toContain('default-scene-camera');
  });

  it('filters cameras and lights by Component', () => {
    expect(filterPrefabRows(rows, 'cameras').map((row) => row.prefabId)).toContain(
      'default-scene-camera',
    );
    expect(
      filterPrefabRows(rows, 'cameras').every((row) => row.componentTypes.includes('camera')),
    ).toBe(true);
    expect(
      filterPrefabRows(rows, 'lights').every((row) => row.componentTypes.includes('light')),
    ).toBe(true);
  });

  it('separates abstract Prefabs from placeable ones', () => {
    const abstract = filterPrefabRows(rows, 'abstract');
    expect(abstract.every((row) => row.abstract)).toBe(true);
    expect(filterPrefabRows(rows, 'all').length).toBeGreaterThan(abstract.length);
  });
});

describe('derivation', () => {
  it('names a variant parent and a fork source through one accessor', () => {
    const navigator = registry.get(registry.referenceTo('navigator', '1.0.0'));
    expect(prefabParentReference(navigator)?.assetId).toBe('humanoid-character-base');

    const base = registry.get(registry.referenceTo('humanoid-character-base', '1.0.0'));
    expect(prefabParentReference(base)).toBeUndefined();
  });
});

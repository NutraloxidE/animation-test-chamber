/**
 * Resolution isolation.
 *
 * The bug these tests exist for: the world cached the whole `ResolvedProject`
 * under a key built from animation asset references. A `ResolvedProject`
 * carries the character's id, display name, model binding and capsule
 * dimensions, so two *different* characters sharing one animation set received
 * each other's body — silently, and invisibly in a fixture where both
 * characters happen to look the same.
 *
 * The fix splits resolution into a character-independent `ResolvedAnimationBundle`
 * (shared by reference, which is the point of the cache) and a per-character
 * wrapper (never shared, which is the point of these tests).
 */
import { describe, expect, it } from 'vitest';
import type { CanonicalPatch, CharacterDefinition, ProjectDefinition, WorldDefinition } from '@atc/schema';
import { CURRENT_SCHEMA_VERSION } from '@atc/schema';
import { WorldRuntime, animationResolutionKey, resolveWorld } from '@atc/world-runtime';
import { demoRegistry, loadDemoProject } from '../../fixtures/project.ts';

/** Two characters, identical animation references, deliberately different bodies. */
function twoBodiesOneAnimationSet(): ProjectDefinition {
  const project = loadDemoProject();
  const base = project.characters.find((entry) => entry.id === 'demo-humanoid')!;

  const knight: CharacterDefinition = {
    ...structuredClone(base),
    id: 'knight',
    displayName: 'Knight',
    model: { kind: 'repository-model', assetPath: 'assets/models/knight.glb', scale: 1, rotationYRad: 0 },
    capsuleRadius: 0.4,
    capsuleHeight: 1.85,
  };
  const mage: CharacterDefinition = {
    ...structuredClone(base),
    id: 'mage',
    displayName: 'Mage',
    model: { kind: 'repository-model', assetPath: 'assets/models/mage.glb', scale: 1, rotationYRad: 0 },
    capsuleRadius: 0.3,
    capsuleHeight: 1.62,
  };

  return { ...project, characters: [...project.characters, knight, mage] };
}

function worldOfTwo(a: string, b: string): WorldDefinition {
  const instance = (id: string, characterId: string, x: number) => ({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id,
    displayName: id,
    source: { kind: 'character' as const, characterId },
    transform: { position: { x, y: 2, z: 0 }, yawRad: 0 },
    intentSource: { kind: 'none' as const },
    enabled: true,
  });
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: 'isolation-world',
    displayName: 'Isolation',
    instances: [instance('first', a, -2), instance('second', b, 2)],
    intentTracks: [],
    focusedInstanceId: 'first',
    cameraTargetInstanceId: 'first',
  };
}

describe('animation resolution isolation', () => {
  it('does not share character-specific resolved data across characters with shared animation assets', () => {
    const project = twoBodiesOneAnimationSet();
    const runtime = new WorldRuntime({
      registry: demoRegistry(),
      project,
      world: worldOfTwo('knight', 'mage'),
    });

    const first = runtime.instance('first')!;
    const second = runtime.instance('second')!;

    // Each wrapper carries its own character, not the other one's.
    expect(first.resolved.character.id).toBe('knight');
    expect(second.resolved.character.id).toBe('mage');
    expect(first.resolved.character.displayName).toBe('Knight');
    expect(second.resolved.character.displayName).toBe('Mage');

    // The specific contamination the old cache produced.
    expect(first.resolved.character.model).toEqual({
      kind: 'repository-model',
      assetPath: 'assets/models/knight.glb',
      scale: 1,
      rotationYRad: 0,
    });
    expect(second.resolved.character.model).toEqual({
      kind: 'repository-model',
      assetPath: 'assets/models/mage.glb',
      scale: 1,
      rotationYRad: 0,
    });
    expect(first.resolved.character.capsuleHeight).toBe(1.85);
    expect(second.resolved.character.capsuleHeight).toBe(1.62);
    expect(first.resolved.character.capsuleRadius).toBe(0.4);
    expect(second.resolved.character.capsuleRadius).toBe(0.3);

    expect(first.resolved).not.toBe(second.resolved);
    expect(first.resolved.character).not.toBe(second.resolved.character);
    expect(first.simulation).not.toBe(second.simulation);
  });

  it('shares immutable animation bundle members across characters with shared animation assets', () => {
    const project = twoBodiesOneAnimationSet();
    const resolution = resolveWorld({
      registry: demoRegistry(),
      project,
      world: worldOfTwo('knight', 'mage'),
    });
    const [first, second] = resolution.instances;

    // One bundle, resolved once, handed to both.
    expect(first!.animationResolutionKey).toBe(second!.animationResolutionKey);
    expect(first!.bundle).toBe(second!.bundle);
    expect(first!.resolved.graph).toBe(second!.resolved.graph);
    expect(first!.resolved.clips).toBe(second!.resolved.clips);
    expect(first!.resolved.character.skeleton).toBe(second!.resolved.character.skeleton);
    expect(first!.resolved.motionBindings).toBe(second!.resolved.motionBindings);
    expect(first!.resolved.clipAssetSources).toBe(second!.resolved.clipAssetSources);
  });

  it('gives one character used twice distinct wrappers and one shared bundle', () => {
    const project = twoBodiesOneAnimationSet();
    const resolution = resolveWorld({
      registry: demoRegistry(),
      project,
      world: worldOfTwo('knight', 'knight'),
    });
    const [first, second] = resolution.instances;

    expect(first!.resolved).not.toBe(second!.resolved);
    expect(first!.resolved.character).not.toBe(second!.resolved.character);
    expect(first!.resolved.character.id).toBe(second!.resolved.character.id);
    expect(first!.bundle).toBe(second!.bundle);
  });

  it('does not share a bundle between characters with different animation overrides', () => {
    const project = twoBodiesOneAnimationSet();
    const tweak: CanonicalPatch[] = [
      { op: 'set', path: '/graph/states/run/speedScale', value: 1.4 },
    ];
    const characters = project.characters.map((character) =>
      character.id === 'mage'
        ? {
            ...character,
            animation: { ...character.animation, instanceOverrides: tweak },
          }
        : character,
    );
    const tweaked = { ...project, characters };

    const knight = tweaked.characters.find((entry) => entry.id === 'knight')!;
    const mage = tweaked.characters.find((entry) => entry.id === 'mage')!;
    expect(animationResolutionKey(knight)).not.toBe(animationResolutionKey(mage));

    const resolution = resolveWorld({
      registry: demoRegistry(),
      project: tweaked,
      world: worldOfTwo('knight', 'mage'),
    });
    const [first, second] = resolution.instances;
    expect(first!.bundle).not.toBe(second!.bundle);
    expect(first!.resolved.graph).not.toBe(second!.resolved.graph);
    // And the wrappers still carry the right characters.
    expect(first!.resolved.character.id).toBe('knight');
    expect(second!.resolved.character.id).toBe('mage');
  });

  it('includes preview overrides in animation resolution identity', () => {
    const project = twoBodiesOneAnimationSet();
    const world = worldOfTwo('knight', 'mage');
    const registry = demoRegistry();
    const before = JSON.stringify(project);

    const preview: CanonicalPatch[] = [
      { op: 'set', path: '/graph/states/run/speedScale', value: 1.9 },
    ];

    const plain = resolveWorld({ registry, project, world });
    const previewed = resolveWorld({ registry, project, world, previewOverrides: preview });

    expect(previewed.instances[0]!.animationResolutionKey).not.toBe(
      plain.instances[0]!.animationResolutionKey,
    );
    // The second resolution must observe its own preview value, not the first's.
    expect(previewed.instances[0]!.resolved.graph).not.toBe(plain.instances[0]!.resolved.graph);

    // Both instances of the previewed resolution still share one bundle.
    expect(previewed.instances[0]!.bundle).toBe(previewed.instances[1]!.bundle);

    // Nothing about a preview touches the canonical document.
    expect(JSON.stringify(project)).toBe(before);
  });
});

describe('animation resolution key stability', () => {
  const project = twoBodiesOneAnimationSet();
  const knight = project.characters.find((entry) => entry.id === 'knight')!;

  it('ignores fields that only change the character wrapper', () => {
    for (const changed of [
      { ...knight, id: 'renamed' },
      { ...knight, displayName: 'Something Else' },
      {
        ...knight,
        model: {
          kind: 'repository-model' as const,
          assetPath: 'assets/models/other.glb',
          scale: 1,
          rotationYRad: 0,
        },
      },
      { ...knight, capsuleRadius: 0.99 },
      { ...knight, capsuleHeight: 3.5 },
    ]) {
      expect(animationResolutionKey(changed)).toBe(animationResolutionKey(knight));
    }
  });

  it('changes when any animation reference changes', () => {
    const swapped: CharacterDefinition = {
      ...knight,
      animation: {
        ...knight.animation,
        motionSet: { ...knight.animation.motionSet, version: '9.9.9' },
      },
    };
    expect(animationResolutionKey(swapped)).not.toBe(animationResolutionKey(knight));

    const untuned: CharacterDefinition = { ...knight, animation: { ...knight.animation } };
    delete (untuned.animation as { tuning?: unknown }).tuning;
    expect(animationResolutionKey(untuned)).not.toBe(animationResolutionKey(knight));
  });

  it('changes when an animation patch changes', () => {
    const patched: CharacterDefinition = {
      ...knight,
      animation: {
        ...knight.animation,
        instanceOverrides: [{ op: 'set', path: '/graph/states/run/speedScale', value: 1.1 }],
      },
    };
    expect(animationResolutionKey(patched)).not.toBe(animationResolutionKey(knight));
  });

  it('is unaffected by property order inside a patch value', () => {
    const withOrderA: CharacterDefinition = {
      ...knight,
      animation: {
        ...knight.animation,
        instanceOverrides: [
          { op: 'set', path: '/graph/states/run/x', value: { alpha: 1, beta: 2 } },
        ],
      },
    };
    const withOrderB: CharacterDefinition = {
      ...knight,
      animation: {
        ...knight.animation,
        instanceOverrides: [
          // The same value, written the other way round — as it would arrive
          // from a differently ordered JSON file.
          { op: 'set', path: '/graph/states/run/x', value: { beta: 2, alpha: 1 } },
        ],
      },
    };
    expect(animationResolutionKey(withOrderA)).toBe(animationResolutionKey(withOrderB));
  });

  it('carries no character identity', () => {
    const key = animationResolutionKey(knight);
    expect(key).not.toContain('knight');
    expect(key).not.toContain('Knight');
    expect(key).not.toContain('.glb');
  });
});

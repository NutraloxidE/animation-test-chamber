/**
 * Derivation and resolution (§18.4).
 *
 * The property under test throughout is *containment*: a variant changes the
 * variant, a nested instance's override changes that instance, and neither
 * reaches back into what it derived from. A resolver that mutated registry
 * documents would pass a naive assertion on the variant and quietly corrupt the
 * parent, so several of these tests resolve the parent again afterwards and
 * check it did not move.
 */
import { describe, expect, it } from 'vitest';
import { componentOfType, type GameObjectPrefabReference } from '@atc/schema';
import {
  createPrefabFork,
  createPrefabVariant,
  resolveGameObjectPrefab,
  resolvedComponents,
} from '@atc/prefab-runtime';
import { computeContentHash, sealAsset } from '@atc/animation-asset-runtime';
import {
  SAMPLE_ASSIGNMENT,
  animationReference,
  animatorComponent,
  basePrefab,
  modelComponent,
  node,
  referenceTo,
  registryOf,
} from './fixtures.ts';

const BASE = basePrefab('base', node('root', [modelComponent('navigator'), animatorComponent()]));
const BASE_REFERENCE = referenceTo(BASE);

function variant(id: string, patches: Parameters<typeof createPrefabVariant>[2]) {
  return createPrefabVariant(
    {
      id,
      displayName: id,
      description: '',
      tags: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      createdBy: 'test',
    },
    BASE_REFERENCE,
    patches,
  );
}

function resolveIn(
  registry: ReturnType<typeof registryOf>,
  reference: GameObjectPrefabReference,
) {
  const resolution = resolveGameObjectPrefab(registry, reference);
  return {
    components: resolvedComponents(resolution.prefab.root),
    issues: resolution.issues,
    prefab: resolution.prefab,
  };
}

describe('variants', () => {
  it('inherits every component of its parent', () => {
    const child = variant('child', []);
    const registry = registryOf(BASE, child);
    const { components } = resolveIn(registry, referenceTo(child));
    expect(components.map((entry) => entry.componentType).sort()).toEqual([
      'animator',
      'model-renderer',
    ]);
  });

  it('overrides a model in the variant only', () => {
    const child = variant('child', [
      {
        kind: 'patch-component',
        nodeId: 'root',
        componentId: 'model',
        patches: [{ path: '/model/presetId', op: 'set', value: 'relay' }],
      },
    ]);
    const registry = registryOf(BASE, child);

    const childModel = componentOfType(
      resolveIn(registry, referenceTo(child)).components,
      'model-renderer',
    );
    expect(childModel?.model).toEqual({ kind: 'procedural-humanoid', presetId: 'relay' });

    const parentModel = componentOfType(
      resolveIn(registry, BASE_REFERENCE).components,
      'model-renderer',
    );
    expect(parentModel?.model).toEqual({ kind: 'procedural-humanoid', presetId: 'navigator' });
  });

  it('repoints an Animator reference in the variant only', () => {
    const other = animationReference('animation-motion-set', 'other-motion-set');
    const child = variant('child', [
      {
        kind: 'patch-component',
        nodeId: 'root',
        componentId: 'animator',
        patches: [{ path: '/assignment/motionSet', op: 'set', value: other }],
      },
    ]);
    const registry = registryOf(BASE, child);

    expect(
      componentOfType(resolveIn(registry, referenceTo(child)).components, 'animator')?.assignment
        .motionSet.assetId,
    ).toBe('other-motion-set');
    expect(
      componentOfType(resolveIn(registry, BASE_REFERENCE).components, 'animator')?.assignment
        .motionSet.assetId,
    ).toBe(SAMPLE_ASSIGNMENT.motionSet.assetId);
  });

  it('can add a component its parent does not have', () => {
    const modelless = basePrefab('abstract-base', node('root', [animatorComponent()]), {
      abstract: true,
    });
    const child = createPrefabVariant(
      {
        id: 'concrete',
        displayName: 'concrete',
        description: '',
        tags: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        createdBy: 'test',
      },
      referenceTo(modelless),
      [{ kind: 'add-component', nodeId: 'root', component: modelComponent('sentinel') }],
    );
    const registry = registryOf(modelless, child);
    expect(
      componentOfType(resolveIn(registry, referenceTo(child)).components, 'model-renderer')?.model,
    ).toEqual({ kind: 'procedural-humanoid', presetId: 'sentinel' });
    expect(
      componentOfType(resolveIn(registry, referenceTo(modelless)).components, 'model-renderer'),
    ).toBeUndefined();
  });

  it('does not follow a parent version bump on its own', () => {
    const child = variant('child', []);
    const bumped = sealAsset({
      ...BASE,
      metadata: { ...BASE.metadata, version: '1.0.1', contentHash: '' },
      root: node('root', [modelComponent('sentinel'), animatorComponent()]),
    });
    const registry = registryOf(BASE, bumped as never, child);

    // The variant still names 1.0.0 exactly, so it still resolves to 1.0.0's
    // model. Adoption is a separate, explicitly targeted act (§14.1).
    expect(
      componentOfType(resolveIn(registry, referenceTo(child)).components, 'model-renderer')?.model,
    ).toEqual({ kind: 'procedural-humanoid', presetId: 'navigator' });
    expect((child.derivation as { parent: GameObjectPrefabReference }).parent.version).toBe('1.0.0');
  });
});

describe('forks', () => {
  it('stops resolving through its parent', () => {
    const forked = createPrefabFork(
      {
        id: 'forked',
        displayName: 'forked',
        description: '',
        tags: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        createdBy: 'test',
      },
      BASE_REFERENCE,
      'diverged appearance',
      node('root', [modelComponent('sentinel'), animatorComponent()]),
    );
    // The parent is deliberately absent from the registry: a fork that still
    // needed it would fail to resolve here, which is exactly the difference
    // between a fork and a variant.
    const registry = registryOf(forked);
    const { components, issues } = resolveIn(registry, referenceTo(forked));
    expect(issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(componentOfType(components, 'model-renderer')?.model).toEqual({
      kind: 'procedural-humanoid',
      presetId: 'sentinel',
    });
  });
});

describe('nesting', () => {
  const lantern = basePrefab('lantern', node('root', [modelComponent('relay')]));

  function holderWith(overrides: { nodeId: string; componentId: string; patches: unknown[] }[]) {
    return basePrefab(
      'holder',
      node(
        'root',
        [animatorComponent()],
        [
          {
            kind: 'prefab-instance',
            instanceId: 'held',
            prefab: referenceTo(lantern),
            transform: {
              position: { x: 1, y: 0, z: 0 },
              rotation: { x: 0, y: 0, z: 0, w: 1 },
              scale: { x: 1, y: 1, z: 1 },
            },
            overrides: overrides as never,
          },
        ],
      ),
    );
  }

  it('expands a nested Prefab into the resolved tree, composed with its transform', () => {
    const holder = holderWith([]);
    const registry = registryOf(lantern, holder);
    const { prefab } = resolveIn(registry, referenceTo(holder));
    const nested = prefab.root.children.find((child) => child.nested);
    expect(nested?.nodePath).toBe('root/held');
    expect(nested?.transform.position).toEqual({ x: 1, y: 0, z: 0 });
  });

  it('applies a nested override to that instance only', () => {
    const holder = holderWith([
      {
        nodeId: 'root',
        componentId: 'model',
        patches: [{ path: '/model/presetId', op: 'set', value: 'sentinel' }],
      },
    ]);
    const registry = registryOf(lantern, holder);
    const nested = resolveIn(registry, referenceTo(holder)).prefab.root.children.find(
      (child) => child.nested,
    );
    expect(componentOfType(nested?.components ?? [], 'model-renderer')?.model).toEqual({
      kind: 'procedural-humanoid',
      presetId: 'sentinel',
    });

    // The nested Prefab itself is untouched.
    expect(
      componentOfType(resolveIn(registry, referenceTo(lantern)).components, 'model-renderer')
        ?.model,
    ).toEqual({ kind: 'procedural-humanoid', presetId: 'relay' });
  });

  it('refuses a nesting cycle', () => {
    const selfNesting = basePrefab(
      'loop',
      node(
        'root',
        [],
        [
          {
            kind: 'prefab-instance',
            instanceId: 'inner',
            prefab: {
              assetType: 'game-object-prefab',
              assetId: 'loop',
              version: '1.0.0',
              contentHash: 'c'.repeat(64),
            },
            transform: {
              position: { x: 0, y: 0, z: 0 },
              rotation: { x: 0, y: 0, z: 0, w: 1 },
              scale: { x: 1, y: 1, z: 1 },
            },
            overrides: [],
          },
        ],
      ),
    );
    const registry = registryOf(selfNesting);
    const reference = {
      assetType: 'game-object-prefab' as const,
      assetId: 'loop',
      version: '1.0.0',
      contentHash: computeContentHash(selfNesting),
    };
    expect(
      resolveGameObjectPrefab(registry, reference).issues.map((issue) => issue.code),
    ).toContain('nested-prefab-cycle');
  });
});

describe('override addressing', () => {
  it('refuses a patch aimed at a node that does not exist', () => {
    const child = variant('child', [
      {
        kind: 'patch-component',
        nodeId: 'nowhere',
        componentId: 'model',
        patches: [{ path: '/model/presetId', op: 'set', value: 'relay' }],
      },
    ]);
    const registry = registryOf(BASE, child);
    expect(resolveIn(registry, referenceTo(child)).issues.map((issue) => issue.code)).toContain(
      'invalid-override-target',
    );
  });

  it('refuses a patch aimed at a path the component does not have', () => {
    const child = variant('child', [
      {
        kind: 'patch-component',
        nodeId: 'root',
        componentId: 'model',
        patches: [{ path: '/model/nonsense', op: 'set', value: 1 }],
      },
    ]);
    const registry = registryOf(BASE, child);
    expect(resolveIn(registry, referenceTo(child)).issues.map((issue) => issue.code)).toContain(
      'invalid-override-path',
    );
  });

  it('refuses a patch that would change what a component is', () => {
    const child = variant('child', [
      {
        kind: 'patch-component',
        nodeId: 'root',
        componentId: 'model',
        patches: [{ path: '/componentType', op: 'set', value: 'light' }],
      },
    ]);
    const registry = registryOf(BASE, child);
    expect(resolveIn(registry, referenceTo(child)).issues.map((issue) => issue.code)).toContain(
      'invalid-override-path',
    );
  });

  it('refuses a variant parent cycle', () => {
    const a = createPrefabVariant(
      {
        id: 'a',
        displayName: 'a',
        description: '',
        tags: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        createdBy: 'test',
      },
      { assetType: 'game-object-prefab', assetId: 'b', version: '1.0.0', contentHash: 'd'.repeat(64) },
      [],
    );
    const b = createPrefabVariant(
      {
        id: 'b',
        displayName: 'b',
        description: '',
        tags: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        createdBy: 'test',
      },
      { assetType: 'game-object-prefab', assetId: 'a', version: '1.0.0', contentHash: 'e'.repeat(64) },
      [],
    );
    const registry = registryOf(a, b);
    const issues = resolveGameObjectPrefab(registry, {
      assetType: 'game-object-prefab',
      assetId: 'a',
      version: '1.0.0',
      contentHash: computeContentHash(a),
    }).issues;
    expect(issues.map((issue) => issue.code)).toContain('variant-parent-cycle');
  });
});

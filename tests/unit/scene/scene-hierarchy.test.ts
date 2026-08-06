/**
 * The Scene hierarchy rows, and the four identities a selection has to keep
 * apart.
 *
 * Both are pure data questions — "this Scene yields exactly these rows" and
 * "this click yields exactly this operation target" — so neither needs a DOM.
 * The identity half is the one worth stating plainly: the runtime spells a child
 * node `<instanceId>/<nodeId>`, and a viewport click that passed that string to
 * `scene.set_transform` would write an operation naming a GameObject that does
 * not exist (§5.3, §13.5).
 */
import { describe, expect, it } from 'vitest';
import {
  hierarchyRowFor,
  sceneHierarchyRows,
} from '../../../apps/web/src/scene-editor/scene-hierarchy.ts';
import {
  operationTarget,
  selectedInstanceId,
  selectedNodeId,
  selectionForRuntimeNode,
  splitRuntimeNodeId,
} from '../../../apps/web/src/scene-editor/scene-selection.ts';
import { contradictoryScene, loadTestPrefabRegistry } from '../../fixtures/scene.ts';

const registry = loadTestPrefabRegistry();
const rows = () => sceneHierarchyRows({ scene: contradictoryScene(registry), registry });

describe('hierarchy rows come from gameObjects', () => {
  it('has one row per GameObject and none per entity', () => {
    const scene = contradictoryScene(registry);
    const result = sceneHierarchyRows({ scene, registry });
    expect(result.map((row) => row.instanceId)).toEqual(['hero', 'watcher', 'understudy']);
    // The fixture's entities name three completely different things. Any of
    // them appearing here is a fallback to the entity path.
    expect(JSON.stringify(result)).not.toContain('ENTITY-ONLY-DECOY');
  });

  it('preserves declaration order, which is tick and draw order', () => {
    expect(rows().map((row) => row.instanceId)).toEqual(['hero', 'watcher', 'understudy']);
  });
});

describe('a row names the exact Prefab version', () => {
  it('carries id and version, never "latest"', () => {
    const hero = hierarchyRowFor(rows(), 'hero')!;
    expect(hero.prefabId).toBe('quaternius-knight');
    expect(hero.prefabVersion).toBe('1.0.0');
  });

  it('reports the stored derivation mode, not the collapsed one', () => {
    // Resolution's whole job is to flatten a variant's patches into a finished
    // composition, so the resolved document says nothing about provenance.
    expect(hierarchyRowFor(rows(), 'hero')!.derivation).toBe('variant');
  });
});

describe('badges come from resolved Components', () => {
  it('lists the Component types the composition actually has', () => {
    const hero = hierarchyRowFor(rows(), 'hero')!;
    expect(hero.componentTypes).toContain('model-renderer');
    expect(hero.componentTypes).toContain('animator');
    expect(hero.componentTypes).toContain('character-motor');
  });

  it('gives a camera Prefab a camera badge and no motor badge', () => {
    const watcher = hierarchyRowFor(rows(), 'watcher')!;
    expect(watcher.componentTypes).toContain('camera');
    expect(watcher.componentTypes).not.toContain('character-motor');
  });

  it('marks the active camera and the relation it holds', () => {
    const watcher = hierarchyRowFor(rows(), 'watcher')!;
    expect(watcher.activeCamera).toBe(true);
    expect(watcher.relationBadge).toContain('hero');
  });

  it('reports no override badge on an instance that overrides nothing', () => {
    expect(hierarchyRowFor(rows(), 'hero')!.overrideCount).toBe(0);
  });

  it('marks the overridden Component in the expanded view', () => {
    const scene = contradictoryScene(registry);
    const withOverride = {
      ...scene,
      gameObjects: (scene.gameObjects ?? []).map((gameObject) =>
        gameObject.id === 'hero'
          ? {
              ...gameObject,
              componentOverrides: [
                {
                  nodeId: 'root',
                  componentId: 'model',
                  patches: [{ path: '/castShadow', op: 'set' as const, value: false }],
                },
              ],
            }
          : gameObject,
      ),
    };
    const hero = hierarchyRowFor(
      sceneHierarchyRows({ scene: withOverride, registry }),
      'hero',
    )!;
    expect(hero.overrideCount).toBe(1);
    expect(
      hero.nodes.some((node) =>
        node.components.some((component) => component.componentId === 'model' && component.overridden),
      ),
    ).toBe(true);
  });
});

describe('expanding a row shows the resolved Prefab graph', () => {
  it('lists nodes with their stable ids and Components', () => {
    const hero = hierarchyRowFor(rows(), 'hero')!;
    expect(hero.nodes.length).toBeGreaterThan(0);
    const root = hero.nodes[0]!;
    expect(root.nodeId).toBe('root');
    expect(root.components.map((component) => component.componentType)).toContain('animator');
  });

  it('names the runtime id the renderer draws each node under', () => {
    const hero = hierarchyRowFor(rows(), 'hero')!;
    // The root node *is* the instance; a child is spelled with a slash.
    expect(hero.nodes[0]!.runtimeId).toBe('hero');
    for (const node of hero.nodes.slice(1)) {
      expect(node.runtimeId).toBe(`hero/${node.nodeId}`);
    }
  });

  it('says which Prefab version contributed each node', () => {
    for (const node of hierarchyRowFor(rows(), 'hero')!.nodes) {
      expect(node.sourcePrefabId).toBeTruthy();
      expect(node.sourcePrefabVersion).toBe('1.0.0');
    }
  });
});

describe('an unresolvable instance still gets a row', () => {
  it('reports the failure rather than vanishing', () => {
    const scene = contradictoryScene(registry);
    const broken = {
      ...scene,
      gameObjects: [
        {
          ...scene.gameObjects![0]!,
          prefab: {
            assetType: 'game-object-prefab' as const,
            assetId: 'no-such-prefab',
            version: '1.0.0',
            contentHash: 'f'.repeat(64),
          },
        },
      ],
    };
    const row = sceneHierarchyRows({ scene: broken, registry })[0]!;
    // A row that disappeared would make a broken Scene look like an empty one.
    expect(row.unresolved).toBe(true);
    expect(row.unresolvedReason).toBeTruthy();
    expect(row.nodes).toEqual([]);
  });
});

describe('selection keeps four identities apart', () => {
  it('splits a runtime node id into its instance and node halves', () => {
    expect(splitRuntimeNodeId('hero')).toEqual({ instanceId: 'hero', nodeId: undefined });
    expect(splitRuntimeNodeId('hero/lantern')).toEqual({
      instanceId: 'hero',
      nodeId: 'lantern',
    });
    // A nested Prefab's node path may itself contain slashes; only the first
    // one separates the instance from the path inside it.
    expect(splitRuntimeNodeId('hero/arm/lantern')).toEqual({
      instanceId: 'hero',
      nodeId: 'arm/lantern',
    });
  });

  it('selects a child node for inspection and the root for operations', () => {
    const selection = selectionForRuntimeNode('scene-a', 'hero/lantern');
    expect(selectedInstanceId(selection)).toBe('hero');
    expect(selectedNodeId(selection)).toBe('lantern');
    // The one that matters: a persistent operation never names the runtime path.
    expect(operationTarget(selection)).toBe('hero');
  });

  it('never produces an operation target containing a slash', () => {
    for (const row of rows()) {
      for (const node of row.nodes) {
        const target = operationTarget(selectionForRuntimeNode('scene-a', node.runtimeId));
        expect(target).not.toContain('/');
        expect(target).toBe(row.instanceId);
      }
    }
  });

  it('has no operation target at all when the Scene root is selected', () => {
    expect(operationTarget({ kind: 'scene', sceneId: 'scene-a' })).toBeNull();
    expect(selectedNodeId({ kind: 'scene', sceneId: 'scene-a' })).toBeNull();
  });
});

describe('the resolved Component carries both layers', () => {
  /*
   * The Inspector edits the *instance* layer, so a row that showed only the
   * Prefab layer would give it a control whose displayed value is not the value
   * it edits — uncheck the box, the document changes, and the box snaps back.
   */
  it('shows the instance override, not the shared Prefab value', () => {
    const scene = contradictoryScene(registry);
    const base = hierarchyRowFor(sceneHierarchyRows({ scene, registry }), 'hero')!;
    const beforeModel = base.nodes[0]!.components.find(
      (component) => component.componentType === 'model-renderer',
    )!;
    expect((beforeModel.definition as { castShadow?: boolean }).castShadow).toBe(true);

    const overridden = {
      ...scene,
      gameObjects: (scene.gameObjects ?? []).map((gameObject) =>
        gameObject.id === 'hero'
          ? {
              ...gameObject,
              componentOverrides: [
                {
                  nodeId: 'root',
                  componentId: 'model',
                  patches: [{ path: '/castShadow', op: 'set' as const, value: false }],
                },
              ],
            }
          : gameObject,
      ),
    };
    const after = hierarchyRowFor(sceneHierarchyRows({ scene: overridden, registry }), 'hero')!;
    const afterModel = after.nodes[0]!.components.find(
      (component) => component.componentType === 'model-renderer',
    )!;
    expect((afterModel.definition as { castShadow?: boolean }).castShadow).toBe(false);
  });

  it('leaves a Component the instance did not override at its Prefab value', () => {
    const scene = contradictoryScene(registry);
    const overridden = {
      ...scene,
      gameObjects: (scene.gameObjects ?? []).map((gameObject) =>
        gameObject.id === 'hero'
          ? {
              ...gameObject,
              componentOverrides: [
                {
                  nodeId: 'root',
                  componentId: 'model',
                  patches: [{ path: '/castShadow', op: 'set' as const, value: false }],
                },
              ],
            }
          : gameObject,
      ),
    };
    const row = hierarchyRowFor(sceneHierarchyRows({ scene: overridden, registry }), 'hero')!;
    const animator = row.nodes[0]!.components.find(
      (component) => component.componentType === 'animator',
    )!;
    expect(animator.overridden).toBe(false);
    expect(animator.definition.componentType).toBe('animator');
  });

  it('does not leak one instance\'s override into another standing on the same Prefab', () => {
    const scene = contradictoryScene(registry);
    const overridden = {
      ...scene,
      gameObjects: (scene.gameObjects ?? []).map((gameObject) =>
        gameObject.id === 'hero'
          ? {
              ...gameObject,
              componentOverrides: [
                {
                  nodeId: 'root',
                  componentId: 'model',
                  patches: [{ path: '/castShadow', op: 'set' as const, value: false }],
                },
              ],
            }
          : gameObject,
      ),
    };
    const rows = sceneHierarchyRows({ scene: overridden, registry });
    // `understudy` stands on the same Prefab version and overrode nothing.
    const understudy = hierarchyRowFor(rows, 'understudy')!;
    const model = understudy.nodes[0]!.components.find(
      (component) => component.componentType === 'model-renderer',
    )!;
    expect((model.definition as { castShadow?: boolean }).castShadow).toBe(true);
  });
});

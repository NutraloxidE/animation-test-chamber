/**
 * Runtime transform hierarchy and the component step contract (§16.1, §16.2).
 *
 * Both were latent bugs rather than visible ones, which is why they get tests
 * of their own rather than a line in an existing suite. Every migrated Prefab is
 * a single node, so nothing in the repository composed a child transform; and no
 * built-in component integrates against time, so nothing noticed that the
 * "deltaSeconds" it received was actually the tick index.
 *
 * The parent-follow assertions are the load-bearing ones. A child composed once
 * at construction passes every static check and then stays behind the moment the
 * parent moves — which looks like a rendering bug months later.
 */
import { describe, expect, it } from 'vitest';
import type { TransformDefinition } from '@atc/schema';
import { composeTransforms } from '@atc/prefab-runtime';
import {
  ComponentRuntimeRegistry,
  defaultComponentRuntimeRegistry,
  instantiateGameObject,
  resolveGameObjectInstance,
  type ComponentRuntimeFactory,
  type GameObjectRuntimeServices,
  type RuntimeComponent,
  type RuntimeComponentStepContext,
} from '@atc/game-object-runtime';
import { loadAssetRegistry, loadCanonicalProject } from '../../../harness/animation-assets.ts';
import { loadPrefabRegistry } from '../../../harness/prefabs.ts';
import {
  basePrefab,
  modelComponent,
  node,
  referenceTo,
  registryOf,
} from '../prefabs/fixtures.ts';

const project = loadCanonicalProject();

function transform(
  position: [number, number, number],
  rotation: [number, number, number, number] = [0, 0, 0, 1],
  scale: [number, number, number] = [1, 1, 1],
): TransformDefinition {
  return {
    position: { x: position[0], y: position[1], z: position[2] },
    rotation: { x: rotation[0], y: rotation[1], z: rotation[2], w: rotation[3] },
    scale: { x: scale[0], y: scale[1], z: scale[2] },
  };
}

/** A quarter turn about Y, as a unit quaternion. */
const QUARTER_TURN_Y = transform([0, 0, 0], [0, Math.SQRT1_2, 0, Math.SQRT1_2]).rotation;

function services(overrides: Partial<GameObjectRuntimeServices> = {}): GameObjectRuntimeServices {
  return {
    animationRegistry: loadAssetRegistry(),
    prefabRegistry: loadPrefabRegistry(),
    clock: { fixedDeltaSeconds: 1 / 60 },
    ...overrides,
  };
}

/**
 * A two-level Prefab: a root with an authored child offset.
 *
 * Neither node carries a motor, so nothing here is world-authoritative and
 * every transform is pure composition — which is what these tests are about.
 */
function mountPrefab(childLocal: TransformDefinition, rootLocal = transform([0, 0, 0])) {
  return basePrefab(
    'mount',
    {
      ...node('root', [modelComponent('relay')]),
      transform: rootLocal,
      children: [
        {
          kind: 'inline',
          node: { ...node('lantern', [modelComponent('navigator')]), transform: childLocal },
        },
      ],
    },
  );
}

function instantiate(
  prefab: ReturnType<typeof basePrefab>,
  instanceTransform: TransformDefinition,
  componentRuntimes?: ComponentRuntimeRegistry,
) {
  const prefabRegistry = registryOf(prefab);
  const resolved = resolveGameObjectInstance({
    prefabRegistry,
    instance: {
      schemaVersion: 2,
      id: 'placed',
      displayName: 'placed',
      enabled: true,
      prefab: referenceTo(prefab),
      transform: instanceTransform,
      componentOverrides: [],
      bindings: {},
      relations: {},
    },
  });
  expect(resolved.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
  return instantiateGameObject({
    definition: resolved.definition,
    services: services({ prefabRegistry }),
    project,
    ...(componentRuntimes ? { componentRuntimes } : {}),
  });
}

describe('composeTransforms', () => {
  it('composes position through the parent rotation and scale', () => {
    const parent = transform([1, 0, 0], [0, Math.SQRT1_2, 0, Math.SQRT1_2], [2, 2, 2]);
    const composed = composeTransforms(parent, transform([1, 0, 0]));
    // A quarter turn about +Y sends +X to -Z; the parent scale doubles the offset.
    expect(composed.position.x).toBeCloseTo(1, 9);
    expect(composed.position.z).toBeCloseTo(-2, 9);
  });

  it('multiplies scale', () => {
    const composed = composeTransforms(
      transform([0, 0, 0], [0, 0, 0, 1], [2, 3, 4]),
      transform([0, 0, 0], [0, 0, 0, 1], [5, 5, 5]),
    );
    expect(composed.scale).toEqual({ x: 10, y: 15, z: 20 });
  });

  it('multiplies rotation rather than reducing it to yaw', () => {
    const tilted = transform([0, 0, 0], [Math.SQRT1_2, 0, 0, Math.SQRT1_2]);
    const composed = composeTransforms(tilted, transform([0, 0, 0]));
    expect(composed.rotation.x).toBeCloseTo(Math.SQRT1_2, 9);
  });

  it('mutates neither input', () => {
    const parent = transform([1, 2, 3], [0, 1, 0, 0], [2, 2, 2]);
    const child = transform([4, 5, 6]);
    const parentBefore = JSON.stringify(parent);
    const childBefore = JSON.stringify(child);
    composeTransforms(parent, child);
    expect(JSON.stringify(parent)).toBe(parentBefore);
    expect(JSON.stringify(child)).toBe(childBefore);
  });
});

describe('child node transforms', () => {
  it('applies the authored child offset on top of the Scene placement', () => {
    const runtime = instantiate(mountPrefab(transform([0, 1.5, 0])), transform([10, 0, 0]));
    const child = runtime.children[0]!;
    expect(runtime.worldTransform.position).toEqual({ x: 10, y: 0, z: 0 });
    expect(child.worldTransform.position).toEqual({ x: 10, y: 1.5, z: 0 });
    runtime.dispose();
  });

  it('composes the Prefab root transform as well as the instance transform', () => {
    const runtime = instantiate(
      mountPrefab(transform([0, 1, 0]), transform([0, 0, 5])),
      transform([10, 0, 0]),
    );
    // instance (10,0,0) × prefab root (0,0,5) × child (0,1,0)
    expect(runtime.worldTransform.position).toEqual({ x: 10, y: 0, z: 5 });
    expect(runtime.children[0]!.worldTransform.position).toEqual({ x: 10, y: 1, z: 5 });
    runtime.dispose();
  });

  it('carries the child when the parent moves', () => {
    const runtime = instantiate(mountPrefab(transform([0, 1.5, 0])), transform([0, 0, 0]));
    const child = runtime.children[0]!;
    expect(child.worldTransform.position).toEqual({ x: 0, y: 1.5, z: 0 });

    runtime.setLocalTransform(transform([4, 0, -2]));

    expect(child.worldTransform.position).toEqual({ x: 4, y: 1.5, z: -2 });
    runtime.dispose();
  });

  it('carries the child when the parent rotates', () => {
    const runtime = instantiate(mountPrefab(transform([1, 0, 0])), transform([0, 0, 0]));
    const child = runtime.children[0]!;
    expect(child.worldTransform.position.x).toBeCloseTo(1, 9);

    runtime.setLocalTransform({ ...transform([0, 0, 0]), rotation: QUARTER_TURN_Y });

    // The child's +X offset has swung to -Z.
    expect(child.worldTransform.position.x).toBeCloseTo(0, 9);
    expect(child.worldTransform.position.z).toBeCloseTo(-1, 9);
    runtime.dispose();
  });

  it('composes scale down the hierarchy', () => {
    const runtime = instantiate(
      mountPrefab(transform([2, 0, 0], [0, 0, 0, 1], [0.5, 0.5, 0.5])),
      transform([0, 0, 0], [0, 0, 0, 1], [3, 3, 3]),
    );
    const child = runtime.children[0]!;
    expect(child.worldTransform.scale).toEqual({ x: 1.5, y: 1.5, z: 1.5 });
    // The offset is scaled by the parent too.
    expect(child.worldTransform.position.x).toBeCloseTo(6, 9);
    runtime.dispose();
  });

  it('leaves the resolved definition unmutated when the runtime moves', () => {
    const prefab = mountPrefab(transform([0, 1.5, 0]));
    const runtime = instantiate(prefab, transform([0, 0, 0]));
    const authored = JSON.stringify(runtime.definition.root.children[0]!.transform);
    runtime.setLocalTransform(transform([9, 9, 9]));
    expect(JSON.stringify(runtime.definition.root.children[0]!.transform)).toBe(authored);
    runtime.dispose();
  });
});

describe('nested Prefab transforms', () => {
  const inner = basePrefab('inner', {
    ...node('root', [modelComponent('sentinel')]),
    transform: transform([0, 0.5, 0]),
  });

  const outer = basePrefab('outer', {
    ...node('root', [modelComponent('relay')]),
    children: [
      {
        kind: 'prefab-instance',
        instanceId: 'held',
        prefab: referenceTo(inner),
        transform: transform([1, 0, 0]),
        overrides: [],
      },
    ],
  });

  it('composes instance × nested-instance × nested-root', () => {
    const prefabRegistry = registryOf(inner, outer);
    const resolved = resolveGameObjectInstance({
      prefabRegistry,
      instance: {
        schemaVersion: 2,
        id: 'placed',
        displayName: 'placed',
        enabled: true,
        prefab: referenceTo(outer),
        transform: transform([10, 0, 0]),
        componentOverrides: [],
        bindings: {},
        relations: {},
      },
    });
    const runtime = instantiateGameObject({
      definition: resolved.definition,
      services: services({ prefabRegistry }),
      project,
    });

    // Resolution already composed the nested instance transform with the
    // nested root's own, so the child's *local* transform is (1, 0.5, 0).
    const nested = runtime.children[0]!;
    expect(nested.localTransform.position).toEqual({ x: 1, y: 0.5, z: 0 });
    // The Scene placement then carries it.
    expect(nested.worldTransform.position).toEqual({ x: 11, y: 0.5, z: 0 });
    runtime.dispose();
  });
});

/** Records exactly what the runtime tells it about time. */
class ClockProbe implements RuntimeComponent {
  readonly componentType = 'tags';
  readonly componentId = 'tags';
  enabled = true;
  readonly seen: RuntimeComponentStepContext[] = [];

  step(context: RuntimeComponentStepContext): void {
    this.seen.push({ ...context });
  }
}

describe('component step contract', () => {
  function probeRuntime(fixedDeltaSeconds: number) {
    const probe = new ClockProbe();
    const registry = defaultComponentRuntimeRegistry();
    registry.register({
      componentType: 'tags',
      create: () => probe,
    } as ComponentRuntimeFactory);

    const prefab = basePrefab('probed', {
      ...node('root', [
        modelComponent('relay'),
        {
          schemaVersion: 1,
          componentId: 'tags',
          componentType: 'tags',
          enabled: true,
          tags: ['probe'],
        },
      ]),
    });
    const prefabRegistry = registryOf(prefab);
    const resolved = resolveGameObjectInstance({
      prefabRegistry,
      instance: {
        schemaVersion: 2,
        id: 'probed',
        displayName: 'probed',
        enabled: true,
        prefab: referenceTo(prefab),
        transform: transform([0, 0, 0]),
        componentOverrides: [],
        bindings: {},
        relations: {},
      },
    });
    const runtime = instantiateGameObject({
      definition: resolved.definition,
      services: services({ prefabRegistry, clock: { fixedDeltaSeconds } }),
      project,
      componentRuntimes: registry,
    });
    return { runtime, probe };
  }

  it('passes the exact simulation tick', () => {
    const { runtime, probe } = probeRuntime(1 / 60);
    for (const tick of [0, 1, 2, 7]) runtime.step({ tick, cameraYawRad: 0 });
    expect(probe.seen.map((entry) => entry.tick)).toEqual([0, 1, 2, 7]);
    runtime.dispose();
  });

  it('passes fixedDeltaSeconds from the clock, not the tick', () => {
    const { runtime, probe } = probeRuntime(1 / 60);
    runtime.step({ tick: 42, cameraYawRad: 0 });
    expect(probe.seen[0]!.deltaSeconds).toBeCloseTo(1 / 60, 12);
    expect(probe.seen[0]!.deltaSeconds).not.toBe(probe.seen[0]!.tick);
    runtime.dispose();
  });

  it('accumulates to exactly one second over sixty steps at 1/60', () => {
    const { runtime, probe } = probeRuntime(1 / 60);
    for (let tick = 0; tick < 60; tick += 1) runtime.step({ tick, cameraYawRad: 0 });
    const total = probe.seen.reduce((sum, entry) => sum + entry.deltaSeconds, 0);
    expect(total).toBeCloseTo(1, 12);
    runtime.dispose();
  });

  it('honours a different clock', () => {
    const { runtime, probe } = probeRuntime(1 / 30);
    runtime.step({ tick: 0, cameraYawRad: 0 });
    expect(probe.seen[0]!.deltaSeconds).toBeCloseTo(1 / 30, 12);
    runtime.dispose();
  });
});

/**
 * The Prefab Editor's viewport.
 *
 * One GameObject, instantiated from the Prefab under edit and drawn through the
 * *production* renderer. Deliberately not a second drawing path: a preview that
 * rendered the composition its own way could show a lantern the Scene will not,
 * and the disagreement would only surface after placement.
 *
 * The instance is synthetic — `preview/<prefabId>` — and exists only in this
 * component's memory. Nothing here writes a Scene: opening a Prefab must not
 * place one.
 */
import { useEffect, useMemo, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { Grid, OrbitControls } from '@react-three/drei';
import type { GameObjectPrefabReference, TransformDefinition } from '@atc/schema';
import {
  instantiateGameObject,
  resolveGameObjectInstance,
  type RuntimeGameObject,
} from '@atc/game-object-runtime';
import { useChamber } from '../store.ts';
import { browserPrefabRegistry } from '../game-objects/prefab-registry.ts';
import { GameObjectRenderer } from '../game-objects/GameObjectRenderer.tsx';
import { projectGameObject } from '../game-objects/render-projection.ts';

const ORIGIN: TransformDefinition = {
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
  scale: { x: 1, y: 1, z: 1 },
};

export function PrefabViewport({
  reference,
}: {
  reference: GameObjectPrefabReference;
}): JSX.Element {
  const project = useChamber((state) => state.canonicalProject);
  const animationRegistry = useChamber((state) => state.registry);
  const [runtime, setRuntime] = useState<RuntimeGameObject | null>(null);

  const registry = browserPrefabRegistry();
  const resolved = useMemo(
    () =>
      resolveGameObjectInstance({
        prefabRegistry: registry,
        instance: {
          schemaVersion: 2,
          id: `preview/${reference.assetId}`,
          displayName: reference.assetId,
          enabled: true,
          prefab: reference,
          transform: ORIGIN,
          componentOverrides: [],
          bindings: {},
          relations: {},
        },
      }),
    [registry, reference.assetId, reference.version, reference.contentHash],
  );

  useEffect(() => {
    // An abstract Prefab has no placement, so there is nothing to instantiate;
    // the panel says so rather than inventing an instance of it.
    if (resolved.issues.some((issue) => issue.severity === 'error')) {
      setRuntime(null);
      return;
    }
    const instance = instantiateGameObject({
      definition: resolved.definition,
      project,
      services: {
        animationRegistry,
        prefabRegistry: registry,
        clock: { fixedDeltaSeconds: 1 / 60 },
      },
    });
    setRuntime(instance);
    return () => instance.dispose();
  }, [resolved, project, animationRegistry, registry]);

  const projection = runtime ? projectGameObject(runtime) : undefined;

  return (
    <div className="prefab-viewport" data-testid="prefab-viewport">
      {!runtime ? (
        <p data-testid="prefab-viewport-unavailable">
          {resolved.issues.find((issue) => issue.severity === 'error')?.message ??
            'This Prefab cannot be placed.'}
        </p>
      ) : (
        <Canvas camera={{ fov: 55, position: [3, 2.5, 4], near: 0.1, far: 200 }}>
          <ambientLight intensity={0.6} />
          <directionalLight position={[5, 8, 4]} intensity={1.1} />
          <Grid args={[20, 20]} cellColor="#2a2f3a" sectionColor="#3d4657" infiniteGrid />
          {projection && <GameObjectRenderer projection={projection} />}
          <OrbitControls makeDefault target={[0, 1, 0]} />
        </Canvas>
      )}
    </div>
  );
}

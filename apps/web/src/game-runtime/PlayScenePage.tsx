import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrthographicCamera, PerspectiveCamera } from '@react-three/drei';
import { useParams } from 'react-router-dom';
import { FixedStepAccumulator } from '@atc/runtime-core';
import { instantiateScene, type RuntimeScene } from '@atc/game-object-runtime';
import { gameplayScriptRegistry } from '@atc/gameplay';
import { TERRAIN_PRESETS } from '@atc/terrain-runtime';
import { routeId } from '../app/routes.ts';
import { useChamber } from '../store.ts';
import { browserPrefabRegistry } from '../game-objects/prefab-registry.ts';
import { GameObjectRenderer } from '../game-objects/GameObjectRenderer.tsx';
import { projectRuntimeScene, type SceneRenderProjection } from '../game-objects/render-projection.ts';

function PlayClock({ runtime, onFrame }: { runtime: RuntimeScene; onFrame: () => void }) {
  const accumulator = useRef(new FixedStepAccumulator());
  useFrame((_, delta) => {
    const steps = accumulator.current.advance(delta);
    for (let index = 0; index < steps; index += 1) runtime.step({ cameraYawRad: 0 });
    if (steps) onFrame();
  });
  return null;
}

function AuthoredCamera({ projection }: { projection: SceneRenderProjection }) {
  const node = projection.activeCamera;
  if (!node?.camera) return null;
  const transform = node.worldTransform;
  const common = { makeDefault: true, position: [transform.position.x, transform.position.y, transform.position.z] as [number, number, number], quaternion: [transform.rotation.x, transform.rotation.y, transform.rotation.z, transform.rotation.w] as [number, number, number, number], near: 0.01, far: 2000 };
  return node.camera.projection === 'orthographic'
    ? <OrthographicCamera {...common} zoom={1 / (node.camera.orthographicSize ?? 10)} />
    : <PerspectiveCamera {...common} fov={node.camera.fieldOfViewDeg ?? 60} />;
}

function PlayCanvas({ runtime, sceneId, activeCameraGameObjectId }: { runtime: RuntimeScene; sceneId: string; activeCameraGameObjectId?: string }) {
  const [frame, setFrame] = useState(0);
  const projection = useMemo(() => projectRuntimeScene(runtime, activeCameraGameObjectId), [runtime, activeCameraGameObjectId, frame]);
  if (!projection.activeCamera) return <p data-testid="play-camera-unavailable">Scene “{sceneId}” has no valid authored active Camera.</p>;
  return (
    <Canvas data-testid="play-canvas">
      <AuthoredCamera projection={projection} />
      <PlayClock runtime={runtime} onFrame={() => setFrame((value) => value + 1)} />
      <ambientLight intensity={0.5} />
      <GameObjectRenderer projection={projection} />
    </Canvas>
  );
}

export function PlayScenePage(): JSX.Element {
  const requestedId = routeId(useParams().sceneId);
  const project = useChamber((state) => state.project);
  const animationRegistry = useChamber((state) => state.registry);
  const sceneId = requestedId ?? project.activeSceneId;
  const scene = project.scenes.find((candidate) => candidate.id === sceneId);
  const terrain = TERRAIN_PRESETS.find((candidate) => candidate.id === project.defaultTerrainPresetId) ?? TERRAIN_PRESETS[0];
  const [runtime, setRuntime] = useState<RuntimeScene | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!scene) { setError(`Scene “${sceneId ?? ''}” is unavailable.`); setRuntime(null); return; }
    try {
      const next = instantiateScene({ scene, project, ...(terrain ? { terrain } : {}), services: { animationRegistry, prefabRegistry: browserPrefabRegistry(), gameplayRegistry: gameplayScriptRegistry, clock: { fixedDeltaSeconds: 1 / 60 }, ...(terrain ? { terrain } : {}) } });
      setRuntime(next); setError(null);
      return () => next.dispose();
    } catch (failure) { setRuntime(null); setError(failure instanceof Error ? failure.message : String(failure)); }
  }, [scene, sceneId, project, animationRegistry, terrain]);

  if (!scene || error) return <main className="play-surface play-surface--error" data-testid="play-surface"><p>{error ?? `Scene “${sceneId ?? ''}” is unavailable.`}</p></main>;
  return (
    <main className="play-surface" data-testid="play-surface" data-scene-id={scene.id}>
      {runtime && <PlayCanvas runtime={runtime} sceneId={scene.id} activeCameraGameObjectId={scene.activeCameraGameObjectId} />}
      <section className="game-overlay" data-testid="game-overlay" aria-live="polite"><span>{scene.displayName}</span></section>
    </main>
  );
}

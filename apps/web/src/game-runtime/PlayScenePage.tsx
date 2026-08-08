import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrthographicCamera, PerspectiveCamera } from '@react-three/drei';
import { useParams } from 'react-router-dom';
import type { PrefabComponentOverride, SceneDefinition } from '@atc/schema';
import { FixedStepAccumulator } from '@atc/runtime-core';
import { BrowserInputSampler } from '@atc/input-runtime';
import { instantiateScene, type RuntimeScene } from '@atc/game-object-runtime';
import {
  resolveGameObjectPrefab,
  resolvedComponents,
  type PrefabAssetRegistry,
} from '@atc/prefab-runtime';
import { gameplayScriptRegistry } from '@atc/gameplay';
import { TERRAIN_PRESETS } from '@atc/terrain-runtime';
import { routeId } from '../app/routes.ts';
import { useChamber } from '../store.ts';
import { browserPrefabRegistry } from '../game-objects/prefab-registry.ts';
import { GameObjectRenderer } from '../game-objects/GameObjectRenderer.tsx';
import { projectRuntimeScene, type SceneRenderProjection } from '../game-objects/render-projection.ts';
import { GameOverlay } from '../game-ui/GameOverlay.tsx';
import { isPlayTestDriven, registerPlayRuntime } from '../test-driver.ts';

const TWO_HUMANOIDS_SCENE_ID = 'two-humanoids-shared-animation';
const GAMEPLAY_NAVIGATOR_PREFAB_ID = 'gameplay-navigator';
const QUATERNIUS_PREFAB_ID = 'quaternius-universal-base';
const QUATERNIUS_PREFAB_VERSION = '1.0.0';

/**
 * The Two Humanoids play demo keeps Gameplay Navigator's scripts and controller
 * bindings, but borrows the authored visual + Animator assignment from the
 * Quaternius prefab. This is deliberately a Scene-instance override: Character
 * motion still belongs to the same CharacterMotor and Gameplay Scripts, while
 * the thing the player sees is the exact repository model/rig/motion-set edited
 * at /edit/prefab/quaternius-universal-base/animation/root/animator.
 */
function preparePlayScene(scene: SceneDefinition, prefabRegistry: PrefabAssetRegistry): SceneDefinition {
  if (scene.id !== TWO_HUMANOIDS_SCENE_ID || !scene.gameObjects) return scene;
  if (!scene.gameObjects.some((object) => object.prefab.assetId === GAMEPLAY_NAVIGATOR_PREFAB_ID)) return scene;

  const quaterniusReference = prefabRegistry.referenceTo(QUATERNIUS_PREFAB_ID, QUATERNIUS_PREFAB_VERSION);
  const quaternius = resolveGameObjectPrefab(prefabRegistry, quaterniusReference);
  const errors = quaternius.issues.filter((issue) => issue.severity === 'error');
  if (errors.length > 0) {
    throw new Error(
      `cannot use ${QUATERNIUS_PREFAB_ID} in play mode:\n${errors.map((issue) => `  - [${issue.code}] ${issue.message}`).join('\n')}`,
    );
  }

  const components = resolvedComponents(quaternius.prefab.root);
  const model = components.find((component) => component.componentType === 'model-renderer');
  const animator = components.find((component) => component.componentType === 'animator');
  if (!model || !animator) {
    throw new Error(`${QUATERNIUS_PREFAB_ID} must resolve a model-renderer and animator`);
  }

  const visualOverrides: PrefabComponentOverride[] = [
    {
      nodeId: 'root',
      componentId: 'model',
      patches: [{ path: '/model', op: 'set', value: structuredClone(model.model) }],
    },
    {
      nodeId: 'root',
      componentId: 'animator',
      patches: [{ path: '/assignment', op: 'set', value: structuredClone(animator.assignment) }],
    },
  ];

  return {
    ...scene,
    gameObjects: scene.gameObjects.map((object) => {
      if (object.prefab.assetId !== GAMEPLAY_NAVIGATOR_PREFAB_ID) return object;
      const retainedOverrides = object.componentOverrides.filter(
        (override) =>
          !(
            override.nodeId === 'root' &&
            (override.componentId === 'model' || override.componentId === 'animator')
          ),
      );
      return {
        ...object,
        componentOverrides: [...retainedOverrides, ...structuredClone(visualOverrides)],
      };
    }),
  };
}

function PlayClock({ runtime, sampler, onFrame }: { runtime: RuntimeScene; sampler: BrowserInputSampler; onFrame: () => void }) {
  const accumulator = useRef(new FixedStepAccumulator());
  const { camera } = useThree();
  useFrame((_, delta) => {
    if (isPlayTestDriven()) return;
    const steps = accumulator.current.advance(delta);
    if (!steps) return;
    runtime.injectHumanIntent(0, sampler.sample());
    const { x, y, z, w } = camera.quaternion;
    const cameraYawRad = Math.atan2(2 * (w * y + x * z), 1 - 2 * (y * y + z * z));
    for (let index = 0; index < steps; index += 1) runtime.step({ cameraYawRad });
    onFrame();
  }, -1);
  return null;
}

/**
 * Camera following is presentation only. The authored relation selects the
 * target; the host preserves the authored camera-to-target offset and translates
 * the Three camera after Simulation has stepped. No camera state enters the
 * canonical Scene or Character simulation.
 */
function CameraFollow({ runtime }: { runtime: RuntimeScene }) {
  const { camera } = useThree();
  const follow = useMemo(() => {
    const authoredCamera = runtime.activeCamera;
    const targetId = authoredCamera?.definition.relations.cameraTargetGameObjectId;
    const target = targetId ? runtime.get(targetId) : undefined;
    if (!authoredCamera || !targetId || !target) return null;
    const cameraPosition = authoredCamera.worldTransform.position;
    const targetPosition = target.worldTransform.position;
    return {
      targetId,
      offset: {
        x: cameraPosition.x - targetPosition.x,
        y: cameraPosition.y - targetPosition.y,
        z: cameraPosition.z - targetPosition.z,
      },
    };
  }, [runtime]);

  useFrame(() => {
    if (!follow) return;
    const target = runtime.get(follow.targetId);
    if (!target) return;
    const position = target.worldTransform.position;
    camera.position.set(
      position.x + follow.offset.x,
      position.y + follow.offset.y,
      position.z + follow.offset.z,
    );
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

function PlayCanvas({ runtime, sampler, sceneId, activeCameraGameObjectId }: { runtime: RuntimeScene; sampler: BrowserInputSampler; sceneId: string; activeCameraGameObjectId?: string }) {
  const [frame, setFrame] = useState(0);
  const projection = useMemo(() => projectRuntimeScene(runtime, activeCameraGameObjectId), [runtime, activeCameraGameObjectId, frame]);
  if (!projection.activeCamera) return <p data-testid="play-camera-unavailable">Scene “{sceneId}” has no valid authored active Camera.</p>;
  return (
    <Canvas data-testid="play-canvas">
      <AuthoredCamera projection={projection} />
      <PlayClock runtime={runtime} sampler={sampler} onFrame={() => setFrame((value) => value + 1)} />
      <CameraFollow runtime={runtime} />
      <ambientLight intensity={0.5} />
      <GameObjectRenderer projection={projection} />
    </Canvas>
  );
}

export function PlayScenePage(): JSX.Element {
  const requestedId = routeId(useParams().sceneId);
  const project = useChamber((state) => state.canonicalProject);
  const animationRegistry = useChamber((state) => state.registry);
  const implicitSceneId = project.scenes.some((candidate) => candidate.id === project.activeSceneId) ? project.activeSceneId : project.scenes[0]?.id;
  const sceneId = requestedId ?? implicitSceneId;
  const scene = project.scenes.find((candidate) => candidate.id === sceneId);
  const terrain = TERRAIN_PRESETS.find((candidate) => candidate.id === project.defaultTerrainPresetId) ?? TERRAIN_PRESETS[0];
  const [runtime, setRuntime] = useState<RuntimeScene | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sampler = useMemo(() => new BrowserInputSampler(project.inputMap), [project.inputMap]);

  useEffect(() => { sampler.attach(); return () => sampler.detach(); }, [sampler]);

  useEffect(() => {
    if (!scene) { setError(requestedId ? `Scene “${requestedId}” is unavailable.` : 'No playable Scene is available.'); setRuntime(null); return; }
    try {
      const prefabRegistry = browserPrefabRegistry();
      const playScene = preparePlayScene(scene, prefabRegistry);
      const next = instantiateScene({ scene: playScene, project, ...(terrain ? { terrain } : {}), services: { animationRegistry, prefabRegistry, gameplayRegistry: gameplayScriptRegistry, clock: { fixedDeltaSeconds: 1 / 60 }, ...(terrain ? { terrain } : {}) } });
      setRuntime(next); setError(null);
      const unregister = registerPlayRuntime(next);
      return () => { unregister(); next.dispose(); };
    } catch (failure) { setRuntime(null); setError(failure instanceof Error ? failure.message : String(failure)); }
  }, [scene, requestedId, project, animationRegistry, terrain]);

  if (!scene || error) return <main className="play-surface play-surface--error" data-testid="play-surface"><p>{error ?? `Scene “${sceneId ?? ''}” is unavailable.`}</p></main>;
  return (
    <main className="play-surface" data-testid="play-surface" data-scene-id={scene.id}>
      {runtime && <PlayCanvas runtime={runtime} sampler={sampler} sceneId={scene.id} activeCameraGameObjectId={scene.activeCameraGameObjectId} />}
      <GameOverlay sceneName={scene.displayName} />
    </main>
  );
}

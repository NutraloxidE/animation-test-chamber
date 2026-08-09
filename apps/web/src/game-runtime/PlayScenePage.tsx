import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrthographicCamera, PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import { useParams } from "react-router-dom";
import type { CameraProfile } from "@atc/schema";
import { FixedStepAccumulator } from "@atc/runtime-core";
import { BrowserInputSampler } from "@atc/input-runtime";
import { instantiateScene, type RuntimeScene } from "@atc/game-object-runtime";
import { gameplayScriptRegistry } from "@atc/gameplay";
import { TERRAIN_PRESETS } from "@atc/terrain-runtime";
import { routeId } from "../app/routes.ts";
import { useChamber } from "../store.ts";
import { browserPrefabRegistry } from "../game-objects/prefab-registry.ts";
import { GameObjectRenderer } from "../game-objects/GameObjectRenderer.tsx";
import {
  projectRuntimeScene,
  type SceneRenderProjection,
} from "../game-objects/render-projection.ts";
import { GameOverlay } from "../game-ui/GameOverlay.tsx";
import { isPlayTestDriven, registerPlayRuntime } from "../test-driver.ts";

type PlayCameraState = { yaw: number; pitch: number };

function PlayClock({
  runtime,
  sampler,
  onFrame,
  cameraState,
  cameraProfile,
}: {
  runtime: RuntimeScene;
  sampler: BrowserInputSampler;
  onFrame: () => void;
  cameraState: PlayCameraState | undefined;
  cameraProfile: CameraProfile | undefined;
}) {
  const accumulator = useRef(new FixedStepAccumulator());
  const { camera } = useThree();
  useFrame((_, delta) => {
    if (isPlayTestDriven()) return;
    const steps = accumulator.current.advance(delta);
    if (!steps) return;
    for (let index = 0; index < steps; index += 1) {
      const sample = sampler.sample();
      runtime.injectHumanIntent(0, sample);
      if (cameraState && cameraProfile) {
        cameraState.yaw -= sample.lookX;
        cameraState.pitch = Math.min(
          cameraProfile.maxPitchRad,
          Math.max(cameraProfile.minPitchRad, cameraState.pitch + sample.lookY),
        );
      }
      const { x, y, z, w } = camera.quaternion;
      const cameraYawRad =
        cameraState?.yaw ??
        Math.atan2(2 * (w * y + x * z), 1 - 2 * (y * y + z * z));
      runtime.step({ cameraYawRad });
    }
    onFrame();
  }, -1);
  return null;
}

/**
 * Temporary camera-authority contract:
 * Scene selects the active Camera and target; its instance transform is the
 * authored initial placement; Camera Component owns the lens; project.camera
 * is the single gameplay orbit/follow policy. The Prefab child transform is
 * not interpreted as another follow offset.
 */
function TargetCameraFollow({
  runtime,
  profile,
  state,
}: {
  runtime: RuntimeScene;
  profile: CameraProfile;
  state: PlayCameraState;
}) {
  const { camera } = useThree();
  const smoothed = useRef(new THREE.Vector3(0, 3, -6));
  const targetId =
    runtime.activeCamera?.definition.relations.cameraTargetGameObjectId;

  useFrame((_, delta) => {
    const target = targetId ? runtime.get(targetId) : undefined;
    if (!target) return;
    const position = target.worldTransform.position;
    const desired = new THREE.Vector3(
      position.x -
        Math.sin(state.yaw) * profile.distance * Math.cos(state.pitch),
      position.y + profile.height + Math.sin(state.pitch) * profile.distance,
      position.z -
        Math.cos(state.yaw) * profile.distance * Math.cos(state.pitch),
    );
    const alpha =
      profile.followLagSec <= 0
        ? 1
        : 1 - Math.exp(-delta / profile.followLagSec);
    smoothed.current.lerp(desired, alpha);
    camera.position.copy(smoothed.current);
    camera.lookAt(position.x, position.y + profile.lookAtHeight, position.z);
  });
  return null;
}

function AuthoredCamera({ projection }: { projection: SceneRenderProjection }) {
  const node = projection.activeCamera;
  if (!node?.camera) return null;
  const transform = node.worldTransform;
  const common = {
    makeDefault: true,
    position: [
      transform.position.x,
      transform.position.y,
      transform.position.z,
    ] as [number, number, number],
    quaternion: [
      transform.rotation.x,
      transform.rotation.y,
      transform.rotation.z,
      transform.rotation.w,
    ] as [number, number, number, number],
    near: 0.01,
    far: 2000,
  };
  return node.camera.projection === "orthographic" ? (
    <OrthographicCamera
      {...common}
      zoom={1 / (node.camera.orthographicSize ?? 10)}
    />
  ) : (
    <PerspectiveCamera {...common} fov={node.camera.fieldOfViewDeg ?? 60} />
  );
}

/** Browser-visible evidence derived from the same projection the renderer consumes. */
function PlayRenderEvidence({
  projection,
  output,
}: {
  projection: SceneRenderProjection;
  output: { current: HTMLOutputElement | null };
}) {
  const { camera } = useThree();
  useFrame(() => {
    if (!output.current) return;
    output.current.dataset.cameraPosition = JSON.stringify(
      camera.position.toArray(),
    );
    output.current.dataset.cameraYaw = String(
      new THREE.Euler().setFromQuaternion(camera.quaternion, "YXZ").y,
    );
    output.current.dataset.renderedObjects = JSON.stringify(
      projection.nodes
        .filter((node) => node.model !== undefined)
        .map((node) => ({
          id: node.gameObjectId,
          position: node.worldTransform.position,
          model: node.model?.binding,
          animationState: node.animator?.stateId,
          animationTime: node.animator?.normalizedTime,
          blendWeight: node.animator?.blendWeight,
        })),
    );
  });
  return null;
}

function PlayCanvas({
  runtime,
  sampler,
  sceneId,
  activeCameraGameObjectId,
  cameraProfile,
}: {
  runtime: RuntimeScene;
  sampler: BrowserInputSampler;
  sceneId: string;
  activeCameraGameObjectId?: string;
  cameraProfile: CameraProfile;
}) {
  const [frame, setFrame] = useState(0);
  const cameraState = useRef<PlayCameraState>({ yaw: 0, pitch: 0.25 });
  const evidence = useRef<HTMLOutputElement | null>(null);
  const followsTarget =
    runtime.activeCamera?.definition.relations.cameraTargetGameObjectId !==
    undefined;
  const projection = useMemo(
    () => projectRuntimeScene(runtime, activeCameraGameObjectId),
    [runtime, activeCameraGameObjectId, frame],
  );
  if (!projection.activeCamera)
    return (
      <p data-testid="play-camera-unavailable">
        Scene “{sceneId}” has no valid authored active Camera.
      </p>
    );
  return (
    <>
      <Canvas data-testid="play-canvas">
        <AuthoredCamera projection={projection} />
        <PlayClock
          runtime={runtime}
          sampler={sampler}
          onFrame={() => setFrame((value) => value + 1)}
          cameraState={followsTarget ? cameraState.current : undefined}
          cameraProfile={followsTarget ? cameraProfile : undefined}
        />
        {followsTarget && (
          <TargetCameraFollow
            runtime={runtime}
            profile={cameraProfile}
            state={cameraState.current}
          />
        )}
        <PlayRenderEvidence projection={projection} output={evidence} />
        <ambientLight intensity={0.5} />
        <GameObjectRenderer projection={projection} />
      </Canvas>
      <output ref={evidence} hidden data-testid="play-render-evidence" />
    </>
  );
}

export function PlayScenePage(): JSX.Element {
  const requestedId = routeId(useParams().sceneId);
  const project = useChamber((state) => state.canonicalProject);
  const animationRegistry = useChamber((state) => state.registry);
  const implicitSceneId = project.scenes.some(
    (candidate) => candidate.id === project.activeSceneId,
  )
    ? project.activeSceneId
    : project.scenes[0]?.id;
  const sceneId = requestedId ?? implicitSceneId;
  const scene = project.scenes.find((candidate) => candidate.id === sceneId);
  const terrain =
    TERRAIN_PRESETS.find(
      (candidate) => candidate.id === project.defaultTerrainPresetId,
    ) ?? TERRAIN_PRESETS[0];
  const [runtime, setRuntime] = useState<RuntimeScene | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sampler = useMemo(
    () => new BrowserInputSampler(project.inputMap),
    [project.inputMap],
  );

  useEffect(() => {
    sampler.attach();
    return () => sampler.detach();
  }, [sampler]);

  useEffect(() => {
    if (!scene) {
      setError(
        requestedId
          ? `Scene “${requestedId}” is unavailable.`
          : "No playable Scene is available.",
      );
      setRuntime(null);
      return;
    }
    try {
      const prefabRegistry = browserPrefabRegistry();
      const next = instantiateScene({
        scene,
        project,
        ...(terrain ? { terrain } : {}),
        services: {
          animationRegistry,
          prefabRegistry,
          gameplayRegistry: gameplayScriptRegistry,
          clock: { fixedDeltaSeconds: 1 / 60 },
          ...(terrain ? { terrain } : {}),
        },
      });
      setRuntime(next);
      setError(null);
      const unregister = registerPlayRuntime(next);
      return () => {
        unregister();
        next.dispose();
      };
    } catch (failure) {
      setRuntime(null);
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }, [scene, requestedId, project, animationRegistry, terrain]);

  if (!scene || error)
    return (
      <main
        className="play-surface play-surface--error"
        data-testid="play-surface"
      >
        <p>{error ?? `Scene “${sceneId ?? ""}” is unavailable.`}</p>
      </main>
    );
  return (
    <main
      className="play-surface"
      data-testid="play-surface"
      data-scene-id={scene.id}
    >
      {runtime && (
        <PlayCanvas
          runtime={runtime}
          sampler={sampler}
          sceneId={scene.id}
          activeCameraGameObjectId={scene.activeCameraGameObjectId}
          cameraProfile={project.camera}
        />
      )}
      <GameOverlay sceneName={scene.displayName} />
    </main>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrthographicCamera, PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import { useParams } from "react-router-dom";
import type { CameraProfile } from "@atc/schema";
import { FixedStepAccumulator, wrapRadians } from "@atc/runtime-core";
import { BrowserInputSampler, emptySample } from "@atc/input-runtime";
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
import {
  GameWorldLayer,
  gameSocketAttachments,
} from "../game-ui/GameWorldLayer.tsx";
import {
  isGameplayInputSuppressed,
  isPaused,
  resetGameplayInputSuppression,
  resetPause,
} from "../game-ui/game-session.ts";
import {
  isPlayTestDriven,
  registerPlayRuntime,
  registerPlayThreeScene,
} from "../test-driver.ts";
import {
  authoredFollowCameraState,
  type PlayCameraState,
} from "./camera-follow.ts";

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
    /*
     * One pause authority. A held simulation advances nothing — not the match
     * clock, not the AI, not a queued gameplay event — so a modal menu cannot
     * leave the battle running invisibly behind it.
     */
    if (isPaused()) return;
    for (let index = 0; index < steps; index += 1) {
      /*
       * The device is still sampled while a menu owns input, so held keys do
       * not survive the menu as a press; the character is simply handed a
       * neutral frame instead.
       */
      const device = sampler.sample();
      const sample = isGameplayInputSuppressed() ? emptySample() : device;
      runtime.injectHumanIntent(0, sample);
      if (cameraState && cameraProfile) {
        cameraState.yaw = wrapRadians(cameraState.yaw - sample.lookX);
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
 * Whether a hit object is part of the followed GameObject's own hierarchy.
 *
 * Walked up the parent chain rather than matched on the hit object's own name:
 * the meshes inside an imported model carry the artist's names, so a camera
 * that only checked the leaf would treat the character's own arm as an
 * obstruction and slam the boom into their back.
 */
function belongsTo(object: THREE.Object3D, gameObjectId: string | undefined): boolean {
  if (!gameObjectId) return false;
  for (let node: THREE.Object3D | null = object; node; node = node.parent) {
    if (node.name === gameObjectId || node.name.startsWith(`${gameObjectId}:`)) return true;
  }
  return false;
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
  initialPosition,
}: {
  runtime: RuntimeScene;
  profile: CameraProfile;
  state: PlayCameraState;
  initialPosition: THREE.Vector3;
}) {
  const { camera, scene } = useThree();
  const smoothed = useRef(initialPosition.clone());
  const raycaster = useRef(new THREE.Raycaster());
  const targetId =
    runtime.activeCamera?.definition.relations.cameraTargetGameObjectId;

  useFrame((_, delta) => {
    const target = targetId ? runtime.get(targetId) : undefined;
    if (!target) return;
    const position = target.worldTransform.position;
    const pivot = new THREE.Vector3(
      position.x,
      position.y + profile.lookAtHeight,
      position.z,
    );
    const offset = new THREE.Vector3(
      -Math.sin(state.yaw) * profile.distance * Math.cos(state.pitch),
      profile.height - profile.lookAtHeight + Math.sin(state.pitch) * profile.distance,
      -Math.cos(state.yaw) * profile.distance * Math.cos(state.pitch),
    );
    /*
     * Obstruction handling: cast from the character out to where the camera
     * wants to be and pull the boom in to the first thing in the way. Without
     * it a third-person camera spends half a wooded arena inside a tree trunk,
     * which is the one camera failure a player cannot work around.
     */
    const distance = offset.length();
    if (distance > 0.01) {
      raycaster.current.set(pivot, offset.clone().normalize());
      raycaster.current.far = distance;
      const blocking = raycaster.current
        .intersectObjects(scene.children, true)
        .find(
          (hit) =>
            hit.distance > 0.35 &&
            hit.object.visible &&
            (hit.object as THREE.Mesh).isMesh === true &&
            !belongsTo(hit.object, targetId),
        );
      if (blocking) offset.setLength(Math.max(0.9, blocking.distance - 0.35));
    }
    const desired = pivot.clone().add(offset);
    const alpha =
      profile.followLagSec <= 0
        ? 1
        : 1 - Math.exp(-delta / profile.followLagSec);
    /* Snapping *in* keeps geometry out of frame; easing out stays smooth. */
    smoothed.current.lerp(desired, desired.distanceTo(pivot) < smoothed.current.distanceTo(pivot) ? 1 : alpha);
    camera.position.copy(smoothed.current);
    camera.lookAt(pivot);
  });
  return null;
}

function PlayThreeSceneRegistration() {
  const { scene, camera } = useThree();
  useEffect(() => registerPlayThreeScene(scene, camera), [scene, camera]);
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
  const followsTarget =
    runtime.activeCamera?.definition.relations.cameraTargetGameObjectId !==
    undefined;
  const projection = useMemo(
    () => projectRuntimeScene(runtime, activeCameraGameObjectId),
    [runtime, activeCameraGameObjectId, frame],
  );
  /*
   * Re-derived on a slice of the frames. An equip is a human action, so a
   * one-or-two-frame delay is invisible, while re-projecting every Script's
   * state per frame is not.
   */
  const attachmentEpoch = Math.floor(frame / 3);
  const renderAttachment = useMemo(
    () => gameSocketAttachments(runtime),
    [runtime, attachmentEpoch],
  );
  const authoredCameraPosition =
    projection.activeCamera?.worldTransform.position;
  const targetId =
    runtime.activeCamera?.definition.relations.cameraTargetGameObjectId;
  const targetPosition = targetId
    ? runtime.get(targetId)?.worldTransform.position
    : undefined;
  // This fallback is only for malformed follow relations; a valid authored
  // camera and target always determine the initial orbit state.
  const cameraState = useRef<PlayCameraState>(
    authoredCameraPosition && targetPosition
      ? authoredFollowCameraState(
          authoredCameraPosition,
          targetPosition,
          cameraProfile,
        )
      : { yaw: 0, pitch: 0 },
  );
  const initialCameraPosition = useRef(
    authoredCameraPosition
      ? new THREE.Vector3(
          authoredCameraPosition.x,
          authoredCameraPosition.y,
          authoredCameraPosition.z,
        )
      : new THREE.Vector3(),
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
        <PlayThreeSceneRegistration />
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
            initialPosition={initialCameraPosition.current}
          />
        )}
        <ambientLight intensity={0.22} />
        <GameWorldLayer runtime={runtime} />
        <GameObjectRenderer
          projection={projection}
          {...(renderAttachment ? { renderAttachment } : {})}
        />
      </Canvas>
    </>
  );
}

export function PlayScenePage(): JSX.Element {
  const requestedId = routeId(useParams().sceneId);
  const project = useChamber((state) => state.canonicalProject);
  const animationRegistry = useChamber((state) => state.registry);
  const sceneId = requestedId ?? project.activeSceneId;
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
    return () => {
      sampler.detach();
      /* A modal that never closed must not wedge the next Scene. */
      resetPause();
      resetGameplayInputSuppression();
    };
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
      <GameOverlay sceneName={scene.displayName} runtime={runtime} />
    </main>
  );
}

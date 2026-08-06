/**
 * The Scene viewport.
 *
 * It draws the **running** Scene, through the production renderer:
 *
 *   RuntimeScene.gameObjects → projectRuntimeScene() → <GameObjectRenderer />
 *
 * It does not iterate `scene.entities`, and it has no fallback that does (§5.1,
 * §4.5). A viewport that fell back would draw a plausible picture of a Scene
 * whose canonical GameObject data is broken, and nobody would find out until
 * something ran it.
 *
 * Placement comes from `RuntimeGameObject.worldTransform`, already composed by
 * the runtime (§2.4). Nothing here re-derives a world position from a parent
 * chain — that would be a second answer to where things are, and the two would
 * disagree the first time a character carried something.
 *
 * ## Two cameras, and they are not the same camera
 *
 * The *editor* camera is transient UI state and appears in no document (§5.2):
 * orbiting to look at something must never stage a Scene edit. The *authored*
 * active camera is canonical, resolved through its Camera Component, and shown
 * here as a gizmo — the editor keeps control of the canvas, and the Scene says
 * where it would play from.
 *
 * Selection is one state shared with the Hierarchy (§11.7). Clicking a node here
 * and clicking its row there are the same `SceneSelection` value passed in — not
 * two selections kept in sync — and a click on a *child* node selects the child
 * for inspection while leaving the operation target on the root instance (§5.3).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Grid, OrbitControls, TransformControls } from '@react-three/drei';
import * as THREE from 'three';
import type { SceneDefinition, TransformDefinition } from '@atc/schema';
import { FixedStepAccumulator } from '@atc/runtime-core';
import type { RuntimeScene } from '@atc/game-object-runtime';
import { GameObjectRenderer } from '../../game-objects/GameObjectRenderer.tsx';
import {
  projectRuntimeScene,
  type RenderProjectionIssue,
} from '../../game-objects/render-projection.ts';
import {
  selectedInstanceId,
  selectionForRuntimeNode,
  type SceneSelection,
} from '../scene-selection.ts';
import { readDragPayload, type ScenePrefabDragPayload } from '../drag-payload.ts';
import type { SceneRuntimeHandle } from '../use-scene-runtime.ts';

export type GizmoMode = 'translate' | 'rotate' | 'scale';
export type TransformSpace = 'local' | 'world';

export interface SceneViewportProps {
  scene: SceneDefinition;
  runtime: SceneRuntimeHandle;
  selection: SceneSelection;
  onSelect: (selection: SceneSelection) => void;
  /**
   * Called **once** per completed gesture, never per frame.
   *
   * A drag that dispatched on every pointer move would produce hundreds of
   * permanent operations and hundreds of undo entries for one motion, so the
   * gizmo previews locally and commits a single semantic operation on release
   * (§11.8). The id it is handed is always a *root instance* id (§2.5).
   */
  onCommitTransform: (gameObjectId: string, transform: TransformDefinition) => void;
  mode: GizmoMode;
  space: TransformSpace;
  /**
   * Called on a valid drop, with the ground-plane point under the cursor.
   *
   * The *drop* decides where a thing lands, which is why the drag payload
   * carries no transform. Placing everything at the origin when a real hit
   * point exists would make composing a scene a sequence of drop-then-drag-it-
   * to-where-you-meant gestures.
   */
  onDropPrefab: (
    payload: ScenePrefabDragPayload,
    point: { x: number; y: number; z: number },
  ) => void;
  /** Renderer-side problems, reported upward so the editor can show them. */
  onRenderIssues?: (issues: RenderProjectionIssue[]) => void;
}

/**
 * The one clock for this viewport (§4.3).
 *
 * Fixed-step, from the shared accumulator the World engine uses, so the Scene
 * advances in whole simulation ticks rather than by however long the last frame
 * happened to take. `advanced` is what tells React to re-read the projection;
 * without it the runtime would move and the picture would not.
 */
function SceneClock({
  runtime,
  playing,
  advanced,
}: {
  runtime: RuntimeScene | null;
  playing: boolean;
  advanced: () => void;
}) {
  const accumulator = useRef(new FixedStepAccumulator());
  const { camera } = useThree();

  useFrame((_, delta) => {
    if (!runtime || !playing) return;
    const steps = accumulator.current.advance(delta);
    if (steps === 0) return;
    /*
     * Camera yaw is handed to the runtime, not read from it. A character's
     * movement is camera-relative, and the *editor's* camera is the one the
     * human is steering — so this is the same input the chamber supplies, from
     * the viewport that actually exists.
     */
    const yaw = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ').y;
    for (let step = 0; step < steps; step += 1) runtime.step({ cameraYawRad: yaw });
    advanced();
  });

  return null;
}

/** Frames the scene once on mount. Camera motion after that is the user's. */
function InitialCamera() {
  const { camera } = useThree();
  useEffect(() => {
    camera.position.set(6, 5, 8);
    camera.lookAt(0, 1, 0);
  }, [camera]);
  return null;
}

/**
 * Captures the camera so a DOM drag event — which knows nothing about three.js
 * — can be turned into a point on the ground plane.
 */
function CameraProbe({ onReady }: { onReady: (camera: THREE.Camera) => void }) {
  const { camera } = useThree();
  useEffect(() => onReady(camera), [camera, onReady]);
  return null;
}

/**
 * The drop ghost.
 *
 * Presentation only, and never written into `previewDocument` (§12.3): a ghost
 * that edited the preview would make "I dragged over the viewport and changed
 * my mind" produce a dirty session with a GameObject in it.
 */
function DropGhost({ point, valid }: { point: THREE.Vector3; valid: boolean }) {
  return (
    <mesh position={[point.x, point.y + 0.5, point.z]}>
      <boxGeometry args={[0.6, 1, 0.6]} />
      <meshBasicMaterial
        color={valid ? '#6ea8fe' : '#ff6b6b'}
        transparent
        opacity={0.45}
        wireframe={!valid}
      />
    </mesh>
  );
}

/**
 * The gizmo's proxy object, parked at one root instance's world transform.
 *
 * A proxy rather than the drawn group, because what the renderer draws is
 * projected from the runtime every frame and the gizmo needs something it can
 * own for the length of a drag. On release the proxy's transform becomes one
 * `scene.set_transform` naming the root instance.
 */
function GizmoTarget({
  worldTransform,
  live,
  onRegister,
}: {
  worldTransform: TransformDefinition;
  /** While false the proxy tracks the document; while true the gizmo owns it. */
  live: boolean;
  onRegister: (object: THREE.Object3D | null) => void;
}) {
  const group = useRef<THREE.Group>(null);

  useEffect(() => {
    const object = group.current;
    if (!object || live) return;
    // Re-applied whenever the document moves, but *not* during a drag: the
    // gizmo owns the object then, and re-applying every frame would fight it
    // back to where the drag started.
    object.position.set(worldTransform.position.x, worldTransform.position.y, worldTransform.position.z);
    object.quaternion.set(
      worldTransform.rotation.x,
      worldTransform.rotation.y,
      worldTransform.rotation.z,
      worldTransform.rotation.w,
    );
    object.scale.set(worldTransform.scale.x, worldTransform.scale.y, worldTransform.scale.z);
  }, [worldTransform, live]);

  useEffect(() => {
    onRegister(group.current);
    return () => onRegister(null);
  }, [onRegister]);

  return <group ref={group} />;
}

function fromObject(object: THREE.Object3D): TransformDefinition {
  return {
    position: { x: object.position.x, y: object.position.y, z: object.position.z },
    rotation: {
      x: object.quaternion.x,
      y: object.quaternion.y,
      z: object.quaternion.z,
      w: object.quaternion.w,
    },
    scale: { x: object.scale.x, y: object.scale.y, z: object.scale.z },
  };
}

export function SceneViewport({
  scene,
  runtime,
  selection,
  onSelect,
  onCommitTransform,
  mode,
  space,
  onDropPrefab,
  onRenderIssues,
}: SceneViewportProps): JSX.Element {
  const [target, setTarget] = useState<THREE.Object3D | null>(null);
  const [dragging, setDragging] = useState(false);
  const [ghost, setGhost] = useState<{ point: THREE.Vector3; valid: boolean } | null>(null);
  const instanceId = selectedInstanceId(selection);

  const cameraRef = useRef<THREE.Camera | null>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const onCameraReady = useCallback((camera: THREE.Camera) => {
    cameraRef.current = camera;
  }, []);

  /*
   * The projection, re-read whenever the runtime advanced or the document
   * changed. `runtime.frame` is in the dependency list precisely so a moving
   * simulation produces a moving picture — the runtime mutates in place, so
   * nothing else about it would tell React to look again.
   */
  const projection = useMemo(
    () =>
      runtime.runtime
        ? projectRuntimeScene(runtime.runtime, scene.activeCameraGameObjectId)
        : undefined,
    [runtime.runtime, runtime.frame, scene.activeCameraGameObjectId],
  );

  const [rendererIssues, setRendererIssues] = useState<RenderProjectionIssue[]>([]);
  const reportIssue = useCallback((issue: RenderProjectionIssue) => {
    setRendererIssues((current) =>
      current.some(
        (entry) => entry.code === issue.code && entry.gameObjectId === issue.gameObjectId,
      )
        ? current
        : [...current, issue],
    );
  }, []);

  useEffect(() => {
    onRenderIssues?.([...(projection?.issues ?? []), ...rendererIssues]);
  }, [projection, rendererIssues, onRenderIssues]);

  /** The runtime node the gizmo would move, and whether the simulation owns it. */
  const gizmoNode = useMemo(() => {
    if (!instanceId || !projection) return undefined;
    const root = projection.nodes.find((node) => node.gameObjectId === instanceId);
    if (!root) return undefined;
    // Any node of this instance being simulation-owned means the authored root
    // transform is not what the viewer is looking at (§5.5).
    const simulated = projection.nodes.some(
      (node) =>
        node.simulated &&
        (node.gameObjectId === instanceId || node.gameObjectId.startsWith(`${instanceId}/`)),
    );
    return { root, simulated };
  }, [instanceId, projection]);

  /*
   * A simulation-owned object is not draggable while the Scene is running.
   *
   * The gizmo would be sitting on a placement the next tick overwrites, so a
   * drag would either be silently discarded or — worse — commit an authored
   * transform copied from wherever the simulation had drifted to. Refused with
   * a reason, and Pause is right there (§5.5).
   */
  const gizmoRefused = gizmoNode?.simulated === true && runtime.playing;

  /**
   * Where the cursor points on the ground plane, or `null` when the ray misses
   * it — looking up at the sky, for instance. A miss must stay a miss: silently
   * substituting the origin would place the object somewhere the user never
   * pointed.
   */
  const groundPoint = (event: React.DragEvent): THREE.Vector3 | null => {
    const camera = cameraRef.current;
    const surface = surfaceRef.current;
    if (!camera || !surface) return null;

    const bounds = surface.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
      -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(ndc, camera);
    const hit = new THREE.Vector3();
    const found = raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit);
    return found ? hit : null;
  };

  const handleDragOver = (event: React.DragEvent): void => {
    if (!event.dataTransfer.types.includes('application/x-atc-scene-asset')) return;
    // Preventing default is what makes this a drop target at all.
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    const point = groundPoint(event);
    setGhost(point ? { point, valid: true } : null);
  };

  const handleDrop = (event: React.DragEvent): void => {
    event.preventDefault();
    setGhost(null);
    const payload = readDragPayload(event.dataTransfer);
    // An unrecognised payload is refused rather than guessed at — that is how
    // an OS file drag stays out of canonical Scene data.
    if (!payload) return;
    const point = groundPoint(event);
    if (!point) return;
    onDropPrefab(payload, { x: point.x, y: point.y, z: point.z });
  };

  return (
    <div
      className="scene-viewport"
      data-testid="scene-viewport"
      ref={surfaceRef}
      onDragOver={handleDragOver}
      // Cancelling or leaving clears the ghost; nothing was ever staged by it.
      onDragLeave={() => setGhost(null)}
      onDrop={handleDrop}
    >
      <div className="scene-viewport__transport" data-testid="scene-transport">
        <button
          type="button"
          onClick={() => runtime.setPlaying(!runtime.playing)}
          data-testid="scene-play-toggle"
        >
          {runtime.playing ? 'Pause' : 'Play'}
        </button>
        <button type="button" onClick={runtime.reset} data-testid="scene-reset">
          Reset
        </button>
        <span data-testid="scene-runtime-state">
          {runtime.runtime ? (runtime.playing ? 'RUNNING' : 'PAUSED') : 'NOT RUNNING'}
        </span>
      </div>

      {!runtime.runtime ? (
        /*
         * No runtime, no picture, and no substitute picture. This is the
         * no-fallback rule made visible: the Scene's GameObjects did not
         * resolve, and drawing its entity mirror instead would hide exactly the
         * problem the person on this page has to fix.
         */
        <p data-testid="scene-viewport-unavailable">
          This Scene’s GameObjects did not resolve, so there is nothing to run. The issues are
          listed below; the entity mirror is never drawn in its place.
        </p>
      ) : (
        <Canvas
          camera={{ fov: 55, near: 0.1, far: 500 }}
          onPointerMissed={() => {
            // Clicking empty space selects the scene root rather than clearing
            // to nothing, so the Inspector always has something to show.
            if (!dragging) onSelect({ kind: 'scene', sceneId: scene.id });
          }}
        >
          <InitialCamera />
          <CameraProbe onReady={onCameraReady} />
          <SceneClock
            runtime={runtime.runtime}
            playing={runtime.playing && !dragging}
            advanced={runtime.advanced}
          />
          <ambientLight intensity={0.6} />
          <directionalLight position={[5, 8, 4]} intensity={1.1} />
          <Grid
            args={[40, 40]}
            cellColor="#2a2f3a"
            sectionColor="#3d4657"
            fadeDistance={45}
            infiniteGrid
          />
          <axesHelper args={[2]} />

          {projection && (
            <GameObjectRenderer
              projection={projection}
              selectedGameObjectId={instanceId}
              onSelect={(runtimeId) => onSelect(selectionForRuntimeNode(scene.id, runtimeId))}
              onIssue={reportIssue}
            />
          )}

          {gizmoNode && !gizmoRefused && (
            <GizmoTarget
              worldTransform={gizmoNode.root.worldTransform}
              live={dragging}
              onRegister={setTarget}
            />
          )}

          {target && instanceId && !gizmoRefused && (
            <TransformControls
              object={target}
              mode={mode}
              space={space}
              onMouseDown={() => setDragging(true)}
              onMouseUp={() => {
                setDragging(false);
                // One operation for the whole gesture, naming the *root
                // instance* — never the runtime node that was clicked.
                onCommitTransform(instanceId, fromObject(target));
              }}
            />
          )}

          {ghost && <DropGhost point={ghost.point} valid={ghost.valid} />}

          {/* Disabled during a gizmo drag so orbiting does not fight the handle. */}
          <OrbitControls makeDefault enabled={!dragging} target={[0, 1, 0]} />
        </Canvas>
      )}

      {gizmoRefused && (
        <p data-testid="scene-gizmo-refused">
          “{gizmoNode?.root.displayName}” is driven by its CharacterMotor while the Scene is
          running, so its placement belongs to the simulation. Pause or Reset to move its authored
          transform.
        </p>
      )}
    </div>
  );
}

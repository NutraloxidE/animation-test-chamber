/**
 * The Scene viewport.
 *
 * An **editor** viewport, not a runtime playback view: it renders the *authored*
 * staged document — where entities are declared to be — rather than where a
 * running simulation has moved them. That distinction is the reason the editor
 * camera appears in no document (work package §6.8): orbiting to look at
 * something must never stage a Scene edit, so the camera lives in local state
 * and is never dispatched.
 *
 * Selection is one state shared with the Hierarchy (§11.7). Clicking an entity
 * here and clicking its row there are the same selection, because they are the
 * same `SceneSelection` value passed in — not two selections kept in sync.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Canvas, useThree, type ThreeEvent } from '@react-three/fiber';
import { Grid, OrbitControls, TransformControls } from '@react-three/drei';
import * as THREE from 'three';
import type { SceneDefinition, SceneEntityDefinition, TransformDefinition } from '@atc/schema';
import type { SceneSelection } from '../scene-selection.ts';
import { readDragPayload, type SceneAssetDragPayload } from '../drag-payload.ts';

export type GizmoMode = 'translate' | 'rotate' | 'scale';
export type TransformSpace = 'local' | 'world';

export interface SceneViewportProps {
  scene: SceneDefinition;
  selection: SceneSelection;
  onSelect: (selection: SceneSelection) => void;
  /**
   * Called **once** per completed gesture, never per frame.
   *
   * A drag that dispatched on every pointer move would produce hundreds of
   * permanent operations and hundreds of undo entries for one motion, so the
   * gizmo previews locally and commits a single semantic operation on release
   * (§11.8).
   */
  onCommitTransform: (entityId: string, transform: TransformDefinition) => void;
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
  onDropAsset: (payload: SceneAssetDragPayload, point: { x: number; y: number; z: number }) => void;
}

/** The colour an entity renders in, so kinds are distinguishable without labels. */
const KIND_COLOR: Record<SceneEntityDefinition['kind'], string> = {
  character: '#6ea8fe',
  prop: '#a8b0be',
  light: '#f7d774',
  camera: '#7fd7a8',
};

function toObject(transform: TransformDefinition, object: THREE.Object3D): void {
  object.position.set(transform.position.x, transform.position.y, transform.position.z);
  object.quaternion.set(
    transform.rotation.x,
    transform.rotation.y,
    transform.rotation.z,
    transform.rotation.w,
  );
  object.scale.set(transform.scale.x, transform.scale.y, transform.scale.z);
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

/**
 * A placeholder body per entity kind.
 *
 * Deliberately primitive geometry rather than the character's real mesh. The
 * Rig Editor already renders the model; what the Scene Editor has to show is
 * *where things are and what they are*, and a stand-in that loads instantly
 * says that as well as a GLTF does — while a half-loaded model would leave the
 * composition impossible to read.
 */
function EntityBody({ entity, selected }: { entity: SceneEntityDefinition; selected: boolean }) {
  const color = KIND_COLOR[entity.kind];
  const emissive = selected ? '#facc15' : '#000000';

  if (entity.kind === 'light') {
    return (
      <mesh>
        <sphereGeometry args={[0.25, 16, 12]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.6} />
      </mesh>
    );
  }
  if (entity.kind === 'camera') {
    return (
      <mesh>
        <coneGeometry args={[0.25, 0.6, 4]} />
        <meshStandardMaterial color={color} emissive={emissive} emissiveIntensity={0.5} />
      </mesh>
    );
  }
  if (entity.kind === 'prop') {
    return (
      <mesh>
        <boxGeometry args={[0.6, 0.6, 0.6]} />
        <meshStandardMaterial color={color} emissive={emissive} emissiveIntensity={0.5} />
      </mesh>
    );
  }
  return (
    <mesh position={[0, 0.9, 0]}>
      <capsuleGeometry args={[0.3, 1.2, 4, 12]} />
      <meshStandardMaterial color={color} emissive={emissive} emissiveIntensity={0.5} />
    </mesh>
  );
}

function SceneEntityObject({
  entity,
  selected,
  onSelect,
  register,
}: {
  entity: SceneEntityDefinition;
  selected: boolean;
  onSelect: () => void;
  register: (object: THREE.Object3D | null) => void;
}) {
  const group = useRef<THREE.Group>(null);

  /*
   * The authored transform is written onto the object whenever the document
   * changes — but *not* while this entity is the gizmo's target, because during
   * a drag the gizmo owns the object and re-applying the document every frame
   * would fight it back to where the drag started. `mounted` covers the first
   * pass, when an already-selected entity still needs its authored placement.
   */
  const mounted = useRef(false);
  useEffect(() => {
    if (!group.current) return;
    if (selected && mounted.current) return;
    mounted.current = true;
    toObject(entity.transform, group.current);
  }, [entity.transform, selected]);

  useEffect(() => {
    register(selected ? group.current : null);
    return () => register(null);
  }, [selected, register]);

  const handleClick = (event: ThreeEvent<MouseEvent>): void => {
    // Only the front-most hit selects; without this a click passes through and
    // the last entity in the list wins regardless of what was on screen.
    event.stopPropagation();
    onSelect();
  };

  return (
    <group ref={group} visible={entity.enabled} onClick={handleClick}>
      <EntityBody entity={entity} selected={selected} />
    </group>
  );
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
 * my mind" produce a dirty session with an entity in it.
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

export function SceneViewport({
  scene,
  selection,
  onSelect,
  onCommitTransform,
  mode,
  space,
  onDropAsset,
}: SceneViewportProps): JSX.Element {
  const [target, setTarget] = useState<THREE.Object3D | null>(null);
  const [dragging, setDragging] = useState(false);
  const [ghost, setGhost] = useState<{ point: THREE.Vector3; valid: boolean } | null>(null);
  const selectedId = selection.kind === 'entity' ? selection.entityId : null;

  const cameraRef = useRef<THREE.Camera | null>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const onCameraReady = useCallback((camera: THREE.Camera) => {
    cameraRef.current = camera;
  }, []);

  /**
   * Where the cursor points on the ground plane, or `null` when the ray misses
   * it — looking up at the sky, for instance. A miss must stay a miss: silently
   * substituting the origin would place the entity somewhere the user never
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
    const found = raycaster.ray.intersectPlane(
      new THREE.Plane(new THREE.Vector3(0, 1, 0), 0),
      hit,
    );
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
    onDropAsset(payload, { x: point.x, y: point.y, z: point.z });
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
      <Canvas
        camera={{ fov: 55, near: 0.1, far: 500 }}
        onPointerMissed={() => {
          // Clicking empty space selects the scene root rather than clearing to
          // nothing, so the Inspector always has something to show.
          if (!dragging) onSelect({ kind: 'scene', sceneId: scene.id });
        }}
      >
        <InitialCamera />
        <CameraProbe onReady={onCameraReady} />
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

        {scene.entities.map((entity) => (
          /*
           * Keyed by stable entity id. Keying by array position would remount
           * the wrong object whenever the scene was reordered, and the remount
           * would silently reset what the viewer was looking at.
           */
          <SceneEntityObject
            key={entity.id}
            entity={entity}
            selected={entity.id === selectedId}
            onSelect={() => onSelect({ kind: 'entity', sceneId: scene.id, entityId: entity.id })}
            register={setTarget}
          />
        ))}

        {target && selectedId && (
          <TransformControls
            object={target}
            mode={mode}
            space={space}
            onMouseDown={() => setDragging(true)}
            onMouseUp={() => {
              setDragging(false);
              // One operation for the whole gesture — see onCommitTransform.
              onCommitTransform(selectedId, fromObject(target));
            }}
          />
        )}

        {ghost && <DropGhost point={ghost.point} valid={ghost.valid} />}

        {/* Disabled during a gizmo drag so orbiting does not fight the handle. */}
        <OrbitControls makeDefault enabled={!dragging} target={[0, 1, 0]} />
      </Canvas>
    </div>
  );
}

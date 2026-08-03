/**
 * The shared scene renderer.
 *
 * One camera, one set of materials, one rig binding, one selection ring — and a
 * scene source plus a visibility filter to say what to draw. `World` and
 * `Isolate` are the same call with different filters, which is what makes Clip
 * Preview and the State Sandbox visible in both without either feature knowing
 * a presentation exists.
 *
 * Nothing here decides anything: the pose closures read a runtime, and the
 * selection ring is presentation. UI selection must not reach the simulation,
 * so the only thing selecting an instance changes is what the inspector shows.
 */
import { useEffect, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useChamber } from '../store.ts';
import type { WorldChamberEngine } from '../world/world-engine.ts';
import type { AnimationSandboxEngine } from '../animation/state-sandbox/AnimationSandboxEngine.ts';
import { ProceduralCharacter, type CharacterPose } from '../three/characters/ProceduralCharacter.tsx';
import { weaponMode } from '../three/catalog.ts';
import { selectedInstanceId } from '../selection/scene-selection.ts';
import { isVisible, type VisibilityFilter } from './visibility-filter.ts';
import type { ViewportSceneSource } from './viewport-scene-source.ts';

/** Advances the world and keeps the camera behind whatever it is following. */
function WorldLoop({
  engine,
  read,
}: {
  engine: WorldChamberEngine;
  read: () => CharacterPose | null;
}) {
  const { camera } = useThree();
  const smoothed = useRef(new THREE.Vector3(0, 3, -6));

  useFrame((_, delta) => {
    // While a test driver owns advancement, wall-clock deltas must not also
    // advance the world — the ticks under assertion would race the frames.
    if (!engine.testDriven) engine.advance(delta);

    const pose = read();
    const focus = pose?.position ?? { x: 0, y: 1, z: 0 };
    const target = new THREE.Vector3(focus.x, focus.y + 3.2, focus.z - 6.5);
    const alpha = 1 - Math.exp(-delta / 0.18);
    smoothed.current.lerp(target, alpha);
    camera.position.copy(smoothed.current);
    camera.lookAt(focus.x, focus.y + 1.1, focus.z);
  });

  return null;
}

/** A ring under the selected instance, so selection is visible in the scene. */
function SelectionRing({ read }: { read: () => CharacterPose | null }) {
  const ring = useRef<THREE.Mesh>(null);

  useFrame(() => {
    const mesh = ring.current;
    const pose = read();
    if (!mesh) return;
    mesh.visible = pose !== null;
    if (pose) mesh.position.set(pose.position.x, pose.position.y + 0.02, pose.position.z);
  });

  return (
    <mesh ref={ring} rotation={[-Math.PI / 2, 0, 0]}>
      <ringGeometry args={[0.45, 0.6, 32]} />
      <meshBasicMaterial color="#facc15" transparent opacity={0.85} />
    </mesh>
  );
}

/**
 * The sandbox character.
 *
 * Rendered through the same `ProceduralCharacter` as every live instance —
 * shared materials and shared rig binding are the whole point of the unified
 * path. The offset is presentation only: `At Target Transform` draws it where
 * the selected instance stands so the two are comparable, and `At Local Origin`
 * draws it at the preview stage's origin so root motion is legible. Neither
 * moves anything in the world.
 */
function SandboxCharacter({
  engine,
  offset,
}: {
  engine: AnimationSandboxEngine;
  offset: { x: number; y: number; z: number };
}) {
  const read = (): CharacterPose => {
    const pose = engine.pose();
    return {
      ...pose,
      position: {
        x: pose.position.x + offset.x,
        y: pose.position.y + offset.y,
        z: pose.position.z + offset.z,
      },
    };
  };
  return (
    <ProceduralCharacter
      pose={read}
      weapon={weaponMode(engine.target.effectiveWeaponModeId)}
      color="#f97316"
    />
  );
}

export function WorldSceneViewport({
  source,
  filter,
}: {
  source: ViewportSceneSource;
  filter: VisibilityFilter;
}) {
  const engine = useChamber((state) => state.worldEngine);
  const world = useChamber((state) => state.stagedWorld);
  const selection = useChamber((state) => state.sceneSelection);
  const selectScene = useChamber((state) => state.selectScene);
  const loadoutOf = useChamber((state) => state.loadoutOf);
  const sandboxEngine = useChamber((state) => state.sandboxEngine);
  const sandboxDisplay = useChamber((state) => state.sandbox.displayMode);
  // An attachment selection rings its parent instance: clicking the shield in
  // the tree and clicking the instance mean the same object out here.
  const selectedId = selectedInstanceId(selection);

  useEffect(() => {
    engine.attachInput();
    return () => engine.detachInput();
  }, [engine]);

  const sandboxActive = source.kind === 'state-sandbox' && sandboxEngine !== null;
  const focusId =
    filter.kind === 'instance' ? filter.instanceId : world.cameraTargetInstanceId;
  const sandboxOffset =
    sandboxDisplay === 'target-transform' && selectedId
      ? (world.instances.find((instance) => instance.id === selectedId)?.transform.position ?? {
          x: 0,
          y: 0,
          z: 0,
        })
      : { x: 0, y: 0, z: 0 };

  const cameraRead = (): CharacterPose | null =>
    sandboxActive && sandboxEngine
      ? { ...sandboxEngine.pose(), position: addOffset(sandboxEngine.pose().position, sandboxOffset) }
      : engine.poseOf(focusId)();

  return (
    <Canvas
      shadows
      dpr={[1, 2]}
      camera={{ fov: 55, position: [0, 3, -6] }}
      data-testid="world-viewport-canvas"
    >
      <color attach="background" args={['#0b1120']} />
      <fog attach="fog" args={['#0b1120', 25, 70]} />
      <ambientLight intensity={0.5} />
      <hemisphereLight args={['#93b4d8', '#0b1120', 0.9]} />
      <directionalLight position={[8, 14, 6]} intensity={1.1} castShadow shadow-mapSize={[1024, 1024]} />

      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[80, 80]} />
        <meshStandardMaterial color="#1e293b" />
      </mesh>

      <WorldLoop engine={engine} read={cameraRead} />

      {world.instances
        .filter((instance) => instance.enabled && isVisible(filter, instance.id))
        .map((instance) => (
          // Clicking an instance selects it, which is the other half of
          // hierarchy/viewport synchronization: the tree highlights what you
          // clicked here, and this rings what you clicked there.
          <group
            key={instance.id}
            onClick={(event) => {
              event.stopPropagation();
              selectScene({ kind: 'instance', instanceId: instance.id });
            }}
          >
            <ProceduralCharacter
              // The pose closure already carries the Clip Preview override:
              // it is applied inside `poseOf`, on the read side, which is why
              // preview works identically under every filter and why no
              // presentation has to know it exists.
              pose={engine.poseOf(instance.id)}
              // Per-instance, not global: two instances of one character can
              // hold different weapons, and the viewport has to be able to
              // show that or the isolation guarantee is invisible.
              weapon={weaponMode(loadoutOf(instance.id)?.weaponMode.effective ?? '')}
              // Colour by intent source, so "which one am I driving?" is
              // answerable without reading the inspector. A sandbox run dims
              // the live cast so the orange sandbox character is unambiguous.
              color={
                sandboxActive
                  ? '#334155'
                  : instance.intentSource.kind === 'local-input'
                    ? '#7dd3fc'
                    : '#c4b5fd'
              }
            />
          </group>
        ))}

      {sandboxActive && sandboxEngine && (
        <SandboxCharacter engine={sandboxEngine} offset={sandboxOffset} />
      )}

      {selectedId && isVisible(filter, selectedId) && (
        <SelectionRing read={engine.poseOf(selectedId)} />
      )}
    </Canvas>
  );
}

function addOffset(
  position: { x: number; y: number; z: number },
  offset: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  return { x: position.x + offset.x, y: position.y + offset.y, z: position.z + offset.z };
}

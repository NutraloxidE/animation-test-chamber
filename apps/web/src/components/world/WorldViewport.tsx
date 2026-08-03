/**
 * The multi-instance viewport.
 *
 * Every enabled instance is rendered, keyed by its stable instance id. Keying
 * by array position would remount the wrong character whenever the world was
 * reordered, and the remount would silently reset what the viewer was watching.
 *
 * Nothing here decides anything: the pose closures read the runtime, and the
 * selection ring is presentation. UI selection must not reach the simulation,
 * so the only thing selecting an instance changes is what the inspector shows —
 * not even the camera, which follows the world's *authored* target.
 */
import { useEffect, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useChamber } from '../../store.ts';
import type { WorldChamberEngine } from '../../world/world-engine.ts';
import { ProceduralCharacter } from '../../three/characters/ProceduralCharacter.tsx';
import { GltfCharacter } from '../../three/characters/GltfCharacter.tsx';
import { characterPreset, weaponMode } from '../../three/catalog.ts';
import { selectedInstanceId } from '../../selection/scene-selection.ts';

/** [x, z, size] of the static boxes scattered around the spawn area. */
const LANDMARKS: Array<[number, number, number]> = [
  [-6, 4, 1], [7, 2, 1.6], [-3, -8, 2.2], [5, -6, 1], [10, 9, 3], [-11, -3, 1.4], [0, 12, 2],
];

/** Advances the world and keeps the camera behind the camera-target instance. */
function WorldLoop({ engine, cameraTargetId }: { engine: WorldChamberEngine; cameraTargetId: string }) {
  const { camera } = useThree();
  const smoothed = useRef(new THREE.Vector3(0, 3, -6));

  useFrame((_, delta) => {
    // While a test driver owns advancement, wall-clock deltas must not also
    // advance the world — the ticks under assertion would race the frames.
    if (!engine.testDriven) engine.advance(delta);

    const pose = engine.poseOf(cameraTargetId)();
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
function SelectionRing({ engine, instanceId }: { engine: WorldChamberEngine; instanceId: string }) {
  const ring = useRef<THREE.Mesh>(null);
  const read = engine.poseOf(instanceId);

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

export function WorldViewport() {
  const engine = useChamber((state) => state.worldEngine);
  const world = useChamber((state) => state.stagedWorld);
  const selection = useChamber((state) => state.sceneSelection);
  const selectScene = useChamber((state) => state.selectScene);
  const loadoutOf = useChamber((state) => state.loadoutOf);
  // Resolved per instance below. Subscribing to both fields keeps the viewport
  // repainting when either the default or one instance's override changes.
  const characterPresetIdFor = useChamber((state) => state.characterPresetIdFor);
  useChamber((state) => state.characterPresetId);
  useChamber((state) => state.instanceCharacterPresets);
  // An attachment selection rings its parent instance: clicking the shield in
  // the tree and clicking the instance mean the same object out here.
  const selectedId = selectedInstanceId(selection);
  // Grip tuning is authored in Focused; without the same override lookup the
  // world would keep drawing the catalog's untuned grip.
  const weaponGripOverrides = useChamber((state) => state.weaponGripOverrides);

  useEffect(() => {
    engine.attachInput();
    return () => engine.detachInput();
  }, [engine]);

  const cameraTargetId = world.cameraTargetInstanceId;

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

      {/* Landmarks. An empty plane reads as static no matter how fast the world
          runs, so the ground carries a grid and a few boxes to move against. */}
      <gridHelper args={[80, 80, '#334155', '#233043']} />
      {LANDMARKS.map(([x, z, size], index) => (
        <mesh key={index} position={[x, size / 2, z]} castShadow receiveShadow>
          <boxGeometry args={[size, size, size]} />
          <meshStandardMaterial color="#475569" />
        </mesh>
      ))}

      <WorldLoop engine={engine} cameraTargetId={cameraTargetId} />

      {world.instances
        .filter((instance) => instance.enabled)
        .map((instance) => {
          const character = characterPreset(characterPresetIdFor(instance.id));
          const weapon = weaponMode(loadoutOf(instance.id)?.weaponMode.effective ?? '');
          const grip =
            weaponGripOverrides[`${character.id}:${weapon.id}`] ??
            character.weaponGrips?.[weapon.id];
          return (
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
            {character.modelUrl ? (
              // Per-instance, not global: two instances of one character can
              // hold different weapons, and the viewport has to be able to
              // show that or the isolation guarantee is invisible.
              <GltfCharacter
                worldEngine={engine}
                instanceId={instance.id}
                pose={engine.poseOf(instance.id)}
                // Per instance, not the world's raw document: each instance
                // resolves its own character's motion set.
                poseProject={engine.instance(instance.id)?.resolved}
                character={character}
                weapon={weapon}
                {...(grip ? { grip } : {})}
              />
            ) : (
              <ProceduralCharacter
                pose={engine.poseOf(instance.id)}
                character={character}
                weapon={weapon}
                // Colour by intent source, so "which one am I driving?" is
                // answerable without reading the inspector.
                color={instance.intentSource.kind === 'local-input' ? '#7dd3fc' : '#c4b5fd'}
              />
            )}
          </group>
          );
        })}

      {selectedId && <SelectionRing engine={engine} instanceId={selectedId} />}
    </Canvas>
  );
}

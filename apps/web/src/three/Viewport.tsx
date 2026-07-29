import { useEffect, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { detectCapability, readActiveGamepad } from '@atc/haptics-runtime';
import { useChamber } from '../store.ts';
import type { ChamberEngine } from '../engine.ts';
import { Character } from './Character.tsx';
import { TerrainMesh } from './TerrainMesh.tsx';
import { DebugOverlays } from './DebugOverlays.tsx';
import { characterPreset, motionSet } from './catalog.ts';

/** Advances the simulation from render deltas and keeps the camera behind the character. */
function ChamberLoop({ engine }: { engine: ChamberEngine }) {
  const { camera } = useThree();
  const smoothed = useRef(new THREE.Vector3(0, 3, -6));

  useFrame((_, delta) => {
    engine.advance(delta);

    const profile = engine.currentProject.camera;
    const state = engine.simulationState;
    const { yaw, pitch } = engine.camera;

    const target = new THREE.Vector3(
      state.position.x - Math.sin(yaw) * profile.distance * Math.cos(pitch),
      state.position.y + profile.height + Math.sin(pitch) * profile.distance,
      state.position.z - Math.cos(yaw) * profile.distance * Math.cos(pitch),
    );

    // Exponential smoothing expressed as a time constant, so the lag value in
    // canonical data means the same thing at any frame rate.
    const alpha = profile.followLagSec <= 0 ? 1 : 1 - Math.exp(-delta / profile.followLagSec);
    smoothed.current.lerp(target, alpha);
    camera.position.copy(smoothed.current);
    camera.lookAt(state.position.x, state.position.y + profile.lookAtHeight, state.position.z);
  });

  return null;
}

export function Viewport() {
  const engine = useChamber((state) => state.engine);
  const terrainPresetId = useChamber((state) => state.terrainPresetId);
  const ghostEnabled = useChamber((state) => state.ghostEnabled);
  const refreshCapability = useChamber((state) => state.refreshCapability);
  const characterPresetId = useChamber((state) => state.characterPresetId);
  const motionSetId = useChamber((state) => state.motionSetId);
  const character = characterPreset(characterPresetId);
  const motion = motionSet(motionSetId);

  useEffect(() => {
    engine.attachInput();
    return () => engine.detachInput();
  }, [engine]);

  // Gamepad capability is only knowable after a device announces itself.
  useEffect(() => {
    const update = (): void => {
      engine.refreshHapticCapability();
      refreshCapability(detectCapability(readActiveGamepad()));
    };
    update();
    window.addEventListener('gamepadconnected', update);
    window.addEventListener('gamepaddisconnected', update);
    const interval = window.setInterval(update, 2000);
    return () => {
      window.removeEventListener('gamepadconnected', update);
      window.removeEventListener('gamepaddisconnected', update);
      window.clearInterval(interval);
    };
  }, [engine, refreshCapability]);

  return (
    <Canvas
      shadows
      dpr={[1, 2]}
      camera={{ fov: engine.currentProject.camera.fovDeg, position: [0, 3, -6] }}
      data-testid="viewport-canvas"
    >
      <color attach="background" args={['#0b1120']} />
      <fog attach="fog" args={['#0b1120', 25, 70]} />

      {/*
        Terrain debugging is a core workflow, so upward-facing surfaces need to
        be readable: a hemisphere fill lights step treads and slope faces that a
        single directional light leaves in near-black.
      */}
      <ambientLight intensity={0.5} />
      <hemisphereLight args={['#93b4d8', '#0b1120', 0.9]} />
      <directionalLight
        position={[8, 14, 6]}
        intensity={1.1}
        castShadow
        shadow-mapSize={[1024, 1024]}
      />

      <ChamberLoop engine={engine} />
      <TerrainMesh key={terrainPresetId} preset={engine.terrainPreset} engine={engine} />
      <Character engine={engine} character={character} motion={motion} />
      {ghostEnabled && <Character engine={engine} ghost color="#f472b6" motion={motion} />}
      <DebugOverlays engine={engine} />
    </Canvas>
  );
}

import { useEffect, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { detectCapability, readActiveGamepad } from '@atc/haptics-runtime';
import { useChamber, useCharacterPresentation } from '../store.ts';
import type { ChamberEngine } from '../engine.ts';
import { Character } from './Character.tsx';
import { TerrainMesh } from './TerrainMesh.tsx';
import { DebugOverlays } from './DebugOverlays.tsx';
import { weaponMode } from './catalog.ts';
import { resolveWeaponGrip } from '../rig-editor/resolve-character-presentation.ts';

/** Advances the simulation from render deltas and keeps the camera behind the character. */
function ChamberLoop({ engine }: { engine: ChamberEngine }) {
  const { camera } = useThree();
  const smoothed = useRef(new THREE.Vector3(0, 3, -6));

  useFrame((_, delta) => {
    // While a test driver owns simulation advancement (window.__ATC_TEST__),
    // wall-clock deltas must not also advance it — that would race the
    // deterministic ticks the test is asserting against.
    if (!engine.testDriven) engine.advance(delta);

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
  const weaponModeId = useChamber((state) => state.weaponModeId);
  const weaponGripOverrides = useChamber((state) => state.weaponGripOverrides);
  const gripEditorMode = useChamber((state) => state.gripEditorMode);
  const saveWeaponGrip = useChamber((state) => state.saveWeaponGrip);
  /*
   * The route Character's presentation — model binding and canonical takes. The
   * Viewport used to read `characterPresetId` here, which is why navigating to
   * another Character could leave the previous model on screen: the header and
   * the document changed, and this line did not.
   */
  const presentation = useCharacterPresentation();
  const weapon = weaponMode(weaponModeId);
  const grip = resolveWeaponGrip({
    model: presentation.model.effective,
    weaponModeId: weapon.id,
    // Grip overrides are keyed by canonical Character id, not by preset id: a
    // grip belongs to the Character whose hand it is in.
    sessionOverride: weaponGripOverrides[`${presentation.characterId}:${weapon.id}`],
  });

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
      {/*
        Keyed by Character id *and* effective model, so switching either builds a
        fresh renderer rather than reusing the previous one's mixer, cloned
        skeleton and attachment state (§9.2).
      */}
      <Character
        key={`${presentation.characterId}:${presentation.model.effective.kind === 'repository-model' ? presentation.model.effective.assetPath : presentation.model.effective.presetId}`}
        engine={engine}
        presentation={presentation}
        weapon={weapon}
        grip={grip}
        gripEditorMode={gripEditorMode}
        onGripChange={(nextGrip) => saveWeaponGrip(presentation.characterId, weapon.id, nextGrip)}
      />
      {ghostEnabled && <Character engine={engine} ghost color="#f472b6" weapon={weapon} />}
      <DebugOverlays engine={engine} />
    </Canvas>
  );
}

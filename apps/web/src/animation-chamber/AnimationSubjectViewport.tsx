/**
 * The subject's body, drawn.
 *
 * Structurally the donor's `Viewport`, with one substitution: where that read
 * `useCharacterPresentation()` — the route Character's model and takes — this
 * reads the subject's presentation, resolved from the exact Prefab Component
 * that owns it. `Character`, `TerrainMesh` and `DebugOverlays` are reused
 * unchanged, because what they draw was never a Character; it was a model
 * binding and a simulation, and both survive the change of owner.
 *
 * One canvas, and it is this one. When the viewport is mounted it owns
 * simulation advancement through `useFrame`, and the shell's rAF clock stands
 * down — two drivers on one fixed-step accumulator would run every tick twice.
 */
import { useEffect, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { detectCapability, readActiveGamepad } from '@atc/haptics-runtime';
import type { ChamberEngine } from '../engine.ts';
import { Character } from '../three/Character.tsx';
import { TerrainMesh } from '../three/TerrainMesh.tsx';
import { DebugOverlays } from '../three/DebugOverlays.tsx';
import { WEAPON_MODES, weaponMode } from '../three/catalog.ts';
import { resolveWeaponGrip } from '../rig-editor/resolve-character-presentation.ts';
import { useAnimationChamber } from './useAnimationChamber.ts';
import { resolveAnimationSubjectPresentation } from './resolve-subject-presentation.ts';

/**
 * What a context the presentation catalogue does not know looks like.
 *
 * Empty hands and its own id, so the viewport neither invents a held item nor
 * pretends the context is `unarmed`. The animation for it still plays: clips
 * come from the Motion Set's contextual bindings, which are keyed by the same
 * id and need no catalogue entry.
 */
const UNKNOWN_CONTEXT_PRESENTATION = { id: 'unknown-context', label: 'Unknown context' };

/** Advances the simulation from render deltas and trails the camera. */
function SubjectLoop({ engine }: { engine: ChamberEngine }): null {
  const { camera } = useThree();
  const smoothed = useRef(new THREE.Vector3(0, 3, -6));

  useFrame((_, delta) => {
    // While a test driver owns advancement, wall-clock deltas must not also
    // advance it — that races the deterministic ticks the test asserts on.
    if (!engine.testDriven) engine.advance(delta);

    const profile = engine.currentProject.camera;
    const state = engine.simulationState;
    const { yaw, pitch } = engine.camera;

    const target = new THREE.Vector3(
      state.position.x - Math.sin(yaw) * profile.distance * Math.cos(pitch),
      state.position.y + profile.height + Math.sin(pitch) * profile.distance,
      state.position.z - Math.cos(yaw) * profile.distance * Math.cos(pitch),
    );

    // Exponential smoothing as a time constant, so the canonical lag value
    // means the same thing at any frame rate.
    const alpha = profile.followLagSec <= 0 ? 1 : 1 - Math.exp(-delta / profile.followLagSec);
    smoothed.current.lerp(target, alpha);
    camera.position.copy(smoothed.current);
    camera.lookAt(state.position.x, state.position.y + profile.lookAtHeight, state.position.z);
  });

  return null;
}

export function AnimationSubjectViewport(): JSX.Element | null {
  const engine = useAnimationChamber((state) => state.engine);
  const document = useAnimationChamber((state) => state.project);
  const motionContextId = useAnimationChamber((state) => state.motionContextId);

  const refreshCapability = useAnimationChamber((state) => state.refreshCapability);
  const ghostEnabled = useAnimationChamber((state) => state.ghostEnabled);
  const activePanel = useAnimationChamber((state) => state.activePanel);
  const previewWorld = useAnimationChamber((state) => state.previewWorld);

  const presentation = resolveAnimationSubjectPresentation({ document, motionContextId });
  /*
   * The held item is presentation, and the catalogue is the only thing that
   * knows about it. A Motion Set may bind a context the catalogue has never
   * heard of — that is data, and its *animation* resolves fine — but there is
   * no authored item to put in the hand, and `weaponMode`'s fallback would put
   * the unarmed one there as though it had been chosen.
   */
  const knownContext = WEAPON_MODES.some((mode) => mode.id === motionContextId);
  const context = knownContext ? weaponMode(motionContextId) : UNKNOWN_CONTEXT_PRESENTATION;
  const grip =
    presentation && knownContext
      ? resolveWeaponGrip({ model: presentation.model.effective, weaponModeId: context.id })
      : undefined;

  useEffect(() => {
    const update = (): void => {
      engine.refreshHapticCapability();
      // The result is the panel's only source of truth for the device table;
      // discarding it left the Haptics panel describing a device that had been
      // unplugged.
      refreshCapability(detectCapability(readActiveGamepad()));
    };
    update();
    window.addEventListener('gamepadconnected', update);
    window.addEventListener('gamepaddisconnected', update);
    return () => {
      window.removeEventListener('gamepadconnected', update);
      window.removeEventListener('gamepaddisconnected', update);
    };
  }, [engine, refreshCapability]);

  // No body to draw: the header already says which requirement is missing, and
  // an empty canvas would say it worse.
  if (!presentation) return null;

  const effective = presentation.model.effective;
  return (
    <Canvas
      shadows
      dpr={[1, 2]}
      camera={{ fov: engine.currentProject.camera.fovDeg, position: [0, 3, -6] }}
      data-testid="viewport-canvas"
    >
      <color attach="background" args={['#0b1120']} />
      <fog attach="fog" args={['#0b1120', 25, 70]} />

      <ambientLight intensity={0.5} />
      <hemisphereLight args={['#93b4d8', '#0b1120', 0.9]} />
      <directionalLight
        position={[8, 14, 6]}
        intensity={1.1}
        castShadow
        shadow-mapSize={[1024, 1024]}
      />

      <SubjectLoop engine={engine} />
      <TerrainMesh preset={engine.terrainPreset} engine={engine} />
      {/*
        Keyed by subject id *and* effective model, so switching either builds a
        fresh renderer rather than reusing the previous one's mixer, cloned
        skeleton and attachment state.
      */}
      {(activePanel === 'world' ? previewWorld.instances : [{ id: 'focused', enabled: true, position: { x: 0, y: 0, z: 0 }, yawDeg: 0 }])
        .filter((instance) => instance.enabled)
        .map((instance) => (
          <group key={instance.id} position={[instance.position.x, instance.position.y, instance.position.z]} rotation-y={THREE.MathUtils.degToRad(instance.yawDeg)}>
            <Character
              key={`${presentation.characterId}:${instance.id}:${
                effective.kind === 'repository-model' ? effective.assetPath : effective.presetId
              }`}
              engine={engine}
              presentation={presentation}
              weapon={context}
              grip={grip}
            />
          </group>
        ))}
      {/*
        The ghost is a second *body* in this scene, never a second scene. It
        reads the same engine's ghost trace, so there is one canvas, one
        driver and one simulation — which is what keeps before/after honest
        rather than turning it into two previews that could drift apart.
      */}
      {ghostEnabled && <Character engine={engine} ghost color="#f472b6" weapon={context} />}
      <DebugOverlays engine={engine} />
    </Canvas>
  );
}

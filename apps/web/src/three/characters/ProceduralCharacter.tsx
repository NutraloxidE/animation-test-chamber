import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { ChamberEngine } from '../../engine.ts';
import type { WeaponMode } from '../catalog.ts';
import { proceduralAppearance } from '../catalog.ts';
import { HeldSword } from './HeldSword.tsx';

/**
 * Everything the procedural rig needs in order to strike a pose.
 *
 * Extracted so the same meshes can be driven by a world instance as by the
 * focused engine. The alternative — a second procedural character for the
 * multi-instance viewport — would have meant two rigs drifting apart while both
 * claimed to show the same state machine.
 */
export interface CharacterPose {
  position: { x: number; y: number; z: number };
  yawRad: number;
  locomotionState: string;
  actionState: string;
  locomotionNormalizedTime: number;
  actionNormalizedTime: number;
  pelvisOffset: number;
}

interface ProceduralCharacterProps {
  engine?: ChamberEngine;
  /** Per-frame pose. When present, the engine is not read at all. */
  pose?: () => CharacterPose | null;
  /** Ghost characters are translucent and driven by a stored trace. */
  ghost?: boolean;
  color?: string;
  /**
   * The authored appearance id from `CharacterModelBinding.presetId`. Absent for
   * a ghost or a world instance, which are coloured by role rather than by
   * Character identity.
   */
  presetId?: string;
  weapon: WeaponMode;
}

/**
 * Procedural stand-in character (PLAN 2.1: the chamber must boot with no assets).
 *
 * The pose is derived from the active state's normalized time rather than from
 * skinned clip data, so the state machine, blending and foot timing are all
 * visible without a single GLB in the repository. A real character replaces the
 * meshes; the driving values stay the same.
 */
export function ProceduralCharacter({
  engine,
  pose,
  ghost = false,
  color,
  presetId,
  weapon,
}: ProceduralCharacterProps) {
  const root = useRef<THREE.Group>(null);
  const hips = useRef<THREE.Group>(null);
  const legL = useRef<THREE.Mesh>(null);
  const legR = useRef<THREE.Mesh>(null);
  const armL = useRef<THREE.Mesh>(null);
  const armR = useRef<THREE.Mesh>(null);
  const torso = useRef<THREE.Mesh>(null);

  useFrame(() => {
    const group = root.current;
    if (!group) return;

    let position: { x: number; y: number; z: number };
    let yaw: number;
    let normalized: number;
    let stateId: string;
    let actionState: string;
    let actionNormalized: number;
    let pelvisOffset: number;

    if (pose) {
      const current = pose();
      if (!current) {
        group.visible = false;
        return;
      }
      group.visible = true;
      position = current.position;
      yaw = current.yawRad;
      normalized = current.locomotionNormalizedTime;
      stateId = current.locomotionState;
      actionState = current.actionState;
      actionNormalized = current.actionNormalizedTime;
      pelvisOffset = current.pelvisOffset;
    } else if (ghost) {
      const trace = engine!.ghostTrace;
      if (!trace || trace.ticks.length === 0) {
        group.visible = false;
        return;
      }
      group.visible = true;
      const record = trace.ticks[engine!.ghostTick % trace.ticks.length]!;
      position = record.position;
      yaw = record.yawRad;
      normalized = record.locomotionNormalizedTime;
      stateId = record.locomotionState;
      actionState = record.actionState;
      actionNormalized = record.actionNormalizedTime;
      pelvisOffset = record.pelvisOffset;
    } else {
      const state = engine!.simulationState;
      const record = engine!.lastRecord;
      position = state.position;
      yaw = state.yawRad;
      normalized = record?.locomotionNormalizedTime ?? 0;
      stateId = record?.locomotionState ?? 'idle';
      actionState = record?.actionState ?? 'action-none';
      actionNormalized = record?.actionNormalizedTime ?? 0;
      pelvisOffset = record?.pelvisOffset ?? 0;
    }

    group.position.set(position.x, position.y, position.z);
    group.rotation.y = yaw;

    const phase = normalized * Math.PI * 2;
    const moving = stateId === 'walk' || stateId === 'run';
    const airborne = stateId === 'jump' || stateId === 'fall';
    const swing = stateId === 'run' ? 0.9 : stateId === 'walk' ? 0.45 : 0;

    if (hips.current) {
      // Vertical bob on the double-frequency of the stride, plus the IK pelvis drop.
      const bob = moving ? Math.abs(Math.sin(phase)) * 0.05 : 0;
      hips.current.position.y = 0.95 + bob + pelvisOffset;
    }

    if (legL.current && legR.current) {
      legL.current.rotation.x = airborne ? -0.4 : Math.sin(phase) * swing;
      legR.current.rotation.x = airborne ? 0.2 : Math.sin(phase + Math.PI) * swing;
    }

    if (armL.current && armR.current) {
      // The action layer owns the arms: attacks and guard override the swing.
      if (actionState === 'attack-01' || actionState === 'attack-02') {
        const strike = Math.sin(Math.min(actionNormalized, 1) * Math.PI);
        armR.current.rotation.x = -2.2 * strike;
        armL.current.rotation.x = 0.6 * strike;
      } else if (actionState === 'guard') {
        armR.current.rotation.x = -1.4;
        armL.current.rotation.x = -1.4;
      } else if (actionState === 'dodge') {
        armR.current.rotation.x = -0.9;
        armL.current.rotation.x = -0.9;
      } else {
        armL.current.rotation.x = airborne ? -0.8 : Math.sin(phase + Math.PI) * swing * 0.7;
        armR.current.rotation.x = airborne ? -0.8 : Math.sin(phase) * swing * 0.7;
      }
    }

    if (torso.current) {
      torso.current.rotation.x = stateId === 'run' ? 0.14 : stateId === 'slide' ? 0.35 : 0.04;
    }
  });

  const opacity = ghost ? 0.28 : 1;

  // The appearance is looked up from the authored id; it is never chosen here.
  const appearance = presetId === undefined ? undefined : proceduralAppearance(presetId);
  const bodyColor = color ?? appearance?.color ?? '#7dd3fc';
  const legsColor = appearance?.legColor ?? '#38bdf8';

  return (
    <group ref={root} scale={[appearance?.scale ?? 1, appearance?.scale ?? 1, appearance?.scale ?? 1]}>
      <group ref={hips} position={[0, 0.95, 0]}>
        <mesh ref={torso} position={[0, 0.25, 0]} castShadow={!ghost}>
          <capsuleGeometry args={[0.17, 0.42, 4, 12]} />
          <meshStandardMaterial color={bodyColor} transparent={ghost} opacity={opacity} />
        </mesh>

        <mesh position={[0, 0.72, 0]} castShadow={!ghost}>
          <sphereGeometry args={[0.14, 16, 12]} />
          <meshStandardMaterial color={bodyColor} transparent={ghost} opacity={opacity} />
        </mesh>

        {/* Facing marker so rotation is readable at a glance. */}
        <mesh position={[0, 0.72, 0.13]}>
          <boxGeometry args={[0.06, 0.04, 0.06]} />
          <meshStandardMaterial color="#0f172a" transparent={ghost} opacity={opacity} />
        </mesh>

        <mesh ref={armL} position={[-0.24, 0.4, 0]} castShadow={!ghost}>
          <capsuleGeometry args={[0.055, 0.34, 4, 8]} />
          <meshStandardMaterial color={bodyColor} transparent={ghost} opacity={opacity} />
        </mesh>
        <mesh ref={armR} position={[0.24, 0.4, 0]} castShadow={!ghost}>
          <capsuleGeometry args={[0.055, 0.34, 4, 8]} />
          <meshStandardMaterial color={bodyColor} transparent={ghost} opacity={opacity} />
          {weapon.heldItem === 'sword' && (
            <group position={[0, -0.28, 0]} rotation={[0, 0, Math.PI]}>
              <HeldSword />
            </group>
          )}
        </mesh>

        <mesh ref={legL} position={[-0.1, -0.42, 0]} castShadow={!ghost}>
          <capsuleGeometry args={[0.07, 0.46, 4, 8]} />
          <meshStandardMaterial color={legsColor} transparent={ghost} opacity={opacity} />
        </mesh>
        <mesh ref={legR} position={[0.1, -0.42, 0]} castShadow={!ghost}>
          <capsuleGeometry args={[0.07, 0.46, 4, 8]} />
          <meshStandardMaterial color={legsColor} transparent={ghost} opacity={opacity} />
        </mesh>
      </group>
    </group>
  );
}

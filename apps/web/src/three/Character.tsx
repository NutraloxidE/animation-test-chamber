import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import type { ChamberEngine } from '../engine.ts';
import type { CharacterPreset, MotionSet } from './catalog.ts';

interface CharacterProps {
  engine: ChamberEngine;
  /** Ghost characters are translucent and driven by a stored trace. */
  ghost?: boolean;
  color?: string;
  character?: CharacterPreset;
  motion: MotionSet;
}

/**
 * Procedural stand-in character (PLAN 2.1: the chamber must boot with no assets).
 *
 * The pose is derived from the active state's normalized time rather than from
 * skinned clip data, so the state machine, blending and foot timing are all
 * visible without a single GLB in the repository. A real character replaces the
 * meshes; the driving values stay the same.
 */
export function Character({ engine, ghost = false, color, character, motion }: CharacterProps) {
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
    let pelvisOffset: number;

    if (ghost) {
      const trace = engine.ghostTrace;
      if (!trace || trace.ticks.length === 0) {
        group.visible = false;
        return;
      }
      group.visible = true;
      const record = trace.ticks[engine.ghostTick % trace.ticks.length]!;
      position = record.position;
      yaw = record.yawRad;
      normalized = record.locomotionNormalizedTime;
      stateId = record.locomotionState;
      actionState = record.actionState;
      pelvisOffset = record.pelvisOffset;
    } else {
      const state = engine.simulationState;
      const record = engine.lastRecord;
      position = state.position;
      yaw = state.yawRad;
      normalized = record?.locomotionNormalizedTime ?? 0;
      stateId = record?.locomotionState ?? 'idle';
      actionState = record?.actionState ?? 'action-none';
      pelvisOffset = record?.pelvisOffset ?? 0;
    }

    group.position.set(position.x, position.y, position.z);
    group.rotation.y = yaw;

    const phase = normalized * Math.PI * 2;
    const moving = stateId === 'walk' || stateId === 'run';
    const airborne = stateId === 'jump' || stateId === 'fall';
    const swing = (stateId === 'run' ? 0.9 : stateId === 'walk' ? 0.45 : 0) * motion.stride;

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
        const t = engine.lastRecord?.actionNormalizedTime ?? 0;
        const strike = Math.sin(Math.min(t, 1) * Math.PI);
        armR.current.rotation.x = -2.2 * strike;
        armL.current.rotation.x = 0.6 * strike;
      } else if (actionState === 'guard') {
        armR.current.rotation.x = -1.4;
        armL.current.rotation.x = -1.4;
      } else if (actionState === 'dodge') {
        armR.current.rotation.x = -0.9;
        armL.current.rotation.x = -0.9;
      } else {
        armL.current.rotation.x = airborne ? -0.8 : Math.sin(phase + Math.PI) * swing * 0.7 * motion.armSwing;
        armR.current.rotation.x = airborne ? -0.8 : Math.sin(phase) * swing * 0.7 * motion.armSwing;
      }
    }

    if (torso.current) {
      torso.current.rotation.x = (stateId === 'run' ? 0.14 : stateId === 'slide' ? 0.35 : 0.04) * motion.torsoLean;
    }
  });

  const opacity = ghost ? 0.28 : 1;

  const bodyColor = color ?? character?.color ?? '#7dd3fc';
  const legsColor = character?.legColor ?? '#38bdf8';

  if (!ghost && character?.modelUrl) {
    return <GltfCharacter engine={engine} character={character} motion={motion} />;
  }

  return (
    <group ref={root} scale={[character?.scale ?? 1, character?.scale ?? 1, character?.scale ?? 1]}>
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

const CLIP_FOR_STATE: Record<string, string> = {
  idle: 'HumanArmature|Idle',
  walk: 'HumanArmature|Walking',
  run: 'HumanArmature|Run',
  jump: 'HumanArmature|Jump',
  fall: 'HumanArmature|Jump',
  dodge: 'HumanArmature|Roll',
  'attack-01': 'HumanArmature|Run_swordAttack',
  'attack-02': 'HumanArmature|swordAttackJump',
};

function GltfCharacter({
  engine,
  character,
  motion,
}: {
  engine: ChamberEngine;
  character: CharacterPreset;
  motion: MotionSet;
}) {
  const root = useRef<THREE.Group>(null);
  const { scene: model } = useGLTF(character.modelUrl!);
  const animationUrl =
    (character.animationUrl ? motion.animationUrl : undefined) ?? character.animationUrl ?? character.modelUrl!;
  const { animations: sourceAnimations } = useGLTF(animationUrl);
  const animations = useMemo(() => {
    if (animationUrl === character.modelUrl) return sourceAnimations;

    const wanted = new Set(
      Object.values((character.animationUrl ? motion.clipMap : undefined) ?? character.clipMap ?? {}),
    );
    return sourceAnimations
      .filter((clip) => wanted.has(clip.name))
      .map((sourceClip) => {
        const retargeted = sourceClip.clone();
        // Chamber movement owns translation; retain only the clip's bone rotations.
        retargeted.tracks = retargeted.tracks.filter((track) => !(track instanceof THREE.VectorKeyframeTrack));
        return retargeted;
      });
  }, [animationUrl, character.clipMap, character.modelUrl, motion.clipMap, sourceAnimations]);
  const mixer = useMemo(() => new THREE.AnimationMixer(model), [model]);
  const currentClip = useRef('');

  useEffect(() => {
    model.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.castShadow = true;
        object.receiveShadow = true;
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) {
          material.side = THREE.DoubleSide;
        }
      }
    });
    return () => {
      mixer.stopAllAction();
    };
  }, [mixer, model]);

  useFrame((_, delta) => {
    const group = root.current;
    if (!group) return;
    const state = engine.simulationState;
    const record = engine.lastRecord;
    group.position.set(state.position.x, state.position.y, state.position.z);
    group.rotation.y = state.yawRad + (character.modelRotationY ?? 0);

    const stateId = record?.actionState && record.actionState !== 'action-none'
      ? record.actionState
      : record?.locomotionState ?? 'idle';
    const clipMap = (character.animationUrl ? motion.clipMap : undefined) ?? character.clipMap ?? CLIP_FOR_STATE;
    const clipName = clipMap[stateId] ?? clipMap.idle ?? CLIP_FOR_STATE.idle!;
    if (clipName !== currentClip.current) {
      mixer.stopAllAction();
      const clip = animations.find((animation) => animation.name === clipName);
      if (clip) mixer.clipAction(clip, model).reset().fadeIn(0.12).play();
      currentClip.current = clipName;
    }
    mixer.update(delta);
  });

  const scale = character.modelScale ?? 1;
  return (
    <group ref={root}>
      <group scale={[scale, scale, scale]}>
        <primitive object={model} />
      </group>
    </group>
  );
}

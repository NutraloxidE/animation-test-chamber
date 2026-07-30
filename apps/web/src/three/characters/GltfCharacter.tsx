import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import {
  DODGE_RECOVERY_BLEND_SEC,
  isDodgeRecoveryTransition,
} from '@atc/animation-runtime';
import * as THREE from 'three';
import type { ChamberEngine } from '../../engine.ts';
import type { CharacterPreset, MotionSet } from '../catalog.ts';

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

export function GltfCharacter({
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
    (character.animationUrl ? motion.animationUrl : undefined) ??
    character.animationUrl ??
    character.modelUrl!;
  const { animations: sourceAnimations } = useGLTF(animationUrl);
  const animations = useMemo(() => {
    if (animationUrl === character.modelUrl) return sourceAnimations;

    const wanted = new Set(
      Object.values(
        (character.animationUrl ? motion.clipMap : undefined) ?? character.clipMap ?? {},
      ),
    );
    return sourceAnimations
      .filter((clip) => wanted.has(clip.name))
      .map((sourceClip) => {
        const retargeted = sourceClip.clone();
        // Chamber movement owns the world root, but bone-local translation is
        // pose data: Quaternius' pelvis track keeps the roll on the ground.
        retargeted.tracks = retargeted.tracks.filter(
          (track) => track.name !== 'root.position',
        );
        for (const track of retargeted.tracks) {
          if (
            !(track instanceof THREE.VectorKeyframeTrack) ||
            !track.name.endsWith('.position')
          ) {
            continue;
          }
          const scale = character.animationPositionScale ?? 1;
          for (let index = 0; index < track.values.length; index += 1) {
            track.values[index] = track.values[index]! * scale;
          }
        }
        return retargeted;
      });
  }, [
    animationUrl,
    character.animationPositionScale,
    character.clipMap,
    character.modelUrl,
    motion.clipMap,
    sourceAnimations,
  ]);
  const mixer = useMemo(() => new THREE.AnimationMixer(model), [model]);
  const currentClip = useRef('');
  const currentAction = useRef<THREE.AnimationAction | null>(null);

  useEffect(() => {
    model.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.castShadow = true;
        object.receiveShadow = true;
        const materials = Array.isArray(object.material)
          ? object.material
          : [object.material];
        for (const material of materials) material.side = THREE.DoubleSide;
      }
    });
    return () => {
      mixer.stopAllAction();
      currentAction.current = null;
      currentClip.current = '';
    };
  }, [mixer, model]);

  useFrame((_, delta) => {
    const group = root.current;
    if (!group) return;
    const state = engine.simulationState;
    const record = engine.lastRecord;
    group.position.set(state.position.x, state.position.y, state.position.z);
    group.rotation.y = state.yawRad + (character.modelRotationY ?? 0);

    const actionState = engine.currentProject.graph.states.find(
      (entry) => entry.id === record?.actionState,
    );
    const actionClip = engine.currentProject.clips.find(
      (entry) => entry.id === actionState?.clipId,
    );
    const dodgeRecovery =
      record !== null &&
      isDodgeRecoveryTransition(
        record.actionState,
        record.actionNormalizedTime,
        record.locomotionState,
        actionClip?.recoveryTransitionStartNormalized,
      );
    const actionActive =
      record !== null && record.actionState !== 'action-none' && !dodgeRecovery;
    const stateId = actionActive
      ? record.actionState
      : (record?.locomotionState ?? 'idle');
    const normalizedTime = actionActive
      ? record.actionNormalizedTime
      : (record?.locomotionNormalizedTime ?? 0);
    const clipMap =
      (character.animationUrl ? motion.clipMap : undefined) ??
      character.clipMap ??
      CLIP_FOR_STATE;
    const clipName = clipMap[stateId] ?? clipMap.idle ?? CLIP_FOR_STATE.idle!;
    if (clipName !== currentClip.current) {
      const clip = animations.find((animation) => animation.name === clipName);
      if (clip) {
        const loop =
          engine.currentProject.graph.states.find((state) => state.id === stateId)
            ?.loop ?? true;
        const nextAction = mixer
          .clipAction(clip, model)
          .reset()
          .setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1)
          .play();
        nextAction.clampWhenFinished = !loop;
        currentAction.current?.crossFadeTo(
          nextAction,
          dodgeRecovery ? DODGE_RECOVERY_BLEND_SEC : 0.12,
          false,
        );
        currentAction.current = nextAction;
        currentClip.current = clipName;
      }
    }
    mixer.update(delta);
    if (currentAction.current && currentClip.current === clipName) {
      currentAction.current.time =
        normalizedTime * currentAction.current.getClip().duration;
      mixer.update(0);
    }
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

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal, useFrame } from '@react-three/fiber';
import { TransformControls, useGLTF } from '@react-three/drei';
import {
  DODGE_RECOVERY_BLEND_SEC,
  isDodgeRecoveryTransition,
} from '@atc/animation-runtime';
import * as THREE from 'three';
import type { ChamberEngine } from '../../engine.ts';
import type {
  CharacterPreset,
  MotionSet,
  WeaponGrip,
  WeaponMode,
} from '../catalog.ts';
import { HeldSword } from './HeldSword.tsx';

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
  weapon,
  grip,
  gripEditorMode,
  onGripChange,
}: {
  engine: ChamberEngine;
  character: CharacterPreset;
  motion: MotionSet;
  weapon: WeaponMode;
  grip?: WeaponGrip;
  gripEditorMode?: 'translate' | 'rotate' | null;
  onGripChange?(grip: WeaponGrip): void;
}) {
  const root = useRef<THREE.Group>(null);
  const [heldWeapon, setHeldWeapon] = useState<THREE.Group | null>(null);
  const { scene: model } = useGLTF(character.modelUrl!);
  const baseAnimationUrl =
    (character.animationUrl ? motion.animationUrl : undefined) ??
    character.animationUrl ??
    character.modelUrl!;
  const weaponCompatible = Boolean(
    weapon.animationUrl && weapon.rigId === character.rigId,
  );
  const weaponAnimationUrl = weaponCompatible
    ? weapon.animationUrl!
    : baseAnimationUrl;
  const { animations: baseAnimations } = useGLTF(baseAnimationUrl);
  const { animations: weaponAnimations } = useGLTF(weaponAnimationUrl);
  const baseClipMap =
    (character.animationUrl ? motion.clipMap : undefined) ??
    character.clipMap ??
    CLIP_FOR_STATE;
  const clipMap = {
    ...baseClipMap,
    ...(weaponCompatible ? weapon.clipMap : undefined),
  };
  const animations = useMemo(() => {
    const sourceAnimations =
      baseAnimationUrl === weaponAnimationUrl
        ? baseAnimations
        : [...baseAnimations, ...weaponAnimations];
    if (baseAnimationUrl === character.modelUrl && !weaponCompatible) {
      return sourceAnimations;
    }

    const wanted = new Set(Object.values(clipMap));
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
          const scale =
            weaponAnimationUrl !== baseAnimationUrl &&
            weaponAnimations.includes(sourceClip)
              ? (weapon.animationPositionScale ?? 1)
              : (character.animationPositionScale ?? 1);
          for (let index = 0; index < track.values.length; index += 1) {
            track.values[index] = track.values[index]! * scale;
          }
        }
        return retargeted;
      });
  }, [
    baseAnimationUrl,
    baseAnimations,
    character.animationPositionScale,
    character.modelUrl,
    clipMap,
    weaponAnimationUrl,
    weapon.animationPositionScale,
    weaponAnimations,
    weaponCompatible,
  ]);
  const mixer = useMemo(() => new THREE.AnimationMixer(model), [model]);
  const currentClip = useRef('');
  const currentAction = useRef<THREE.AnimationAction | null>(null);
  /** Whether the clip on screen came from the action layer, so fading *out* of an
   * action uses that action transition's duration, not a stale locomotion one. */
  const currentClipIsAction = useRef(false);

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
      currentClipIsAction.current = false;
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
        const layer = actionActive || currentClipIsAction.current ? 'action' : 'locomotion';
        currentAction.current?.crossFadeTo(
          nextAction,
          dodgeRecovery
            ? DODGE_RECOVERY_BLEND_SEC
            : engine.graphLayers[layer].blendDurationSec,
          false,
        );
        currentAction.current = nextAction;
        currentClip.current = clipName;
        currentClipIsAction.current = actionActive;
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
  const hand = character.rightHandBone
    ? model.getObjectByName(character.rightHandBone)
    : undefined;
  return (
    <>
      <group ref={root}>
        <group scale={[scale, scale, scale]}>
          <primitive object={model} />
        </group>
        {weapon.heldItem === 'sword' &&
          hand &&
          grip &&
          createPortal(
            <group
              ref={setHeldWeapon}
              position={grip.position}
              rotation={grip.rotation}
            >
              <HeldSword />
            </group>,
            hand,
          )}
      </group>
      {gripEditorMode && heldWeapon && (
        <TransformControls
          object={heldWeapon}
          mode={gripEditorMode}
          space="local"
          size={0.45}
          translationSnap={0.005}
          rotationSnap={THREE.MathUtils.degToRad(1)}
          onMouseDown={() => engine.detachInput()}
          onMouseUp={() => {
            engine.attachInput();
            onGripChange?.({
              position: heldWeapon.position.toArray(),
              rotation: [
                heldWeapon.rotation.x,
                heldWeapon.rotation.y,
                heldWeapon.rotation.z,
              ],
            });
          }}
        />
      )}
    </>
  );
}

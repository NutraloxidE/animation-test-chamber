import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal, useFrame } from '@react-three/fiber';
import { TransformControls, useGLTF } from '@react-three/drei';
import {
  DODGE_RECOVERY_BLEND_SEC,
  isDodgeRecoveryTransition,
} from '@atc/animation-runtime';
import type { RootMotionTrack } from '@atc/replay-runtime';
import type { ResolvedProject } from '@atc/schema';
import * as THREE from 'three';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { ChamberEngine } from '../../engine.ts';
import type { WorldChamberEngine } from '../../world/world-engine.ts';
import type { CharacterPreset, WeaponGrip, WeaponMode } from '../catalog.ts';
import type { CharacterPose } from './ProceduralCharacter.tsx';
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

/**
 * Cross-fade used when no engine owns the blend clock.
 *
 * ponytail: fixed value in pose mode. The world runtime does not surface a
 * per-instance blend duration; read it from there if the blends ever need to
 * match the authored layer timings exactly.
 */
const POSE_MODE_BLEND_SEC = 0.12;

export function GltfCharacter({
  engine,
  worldEngine,
  instanceId,
  pose,
  poseProject,
  character,
  weapon,
  grip,
  gripEditorMode,
  onGripChange,
}: {
  /** Isolate view: the model reads the focused engine directly. */
  engine?: ChamberEngine;
  /** World view: where this instance's root motion tuning is pushed. */
  worldEngine?: WorldChamberEngine;
  instanceId?: string;
  /** World view: a per-frame pose closure, one per instance. */
  pose?: () => CharacterPose | null;
  /**
   * World view: the document the pose was simulated from. Without it the clip,
   * loop and blend choices below fall back to the hardcoded table, so authored
   * motion bindings and blend timings only ever apply in Isolate.
   */
  poseProject?: ResolvedProject;
  character: CharacterPreset;
  weapon: WeaponMode;
  grip?: WeaponGrip;
  gripEditorMode?: 'translate' | 'rotate' | null;
  onGripChange?(grip: WeaponGrip): void;
}) {
  const root = useRef<THREE.Group>(null);
  const [heldWeapon, setHeldWeapon] = useState<THREE.Group | null>(null);
  const { scene: cached } = useGLTF(character.modelUrl!);
  // `useGLTF` caches one scene per URL, and a three object can only have one
  // parent: without a per-component clone the second instance steals the mesh
  // from the first and both end up half-drawn. `SkeletonUtils.clone` is the
  // skinned-mesh-safe copy — `Object3D.clone` leaves the bones pointing at the
  // original skeleton.
  const model = useMemo(() => skeletonClone(cached), [cached]);
  const baseAnimationUrl = character.animationUrl ?? character.modelUrl!;
  const weaponCompatible = Boolean(
    weapon.animationUrl && weapon.rigId === character.rigId,
  );
  const weaponAnimationUrl = weaponCompatible
    ? weapon.animationUrl!
    : baseAnimationUrl;
  const { animations: baseAnimations } = useGLTF(baseAnimationUrl);
  const { animations: weaponAnimations } = useGLTF(weaponAnimationUrl);
  const baseClipMap = character.clipMap ?? CLIP_FOR_STATE;
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
  const actionRootMotionTracks = useMemo(() => {
    if (!weaponCompatible || !weapon.usesAttackRootMotion) return {};
    const tracks: Record<string, RootMotionTrack> = {};
    for (const [stateId, clipName] of Object.entries(weapon.clipMap ?? {})) {
      const clip = weaponAnimations.find((animation) => animation.name === clipName);
      const rootTrack = clip?.tracks.find(
        (track): track is THREE.VectorKeyframeTrack =>
          track instanceof THREE.VectorKeyframeTrack && track.name === 'root.position',
      );
      if (!clip || !rootTrack || rootTrack.times.length === 0) continue;
      const scale = weapon.animationPositionScale ?? 1;
      const origin = {
        x: rootTrack.values[0]!,
        y: rootTrack.values[1]!,
        z: rootTrack.values[2]!,
      };
      tracks[stateId] = {
        times: Array.from(rootTrack.times, (time) => time / clip.duration),
        positions: Array.from(rootTrack.times, (_, index) => ({
          x: (rootTrack.values[index * 3]! - origin.x) * scale,
          y: (rootTrack.values[index * 3 + 1]! - origin.y) * scale,
          z: (rootTrack.values[index * 3 + 2]! - origin.z) * scale,
        })),
      };
    }
    return tracks;
  }, [
    weapon.animationPositionScale,
    weapon.clipMap,
    weapon.usesAttackRootMotion,
    weaponAnimations,
    weaponCompatible,
  ]);
  useEffect(() => {
    if (engine) {
      engine.setActionRootMotionTracks(actionRootMotionTracks);
      return () => engine.setActionRootMotionTracks({});
    }
    // The tracks are read out of the GLTF here, so this is the only place that
    // can hand them to the world's per-instance simulation. Without it the
    // world runs attacks with no displacement while Isolate shows the tuned
    // one, and the difference reads as "the world ignores my tuning".
    if (!worldEngine || !instanceId) return;
    const enabled = weaponCompatible && weapon.usesAttackRootMotion === true;
    worldEngine.setActionRootMotion(instanceId, { enabled, tracks: actionRootMotionTracks });
    return () => worldEngine.setActionRootMotion(instanceId, { enabled: false, tracks: {} });
  }, [
    actionRootMotionTracks,
    engine,
    instanceId,
    weapon.usesAttackRootMotion,
    weaponCompatible,
    worldEngine,
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
    // Pose mode hands the model one instance's state; engine mode reads the
    // focused simulation. Everything below this point is identical.
    const posed = pose?.() ?? null;
    if (!engine && !posed) {
      group.visible = false;
      return;
    }
    group.visible = true;
    const record = posed ?? engine!.lastRecord;
    const position = posed?.position ?? engine!.simulationState.position;
    const yawRad = posed?.yawRad ?? engine!.simulationState.yawRad;
    group.position.set(position.x, position.y, position.z);
    group.rotation.y = yawRad + (character.modelRotationY ?? 0);

    const project = engine?.currentProject ?? poseProject ?? null;
    const actionState = project?.graph.states.find((entry) => entry.id === record?.actionState);
    const locomotionState = project?.graph.states.find(
      (entry) => entry.id === record?.locomotionState,
    );
    // The state names a slot; the character's motion set says which clip that is.
    const actionClip = project?.clips.find(
      (entry) => entry.id === (actionState ? project.motionBindings[actionState.motionSlot] : ''),
    );
    const dodgeRecovery =
      record !== null &&
      isDodgeRecoveryTransition(
        actionState,
        record.actionNormalizedTime,
        locomotionState,
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
        // Without a graph to ask, actions play once and locomotion loops —
        // which is what every state in the shipped graphs declares anyway.
        const loop =
          project?.graph.states.find((state) => state.id === stateId)?.loop ?? !actionActive;
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
            : (engine?.graphLayers[layer]?.blendDurationSec ?? POSE_MODE_BLEND_SEC),
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
          onMouseDown={() => engine?.detachInput()}
          onMouseUp={() => {
            engine?.attachInput();
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

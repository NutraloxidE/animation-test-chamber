/**
 * An imported model, animated by the canonical document.
 *
 * Two things changed here, and they are the point of the work package.
 *
 * **Which clip plays is no longer this component's decision.** It used to hold a
 * `CLIP_FOR_STATE` map, merge a preset's `clipMap` over it, merge a weapon
 * mode's on top of that, and look up the resulting name by state id. So the
 * canonical Behavior chose the state and a renderer-side table chose the
 * animation — two graphs, either free to drift. (One had: the sword mode named
 * `Rig|Sword_Idle`, a take that is not in the file that mode loaded. Nothing
 * failed; the previous clip just stayed on screen.) Now the resolved
 * presentation hands over `stateId -> {file, take}`, derived from
 * `state -> motionSlot -> motion set -> clip asset`, and this file plays what it
 * is given.
 *
 * **Nothing shared is mutated.** `useGLTF` caches per URL, so the scene and its
 * clips are shared input — and the previous code scaled position tracks *in
 * place* on those cached clips and drove a mixer built on the cached scene. Two
 * Characters using one file therefore shared a skeleton, a mixer and a set of
 * progressively re-scaled tracks. Each Character now clones the scene, its
 * materials and the clips it plays, so a grip nudged on the Knight cannot move
 * the Universal Base (§9.2).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal, useFrame } from '@react-three/fiber';
import { TransformControls, useGLTF } from '@react-three/drei';
import { clone as cloneSkinnedScene } from 'three/examples/jsm/utils/SkeletonUtils.js';
import {
  DODGE_RECOVERY_BLEND_SEC,
  isDodgeRecoveryTransition,
} from '@atc/animation-runtime';
import type { RootMotionTrack } from '@atc/replay-runtime';
import type { CharacterModelBinding, ExternalAnimationSource } from '@atc/schema';
import * as THREE from 'three';
import type { ChamberEngine } from '../../engine.ts';
import type { ResolvedCharacterPresentation } from '../../rig-editor/resolve-character-presentation.ts';
import type { WeaponGrip, WeaponMode } from '../catalog.ts';
import { HeldSword } from './HeldSword.tsx';

/** A take's identity: the file it lives in plus its name inside that file. */
function takeKey(source: ExternalAnimationSource): string {
  return `${source.assetPath}|${source.animationName}`;
}

export function GltfCharacter({
  engine,
  model,
  presentation,
  weapon,
  grip,
  gripEditorMode,
  onGripChange,
}: {
  engine: ChamberEngine;
  /** The authored `repository-model` binding. Narrowed by `Character`. */
  model: Extract<CharacterModelBinding, { kind: 'repository-model' }>;
  presentation: ResolvedCharacterPresentation;
  weapon: WeaponMode;
  grip?: WeaponGrip;
  gripEditorMode?: 'translate' | 'rotate' | null;
  onGripChange?(grip: WeaponGrip): void;
}) {
  const root = useRef<THREE.Group>(null);
  const [heldWeapon, setHeldWeapon] = useState<THREE.Group | null>(null);

  const { scene: cachedScene } = useGLTF(model.assetPath);
  /*
   * A skinned clone, not the cached scene. `SkeletonUtils.clone` is the
   * documented way to copy a skinned hierarchy so the copy owns its bones — a
   * plain `.clone()` keeps pointing at the original skeleton, which is how "one
   * Character's pose moved another's" happens.
   */
  const modelScene = useMemo(() => cloneSkinnedScene(cachedScene), [cachedScene]);

  /*
   * Every file the canonical takes live in. A Character's own model file may
   * contain none of them — the Universal Base's animation lives in two separate
   * libraries — and one file may supply takes for many slots, so this is the
   * deduplicated set the presentation resolver computed.
   */
  const filesToLoad = useMemo(
    () => (presentation.sourceFiles.length > 0 ? presentation.sourceFiles : [model.assetPath]),
    [presentation.sourceFiles, model.assetPath],
  );
  const loaded = useGLTF(filesToLoad);
  const animationsByFile = useMemo(() => {
    const byFile = new Map<string, THREE.AnimationClip[]>();
    filesToLoad.forEach((file, index) => {
      byFile.set(file, loaded[index]?.animations ?? []);
    });
    return byFile;
  }, [filesToLoad, loaded]);

  /**
   * The clips this Character plays, cloned and scaled per take.
   *
   * The clone is what makes `positionScale` safe. Scaling a cached clip's tracks
   * in place mutated shared state, so the second Character to render found the
   * tracks already scaled — and scaled them again.
   */
  const clipsByTake = useMemo(() => {
    const byTake = new Map<string, THREE.AnimationClip>();
    for (const source of Object.values(presentation.takeByStateId)) {
      const key = takeKey(source);
      if (byTake.has(key)) continue;
      const found = animationsByFile
        .get(source.assetPath)
        ?.find((animation) => animation.name === source.animationName);
      if (!found) continue;

      const clip = found.clone();
      // Chamber movement owns the world root, but bone-local translation is
      // pose data: Quaternius' pelvis track keeps the roll on the ground.
      clip.tracks = clip.tracks.filter((track) => track.name !== 'root.position');
      const scale = source.positionScale ?? 1;
      if (scale !== 1) {
        clip.tracks = clip.tracks.map((track) => {
          if (!(track instanceof THREE.VectorKeyframeTrack) || !track.name.endsWith('.position')) {
            return track;
          }
          const scaled = track.clone() as THREE.VectorKeyframeTrack;
          for (let index = 0; index < scaled.values.length; index += 1) {
            scaled.values[index] = scaled.values[index]! * scale;
          }
          return scaled;
        });
      }
      byTake.set(key, clip);
    }
    return byTake;
  }, [animationsByFile, presentation.takeByStateId]);

  /**
   * Root displacement sampled from the takes, per state.
   *
   * Read from the *source* animation rather than the playback clone, because the
   * clone deliberately drops `root.position`: that track is movement, and the
   * simulation consumes it instead of the skeleton.
   */
  const actionRootMotionTracks = useMemo(() => {
    if (!weapon.usesAttackRootMotion) return {};
    const tracks: Record<string, RootMotionTrack> = {};
    for (const [stateId, source] of Object.entries(presentation.takeByStateId)) {
      // Straight from the cache, read-only: the playback clone below drops
      // `root.position`, and this is the track that survives it.
      const clip = animationsByFile
        .get(source.assetPath)
        ?.find((animation) => animation.name === source.animationName);
      const rootTrack = clip?.tracks.find(
        (track): track is THREE.VectorKeyframeTrack =>
          track instanceof THREE.VectorKeyframeTrack && track.name === 'root.position',
      );
      if (!clip || !rootTrack || rootTrack.times.length === 0) continue;
      const scale = source.positionScale ?? 1;
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
  }, [animationsByFile, presentation.takeByStateId, weapon.usesAttackRootMotion]);

  useEffect(() => {
    engine.setActionRootMotionTracks(actionRootMotionTracks);
    return () => engine.setActionRootMotionTracks({});
  }, [actionRootMotionTracks, engine]);

  // One mixer per cloned scene, so mixer time is this Character's alone.
  const mixer = useMemo(() => new THREE.AnimationMixer(modelScene), [modelScene]);
  const currentTake = useRef('');
  const currentAction = useRef<THREE.AnimationAction | null>(null);
  /** Whether the clip on screen came from the action layer, so fading *out* of an
   * action uses that action transition's duration, not a stale locomotion one. */
  const currentClipIsAction = useRef(false);

  useEffect(() => {
    modelScene.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      object.castShadow = true;
      object.receiveShadow = true;
      /*
       * Cloned meshes share their materials with the cache, and `side` is a
       * visible property — so it is set on this Character's own copy. Setting it
       * on the cached material would be a debug-visible change to every other
       * Character using the same file.
       */
      const withDoubleSide = (material: THREE.Material): THREE.Material => {
        const copy = material.clone();
        copy.side = THREE.DoubleSide;
        return copy;
      };
      object.material = Array.isArray(object.material)
        ? object.material.map(withDoubleSide)
        : withDoubleSide(object.material as THREE.Material);
    });
    return () => {
      mixer.stopAllAction();
      currentAction.current = null;
      currentTake.current = '';
      currentClipIsAction.current = false;
    };
  }, [mixer, modelScene]);

  useFrame((_, delta) => {
    const group = root.current;
    if (!group) return;
    const state = engine.simulationState;
    const record = engine.lastRecord;
    group.position.set(state.position.x, state.position.y, state.position.z);
    group.rotation.y = state.yawRad + model.rotationYRad;

    const project = engine.currentProject;
    const actionState = project.graph.states.find((entry) => entry.id === record?.actionState);
    const locomotionState = project.graph.states.find(
      (entry) => entry.id === record?.locomotionState,
    );
    // The state names a slot; the character's motion set says which clip that is.
    const actionClip = project.clips.find(
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

    /*
     * The canonical binding for this state, and no fallback chain. If the motion
     * set binds nothing here there is nothing honest to play, so the previous
     * clip stays and the gap stays visible rather than being filled with an idle
     * borrowed from another slot.
     */
    const source = presentation.takeByStateId[stateId];
    const key = source ? takeKey(source) : '';
    if (key !== '' && key !== currentTake.current) {
      const clip = clipsByTake.get(key);
      if (clip) {
        const loop = presentation.loopByStateId[stateId] ?? true;
        const nextAction = mixer
          .clipAction(clip, modelScene)
          .reset()
          .setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1)
          .play();
        nextAction.clampWhenFinished = !loop;
        const layer = actionActive || currentClipIsAction.current ? 'action' : 'locomotion';
        currentAction.current?.crossFadeTo(
          nextAction,
          dodgeRecovery
            ? DODGE_RECOVERY_BLEND_SEC
            : (engine.graphLayers[layer]?.blendDurationSec ?? 0),
          false,
        );
        currentAction.current = nextAction;
        currentTake.current = key;
        currentClipIsAction.current = actionActive;
      }
    }
    mixer.update(delta);
    if (currentAction.current && currentTake.current === key) {
      currentAction.current.time =
        normalizedTime * currentAction.current.getClip().duration;
      mixer.update(0);
    }
  });

  const hand = model.rightHandBone ? modelScene.getObjectByName(model.rightHandBone) : undefined;
  return (
    <>
      <group ref={root}>
        <group scale={[model.scale, model.scale, model.scale]}>
          <primitive object={modelScene} />
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

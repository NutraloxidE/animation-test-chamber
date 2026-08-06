/**
 * The one animation adapter beneath `GameObjectRenderer` (§10.1).
 *
 * It is an *adapter*, not an engine. Everything about what should be playing —
 * which graph state is active, how far into it, which take that state binds, in
 * which motion context — was decided upstream, by the same animation asset
 * resolver the Rig Editor and the simulation use, and arrives here as
 * `RenderAnimatorFact`. What this file does is the part that genuinely belongs
 * in a renderer:
 *
 *   clone the skeleton, build a mixer, fetch the named take, play it, seek it
 *
 * and nothing else. There is no `stateId -> filename` table here, no clip map,
 * no lookup keyed by Prefab id or Character id (§10.4). If the resolved plan
 * names no take for the state, this component plays *nothing* and reports why
 * (§10.5) — playing the first clip in the GLTF would put motion on screen for a
 * binding that names nothing, and "it animates" would stop being evidence.
 *
 * ## Isolation
 *
 * `useGLTF` caches per URL, so the loaded scene and its clips are shared input.
 * Every instance therefore gets:
 *
 *   its own `SkeletonUtils.clone` of the scene   (its own bones)
 *   its own `AnimationMixer` over that clone     (its own time)
 *   its own `clip.clone()` per take it plays     (its own tracks)
 *
 * Two GameObjects standing on one Prefab share the immutable input and share
 * nothing mutable (§10.2) — the same rule the runtime keeps for simulation
 * state, applied to geometry. The previous chamber renderer learned this the
 * hard way: it scaled position tracks *in place* on cached clips, so the second
 * character to render found them already scaled and scaled them again.
 *
 * ## The clock
 *
 * Time comes from the fact, which came from the runtime, which advanced on the
 * shared fixed-step Scene clock (§10.3). `mixer.update(0)` after seeking is what
 * makes the pose a function of simulation time rather than of how long the last
 * frame took — so two runs of the same replay show the same pose at the same
 * tick, and a paused Scene stays paused instead of drifting.
 */
import { useEffect, useMemo, useRef } from 'react';
import { useGLTF } from '@react-three/drei';
import { clone as cloneSkinnedScene } from 'three/examples/jsm/utils/SkeletonUtils.js';
import * as THREE from 'three';
import type { ExternalAnimationSource } from '@atc/schema';
import type { RenderAnimatorFact, RenderModelFact, RenderProjectionIssue } from './render-projection.ts';

/** A take's identity: the file it lives in plus its name inside that file. */
function takeKey(source: ExternalAnimationSource): string {
  return `${source.assetPath}|${source.animationName}`;
}

export interface AnimatedRepositoryModelProps {
  assetPath: string;
  castShadow: boolean;
  receiveShadow: boolean;
  animator: RenderAnimatorFact;
  model: RenderModelFact;
  gameObjectId: string;
  displayName: string;
  onIssue?: (issue: RenderProjectionIssue) => void;
}

export function AnimatedRepositoryModel({
  assetPath,
  castShadow,
  receiveShadow,
  animator,
  gameObjectId,
  displayName,
  onIssue,
}: AnimatedRepositoryModelProps): JSX.Element {
  /*
   * Every file this Animator's takes live in, plus the model's own.
   *
   * A Prefab's model file may contain none of the takes it plays — the
   * Quaternius base's animation lives in separate libraries — and one file may
   * supply takes for many states, so the plan's deduplicated `sourceFiles` is
   * what gets fetched, with the model file appended so the mesh itself loads.
   */
  const files = useMemo(() => {
    const unique = new Set<string>([assetPath, ...animator.playback.sourceFiles]);
    return [...unique];
  }, [assetPath, animator.playback.sourceFiles]);

  const loaded = useGLTF(files);
  const modelIndex = files.indexOf(assetPath);
  const cachedScene = loaded[modelIndex]?.scene;

  /*
   * A skinned clone, not the cached scene. `SkeletonUtils.clone` is the
   * documented way to copy a skinned hierarchy so the copy owns its bones — a
   * plain `.clone()` keeps pointing at the original skeleton, which is how one
   * GameObject's pose moves another's.
   */
  const scene = useMemo(
    () => (cachedScene ? cloneSkinnedScene(cachedScene) : new THREE.Group()),
    [cachedScene],
  );

  const animationsByFile = useMemo(() => {
    const byFile = new Map<string, THREE.AnimationClip[]>();
    files.forEach((file, index) => byFile.set(file, loaded[index]?.animations ?? []));
    return byFile;
  }, [files, loaded]);

  useEffect(() => {
    scene.traverse((child) => {
      child.castShadow = castShadow;
      child.receiveShadow = receiveShadow;
    });
  }, [scene, castShadow, receiveShadow]);

  /** One mixer per cloned scene, so mixer time is this instance's alone. */
  const mixer = useMemo(() => new THREE.AnimationMixer(scene), [scene]);

  /** Playback clips, cloned per take so no cached clip is ever mutated. */
  const clipsByTake = useMemo(() => {
    const byTake = new Map<string, THREE.AnimationClip>();
    for (const source of Object.values(animator.playback.takeByStateId)) {
      const key = takeKey(source);
      if (byTake.has(key)) continue;
      const found = animationsByFile
        .get(source.assetPath)
        ?.find((animation) => animation.name === source.animationName);
      if (!found) continue;

      const clip = found.clone();
      // Chamber movement owns the world root, but bone-local translation is
      // pose data: dropping only `root.position` keeps the roll on the ground
      // without flattening the pose.
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
  }, [animationsByFile, animator.playback.takeByStateId]);

  const currentTake = useRef('');
  const currentAction = useRef<THREE.AnimationAction | null>(null);
  /** Take keys already reported missing, so one gap is one issue, not one a frame. */
  const reported = useRef(new Set<string>());

  /*
   * Everything this component owns is released on unmount or on a replaced
   * runtime (§10.6). The cached GLTF is deliberately *not* disposed: it belongs
   * to `useGLTF`, and another instance is probably still drawing from it.
   */
  useEffect(
    () => () => {
      mixer.stopAllAction();
      mixer.uncacheRoot(scene);
      currentAction.current = null;
      currentTake.current = '';
      reported.current.clear();
    },
    [mixer, scene],
  );

  const source = animator.playback.takeByStateId[animator.stateId];
  const key = source ? takeKey(source) : '';

  useEffect(() => {
    /*
     * A state with no take, or a take the file does not contain, is reported
     * once with everything needed to fix it: which object, which Animator,
     * which animation asset, which take. Nothing is played in its place.
     */
    if (!source) {
      const gap = `state:${animator.stateId}`;
      if (reported.current.has(gap)) return;
      reported.current.add(gap);
      onIssue?.({
        code: 'animator-take-unbound',
        gameObjectId,
        componentId: animator.componentId,
        message:
          `"${displayName}" (${gameObjectId}) plays state "${animator.stateId}", but ` +
          `motion set "${animator.assignment.motionSet.assetId}@${animator.assignment.motionSet.version}" ` +
          'binds no imported take to it',
      });
      return;
    }
    if (clipsByTake.has(key)) return;
    if (reported.current.has(key)) return;
    reported.current.add(key);
    onIssue?.({
      code: 'animator-clip-missing',
      gameObjectId,
      componentId: animator.componentId,
      message:
        `"${displayName}" (${gameObjectId}) state "${animator.stateId}" names take ` +
        `"${source.animationName}" in "${source.assetPath}", which that file does not contain`,
    });
  }, [source, key, clipsByTake, animator, gameObjectId, displayName, onIssue]);

  /*
   * Bind, then seek. The action is (re)started only when the *take* changes, so
   * a state change that happens to play the same clip does not restart it; the
   * seek runs every render, because that is what makes the pose a function of
   * simulation time.
   */
  useEffect(() => {
    const clip = key === '' ? undefined : clipsByTake.get(key);
    if (!clip) return;
    if (key !== currentTake.current) {
      const loop = animator.playback.loopByStateId[animator.stateId] ?? true;
      const next = mixer
        .clipAction(clip, scene)
        .reset()
        .setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1)
        .play();
      next.clampWhenFinished = !loop;
      currentAction.current?.stop();
      currentAction.current = next;
      currentTake.current = key;
    }
    const action = currentAction.current;
    if (!action) return;
    action.time = animator.normalizedTime * action.getClip().duration;
    // `update(0)` applies the seek without advancing wall-clock time, so the
    // pose on screen is exactly the one the simulation is at.
    mixer.update(0);
  }, [key, clipsByTake, mixer, scene, animator.normalizedTime, animator.stateId, animator.playback.loopByStateId]);

  return <primitive object={scene} />;
}

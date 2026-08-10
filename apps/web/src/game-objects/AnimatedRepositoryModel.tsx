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
import { Fragment, useEffect, useMemo, useRef, type ReactNode } from "react";
import { createPortal } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import { clone as cloneSkinnedScene } from "three/examples/jsm/utils/SkeletonUtils.js";
import * as THREE from "three";
import type { EquipmentSocketDefinition, ExternalAnimationSource } from "@atc/schema";
import type {
  RenderAnimatorFact,
  RenderProjectionIssue,
} from "./render-projection.ts";
import { deterministicBlendWeights } from "./animation-blend.ts";

/** A take's identity: the file it lives in plus its name inside that file. */
function takeKey(source: ExternalAnimationSource): string {
  return `${source.assetPath}|${source.animationName}`;
}

export interface AnimatedRepositoryModelProps {
  assetPath: string;
  scale: number;
  rotationYRad: number;
  castShadow: boolean;
  receiveShadow: boolean;
  animator: RenderAnimatorFact;
  gameObjectId: string;
  displayName: string;
  /** Authored sockets that ride a bone. Node-riding ones are drawn outside. */
  boneSockets?: readonly EquipmentSocketDefinition[];
  renderAttachment?: (input: {
    gameObjectId: string;
    socket: EquipmentSocketDefinition;
  }) => ReactNode;
  onIssue?: (issue: RenderProjectionIssue) => void;
}

export function AnimatedRepositoryModel({
  assetPath,
  scale,
  rotationYRad,
  castShadow,
  receiveShadow,
  animator,
  gameObjectId,
  displayName,
  boneSockets,
  renderAttachment,
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
    const unique = new Set<string>([
      assetPath,
      ...animator.playback.sourceFiles,
    ]);
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
    files.forEach((file, index) =>
      byFile.set(file, loaded[index]?.animations ?? []),
    );
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
      clip.tracks = clip.tracks.filter(
        (track) => track.name !== "root.position",
      );
      const scale = source.positionScale ?? 1;
      if (scale !== 1) {
        clip.tracks = clip.tracks.map((track) => {
          if (
            !(track instanceof THREE.VectorKeyframeTrack) ||
            !track.name.endsWith(".position")
          ) {
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
      reported.current.clear();
    },
    [mixer, scene],
  );

  const source = animator.playback.takeByStateId[animator.stateId];
  const key = source ? takeKey(source) : "";

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
        code: "animator-take-unbound",
        gameObjectId,
        componentId: animator.componentId,
        message:
          `"${displayName}" (${gameObjectId}) plays state "${animator.stateId}", but ` +
          `motion set "${animator.assignment.motionSet.assetId}@${animator.assignment.motionSet.version}" ` +
          "binds no imported take to it",
      });
      return;
    }
    if (clipsByTake.has(key)) return;
    if (reported.current.has(key)) return;
    reported.current.add(key);
    onIssue?.({
      code: "animator-clip-missing",
      gameObjectId,
      componentId: animator.componentId,
      message:
        `"${displayName}" (${gameObjectId}) state "${animator.stateId}" names take ` +
        `"${source.animationName}" in "${source.assetPath}", which that file does not contain`,
    });
  }, [source, key, clipsByTake, animator, gameObjectId, displayName, onIssue]);

  const previousSource = animator.previousStateId
    ? animator.playback.takeByStateId[animator.previousStateId]
    : undefined;
  const previousKey = previousSource ? takeKey(previousSource) : "";
  const bound = useRef<{ current: THREE.AnimationAction; previous: THREE.AnimationAction | undefined } | null>(null);

  /*
   * Binding and seeking are split, and the split is a performance property with
   * a correctness consequence. Which clips are playing changes only when the
   * state or the transition does, so tearing down and rebuilding every action
   * each frame — for every character on screen — is work proportional to the
   * cast rather than to what actually changed.
   */
  useEffect(() => {
    const clip = key === "" ? undefined : clipsByTake.get(key);
    if (!clip) {
      bound.current = null;
      return;
    }
    mixer.stopAllAction();
    const previousClip = previousKey === "" ? undefined : clipsByTake.get(previousKey);
    const previous = previousClip ? mixer.clipAction(previousClip, scene).reset().play() : undefined;
    const loop = animator.playback.loopByStateId[animator.stateId] ?? true;
    const current = mixer
      .clipAction(clip, scene)
      .reset()
      .setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1)
      .play();
    current.clampWhenFinished = !loop;
    bound.current = { current, previous };
    /*
     * `key` and `previousKey` already encode which takes these are; depending on
     * the whole animator fact would rebind on every frame, which is the cost
     * this split exists to remove.
     */
  }, [key, previousKey, clipsByTake, mixer, scene, animator.stateId, animator.playback]);

  /*
   * Weight and seek entirely from runtime state, every render. `mixer.update(0)`
   * only evaluates that state; render-wall-clock delta never advances a
   * transition, so the pose stays a function of simulation time.
   */
  useEffect(() => {
    const actions = bound.current;
    if (!actions) return;
    const weights = deterministicBlendWeights(previousKey === "" ? undefined : previousKey, key, animator.blendWeight);
    if (actions.previous) {
      actions.previous.time = animator.previousNormalizedTime * actions.previous.getClip().duration;
      actions.previous.setEffectiveWeight(weights.previous);
    }
    actions.current.time = animator.normalizedTime * actions.current.getClip().duration;
    actions.current.setEffectiveWeight(weights.current);
    mixer.update(0);
  });

  /*
   * Authored bone sockets, resolved against *this instance's* cloned skeleton.
   *
   * Portalled into the bone rather than positioned beside the model: a held
   * item has to inherit the bone's animated world matrix every frame, and a
   * sibling group would have to re-derive it — which is the "sword floating at
   * the origin" bug in a slightly more expensive form. The socket's authored
   * local transform is applied inside the portal, so the grip stays canonical
   * Prefab data rather than a correction baked into the item mesh.
   */
  const socketMounts = useMemo(() => {
    if (!boneSockets || boneSockets.length === 0 || !renderAttachment) return [];
    return boneSockets.flatMap((socket) => {
      const bone = socket.boneName ? scene.getObjectByName(socket.boneName) : undefined;
      return bone ? [{ socket, bone }] : [];
    });
  }, [boneSockets, renderAttachment, scene]);

  return (
    <group
      name={`${gameObjectId}:repository-model`}
      scale={[scale, scale, scale]}
      rotation-y={rotationYRad}
      userData={{
        atcRenderedModel: true,
        atcGameObjectId: gameObjectId,
        atcModelAssetPath: assetPath,
        atcModelScale: scale,
        atcModelRotationYRad: rotationYRad,
        atcAnimationState: animator.stateId,
        atcAnimationTime: animator.normalizedTime,
        atcBlendWeight: animator.blendWeight,
      }}
    >
      <primitive object={scene} />
      {renderAttachment &&
        socketMounts.map(({ socket, bone }) => {
          const content = renderAttachment({ gameObjectId, socket });
          if (!content) return null;
          return (
            <Fragment key={socket.socketId}>
              {createPortal(
                <group
                  position={socket.localPosition}
                  rotation={socket.localRotation}
                >
                  {content}
                </group>,
                bone,
              )}
            </Fragment>
          );
        })}
    </group>
  );
}

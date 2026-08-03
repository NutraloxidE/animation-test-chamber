/**
 * Playing one rig's clips on another rig's skeleton.
 *
 * Every state machine in the catalog is authored against `quaternius-universal`,
 * so without this a model on any other skeleton silently falls back to its own
 * embedded clips: picking Sword on the Knight would change nothing on screen.
 * Retargeting resolves each clip through world-space bone orientations, which is
 * what makes it survive the two rigs' different bind poses — a plain track
 * rename would copy A-pose quaternions onto a T-pose skeleton and bend the arms
 * into the chest.
 */
import * as THREE from 'three';
import {
  clone as skeletonClone,
  retargetClip,
} from 'three/examples/jsm/utils/SkeletonUtils.js';

function skinnedMeshOf(root: THREE.Object3D): THREE.SkinnedMesh | null {
  let found: THREE.SkinnedMesh | null = null;
  root.traverse((object) => {
    if (!found && object instanceof THREE.SkinnedMesh) found = object;
  });
  return found;
}

/**
 * Retargets `clips` onto `model`'s skeleton.
 *
 * `bones` maps a bone on `model` to the bone it follows on `sourceScene`;
 * unmapped bones (fingers, IK targets, props) simply keep their rest pose.
 *
 * Rotation only: the hip translation track is left out, because the chamber
 * engine owns world position and the two rigs are not the same height, so a
 * copied hip offset would drive the model into or through the ground. Attack
 * displacement still comes from the source clip's own root track, which is read
 * before retargeting and is unaffected.
 *
 * ponytail: samples every frame of every clip up front, so a large motion set
 * costs a visible hitch on first use. Cache per (model, rig) pair if that shows.
 */
export function retargetClips(
  model: THREE.Object3D,
  sourceScene: THREE.Object3D,
  clips: THREE.AnimationClip[],
  bones: Record<string, string>,
): THREE.AnimationClip[] {
  // Both sides are cloned: `retargetClip` poses the source through a mixer and
  // writes the result onto the target's bones. Run against the live objects and
  // it would leave the on-screen model frozen in the last sampled frame.
  const target = skinnedMeshOf(skeletonClone(model));
  const source = skinnedMeshOf(skeletonClone(sourceScene));
  if (!target || !source) return [];

  return clips.map((clip) => {
    const retargeted = retargetClip(target, source, clip, { names: bones });
    for (const track of retargeted.tracks) {
      // `retargetClip` emits `.bones[Name].quaternion`, which only binds when the
      // mixer root is the skeleton itself. Everything here plays on the model
      // root, so name the tracks after the bone directly.
      track.name = track.name.replace(/^\.bones\[(.+)\]\./, '$1.');
    }
    retargeted.name = clip.name;
    return retargeted;
  });
}

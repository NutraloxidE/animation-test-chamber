/**
 * Clips crossing rigs.
 *
 * Every state machine in the catalog is authored on one rig, so a model on any
 * other skeleton could not play them at all. The two things worth pinning are
 * the ones a visual test would only report as "the model stands still": that the
 * produced tracks are named after the *target's* bones and bind to the model
 * root (`retargetClip` emits `.bones[Name].quaternion`, which silently binds to
 * nothing there), and that a bone left out of the map is left alone rather than
 * snapped to some default.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { retargetClips } from '../../../apps/web/src/three/characters/retarget.ts';

/** A two-bone arm, so `bones` has something to translate between. */
function rig(names: { root: string; child: string; prop: string }) {
  const root = new THREE.Bone();
  root.name = names.root;
  const child = new THREE.Bone();
  child.name = names.child;
  child.position.set(0, 1, 0);
  root.add(child);
  // Unmapped on the target side: nothing in the source clip corresponds to it.
  const prop = new THREE.Bone();
  prop.name = names.prop;
  child.add(prop);

  const mesh = new THREE.SkinnedMesh(
    new THREE.BufferGeometry(),
    new THREE.MeshBasicMaterial(),
  );
  mesh.add(root);
  mesh.bind(new THREE.Skeleton([root, child, prop]));
  const scene = new THREE.Group();
  scene.add(mesh);
  scene.updateMatrixWorld(true);
  return scene;
}

const BONES = { Hips: 'pelvis', Arm: 'upperarm_l' };

function clip() {
  return new THREE.AnimationClip('Wave', 1, [
    new THREE.QuaternionKeyframeTrack(
      'upperarm_l.quaternion',
      [0, 1],
      [0, 0, 0, 1, 0, 0, 0.707, 0.707],
    ),
  ]);
}

describe('retargetClips', () => {
  const target = rig({ root: 'Hips', child: 'Arm', prop: 'Shield' });
  const source = rig({ root: 'pelvis', child: 'upperarm_l', prop: 'weapon_r' });
  const [retargeted] = retargetClips(target, source, [clip()], BONES);

  it('names tracks after the target rig and binds them to the model root', () => {
    expect(retargeted).toBeDefined();
    expect(retargeted!.name).toBe('Wave');
    const names = retargeted!.tracks.map((track) => track.name);
    expect(names).toContain('Arm.quaternion');
    expect(names.some((name) => name.startsWith('.bones['))).toBe(false);
  });

  it('leaves unmapped bones out rather than driving them to a default', () => {
    const names = retargeted!.tracks.map((track) => track.name);
    expect(names.some((name) => name.startsWith('Shield.'))).toBe(false);
  });

  it('carries the source rotation across', () => {
    const track = retargeted!.tracks.find((entry) => entry.name === 'Arm.quaternion')!;
    const last = track.values.slice(-4);
    const rotated = new THREE.Quaternion(last[0]!, last[1]!, last[2]!, last[3]!);
    // The source ends a quarter turn about X away from where it started; the
    // exact keys differ after resampling, so assert the angle, not the values.
    expect(rotated.angleTo(new THREE.Quaternion())).toBeCloseTo(Math.PI / 2, 2);
  });

  it('returns nothing when either side has no skeleton to retarget onto', () => {
    expect(retargetClips(new THREE.Group(), source, [clip()], BONES)).toEqual([]);
  });
});

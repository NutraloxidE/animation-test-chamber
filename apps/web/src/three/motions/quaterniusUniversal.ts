import type { MotionSet } from '../catalog.ts';

export const QUATERNIUS_UNIVERSAL_CLIPS: Record<string, string> = {
  idle: 'Rig|Idle_Loop',
  walk: 'Rig|Walk_Loop',
  run: 'Rig|Sprint_Loop',
  jump: 'Rig|Jump_Start',
  fall: 'Rig|Jump_Loop',
  dodge: 'Rig|Roll',
  guard: 'Rig|Sword_Idle',
  'attack-01': 'Rig|Punch_Jab',
  'attack-02': 'Rig|Punch_Cross',
};

export const QUATERNIUS_UNIVERSAL_MOTION: MotionSet = {
  id: 'quaternius-universal',
  label: 'Quaternius Universal (CC0)',
  stride: 1,
  armSwing: 1,
  torsoLean: 1,
  animationUrl: '/assets/animations/quaternius-universal/AnimationLibrary_UE_Standard.glb',
  clipMap: QUATERNIUS_UNIVERSAL_CLIPS,
};

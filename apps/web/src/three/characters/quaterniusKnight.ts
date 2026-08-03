import type { CharacterPreset } from '../catalog.ts';

export const QUATERNIUS_KNIGHT: CharacterPreset = {
  id: 'quaternius-knight',
  label: 'Quaternius Knight (CC0)',
  color: '#ffffff',
  legColor: '#ffffff',
  scale: 1,
  modelUrl: '/assets/characters/quaternius-knight/KnightCharacter.glb',
  modelScale: 0.3,
  // Fingers, thumbs and the IK pole targets are deliberately unmapped: the
  // universal rig's finger curls read as claws on this hand, and a pole target
  // is a control, not a joint the animation has an opinion about.
  retargetFrom: {
    rigId: 'quaternius-universal',
    bones: {
      Hips: 'pelvis',
      Abdomen: 'spine_01',
      Torso: 'spine_02',
      Neck: 'neck_01',
      Head: 'Head',
      'Shoulder.L': 'clavicle_l',
      'UpperArm.L': 'upperarm_l',
      'LowerArm.L': 'lowerarm_l',
      'Palm.L': 'hand_l',
      'Shoulder.R': 'clavicle_r',
      'UpperArm.R': 'upperarm_r',
      'LowerArm.R': 'lowerarm_r',
      'Palm.R': 'hand_r',
      'UpperLeg.L': 'thigh_l',
      'LowerLeg.L': 'calf_l',
      'Foot.L': 'foot_l',
      'UpperLeg.R': 'thigh_r',
      'LowerLeg.R': 'calf_r',
      'Foot.R': 'foot_r',
    },
  },
  rightHandBone: 'Palm.R',
  weaponGrips: {
    sword: {
      position: [0, 0, 0],
      rotation: [0, 0, 0],
    },
  },
};

import type { CharacterPreset } from '../catalog.ts';

export const QUATERNIUS_KNIGHT: CharacterPreset = {
  id: 'quaternius-knight',
  label: 'Quaternius Knight (CC0)',
  color: '#ffffff',
  legColor: '#ffffff',
  scale: 1,
  modelUrl: '/assets/characters/quaternius-knight/KnightCharacter.glb',
  modelScale: 0.3,
  rightHandBone: 'Palm.R',
  weaponGrips: {
    sword: {
      position: [0, 0, 0],
      rotation: [0, 0, 0],
    },
  },
};

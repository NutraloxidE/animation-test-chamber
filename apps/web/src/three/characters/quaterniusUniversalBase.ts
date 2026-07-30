import type { CharacterPreset } from '../catalog.ts';
import { QUATERNIUS_UNIVERSAL_CLIPS } from '../motions/quaterniusUniversal.ts';

export const QUATERNIUS_UNIVERSAL_BASE: CharacterPreset = {
  id: 'quaternius-universal-base',
  label: 'Universal Base Superhero (CC0)',
  color: '#ffffff',
  legColor: '#ffffff',
  scale: 1,
  modelUrl: '/assets/characters/quaternius-universal-base/Superhero_Female_FullBody.gltf',
  modelScale: 1,
  animationUrl: '/assets/animations/quaternius-universal/AnimationLibrary_UE_Standard.glb',
  animationPositionScale: 100,
  clipMap: QUATERNIUS_UNIVERSAL_CLIPS,
  rigId: 'quaternius-universal',
  rightHandBone: 'hand_r',
  weaponGrips: {
    sword: {
      position: [0, -0.035, 0],
      rotation: [0, Math.PI / 2, -0.18],
    },
  },
};

import { QUATERNIUS_KNIGHT } from './characters/quaterniusKnight.ts';
import { QUATERNIUS_UNIVERSAL_BASE } from './characters/quaterniusUniversalBase.ts';

export interface WeaponGrip {
  position: [number, number, number];
  rotation: [number, number, number];
}

export interface CharacterPreset {
  id: string;
  label: string;
  color: string;
  legColor: string;
  scale: number;
  modelUrl?: string;
  modelScale?: number;
  modelRotationY?: number;
  animationUrl?: string;
  /** Converts external animation position keys into the model rig's local scale. */
  animationPositionScale?: number;
  clipMap?: Record<string, string>;
  rigId?: string;
  rightHandBone?: string;
  weaponGrips?: Record<string, WeaponGrip>;
}

export interface WeaponMode {
  id: string;
  label: string;
  heldItem?: 'sword';
  usesAttackRootMotion?: boolean;
  rigId?: string;
  animationUrl?: string;
  animationPositionScale?: number;
  clipMap?: Record<string, string>;
}

/** Keep selectable preview variants in one small catalog. */
export const CHARACTER_PRESETS: CharacterPreset[] = [
  { id: 'navigator', label: 'Navigator (neutral)', color: '#7dd3fc', legColor: '#38bdf8', scale: 1 },
  { id: 'relay', label: 'Relay', color: '#c4b5fd', legColor: '#8b5cf6', scale: 0.92 },
  { id: 'sentinel', label: 'Sentinel', color: '#fbbf24', legColor: '#f97316', scale: 1.08 },
  QUATERNIUS_KNIGHT,
  QUATERNIUS_UNIVERSAL_BASE,
];

export const WEAPON_MODES: WeaponMode[] = [
  { id: 'unarmed', label: 'Unarmed' },
  {
    id: 'sword',
    label: 'Sword (CC0)',
    heldItem: 'sword',
    usesAttackRootMotion: true,
    rigId: 'quaternius-universal',
    animationUrl: '/assets/animations/quaternius-universal-2/UAL2_Standard_RM.glb',
    animationPositionScale: 1,
    clipMap: {
      idle: 'Rig|Sword_Idle',
      guard: 'Rig|Sword_Idle',
      'attack-01': 'Sword_Regular_A',
      'attack-01-recovery': 'Sword_Regular_A_Rec',
      'attack-02': 'Sword_Regular_B',
      'attack-02-recovery': 'Sword_Regular_B_Rec',
    },
  },
  {
    id: 'magic',
    // The Spell_Simple clips cast from the left hand and leave the right hand
    // open, so this mode holds nothing.
    label: 'Magic, unarmed (CC0)',
    rigId: 'quaternius-universal',
    animationUrl: '/assets/animations/quaternius-universal/AnimationLibrary_UE_Standard.glb',
    animationPositionScale: 100,
    clipMap: {
      idle: 'Rig|Spell_Simple_Idle_Loop',
      guard: 'Rig|Spell_Simple_Idle_Loop',
      'attack-01': 'Rig|Spell_Simple_Shoot',
      'attack-01-recovery': 'Rig|Spell_Simple_Exit',
      'attack-02': 'Rig|Spell_Simple_Enter',
      'attack-02-recovery': 'Rig|Spell_Simple_Exit',
    },
  },
];

export const characterPreset = (id: string): CharacterPreset =>
  CHARACTER_PRESETS.find((preset) => preset.id === id) ?? CHARACTER_PRESETS[0]!;

export const weaponMode = (id: string): WeaponMode =>
  WEAPON_MODES.find((mode) => mode.id === id) ?? WEAPON_MODES[0]!;

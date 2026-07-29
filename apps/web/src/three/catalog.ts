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
  clipMap?: Record<string, string>;
}

export interface MotionSet {
  id: string;
  label: string;
  stride: number;
  armSwing: number;
  torsoLean: number;
  animationUrl?: string;
  clipMap?: Record<string, string>;
}

/** Keep selectable preview variants in one small, asset-free catalog. */
export const CHARACTER_PRESETS: CharacterPreset[] = [
  { id: 'navigator', label: 'Navigator (neutral)', color: '#7dd3fc', legColor: '#38bdf8', scale: 1 },
  { id: 'relay', label: 'Relay', color: '#c4b5fd', legColor: '#8b5cf6', scale: 0.92 },
  { id: 'sentinel', label: 'Sentinel', color: '#fbbf24', legColor: '#f97316', scale: 1.08 },
  {
    id: 'quaternius-knight',
    label: 'Quaternius Knight (CC0)',
    color: '#ffffff',
    legColor: '#ffffff',
    scale: 1,
    modelUrl: '/assets/characters/quaternius-knight/KnightCharacter.glb',
    modelScale: 0.3,
  },
  {
    id: 'quaternius-universal-base',
    label: 'Universal Base Superhero (CC0)',
    color: '#ffffff',
    legColor: '#ffffff',
    scale: 1,
    modelUrl: '/assets/characters/quaternius-universal-base/Superhero_Female_FullBody.gltf',
    modelScale: 1,
    animationUrl: '/assets/animations/quaternius-universal/AnimationLibrary_UE_Standard.glb',
    clipMap: {
      idle: 'Rig|Idle_Loop',
      walk: 'Rig|Walk_Loop',
      run: 'Rig|Sprint_Loop',
      jump: 'Rig|Jump_Start',
      fall: 'Rig|Jump_Loop',
      dodge: 'Rig|Roll',
      guard: 'Rig|Sword_Idle',
      'attack-01': 'Rig|Punch_Jab',
      'attack-02': 'Rig|Punch_Cross',
    },
  },
];

export const MOTION_SETS: MotionSet[] = [
  { id: 'balanced', label: 'Balanced', stride: 1, armSwing: 1, torsoLean: 1 },
  { id: 'light', label: 'Light step', stride: 0.75, armSwing: 1.25, torsoLean: 0.6 },
  { id: 'power', label: 'Power stride', stride: 1.2, armSwing: 0.8, torsoLean: 1.25 },
  {
    id: 'quaternius-universal',
    label: 'Quaternius Universal (CC0)',
    stride: 1,
    armSwing: 1,
    torsoLean: 1,
    animationUrl: '/assets/animations/quaternius-universal/AnimationLibrary_UE_Standard.glb',
    clipMap: {
      idle: 'Rig|Idle_Loop',
      walk: 'Rig|Walk_Loop',
      run: 'Rig|Sprint_Loop',
      jump: 'Rig|Jump_Start',
      fall: 'Rig|Jump_Loop',
      dodge: 'Rig|Roll',
      guard: 'Rig|Sword_Idle',
      'attack-01': 'Rig|Punch_Jab',
      'attack-02': 'Rig|Punch_Cross',
    },
  },
];

export const characterPreset = (id: string): CharacterPreset =>
  CHARACTER_PRESETS.find((preset) => preset.id === id) ?? CHARACTER_PRESETS[0]!;

export const motionSet = (id: string): MotionSet =>
  MOTION_SETS.find((set) => set.id === id) ?? MOTION_SETS[0]!;

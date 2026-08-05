/**
 * Renderer-side presentation data. Deliberately *not* a Character catalog.
 *
 * This file used to export `CHARACTER_PRESETS`: five records that were, in
 * practice, the app's real character list — they carried the model file, its
 * scale and rotation, the right-hand bone, the weapon grips and a
 * `stateId -> GLTF clip name` map. The route resolved a canonical Character; the
 * Viewport drew one of these. Two selectors, one of them invisible, and the
 * canonical one lost.
 *
 * All of that is now authored data: `CharacterDefinition.model` owns the model
 * binding and its grips, and motion sets own the takes. What is left here is the
 * part that genuinely is code:
 *
 *   - the *appearance* of the procedural characters — colours and proportions of
 *     meshes generated in code. Which appearance a Character wears is authored
 *     (`model.presetId`); what that appearance looks like is this file;
 *   - weapon-mode presentation: the label, whether a sword is held, and whether
 *     the mode's attacks drive root motion.
 *
 * Nothing here selects a Character, and nothing here names an animation clip.
 * `harness/repo-guard.ts` enforces both.
 */

export interface WeaponGrip {
  position: [number, number, number];
  rotation: [number, number, number];
}

/**
 * How a procedural humanoid is drawn. Referenced by
 * `CharacterModelBinding.presetId`, which is the authored half of this pair.
 */
export interface ProceduralAppearance {
  id: string;
  label: string;
  color: string;
  legColor: string;
  scale: number;
}

export const PROCEDURAL_APPEARANCES: ProceduralAppearance[] = [
  { id: 'navigator', label: 'Navigator (neutral)', color: '#7dd3fc', legColor: '#38bdf8', scale: 1 },
  { id: 'relay', label: 'Relay', color: '#c4b5fd', legColor: '#8b5cf6', scale: 0.92 },
  { id: 'sentinel', label: 'Sentinel', color: '#fbbf24', legColor: '#f97316', scale: 1.08 },
];

/**
 * The appearance for a preset id.
 *
 * Falls back to the first appearance so an unknown id still renders *something*
 * — but note what this fallback is and is not: it decides how an authored
 * Character is coloured, never *which* Character is shown. The route resolver
 * has no fallback at all, which is the guarantee that matters.
 */
export const proceduralAppearance = (id: string): ProceduralAppearance =>
  PROCEDURAL_APPEARANCES.find((appearance) => appearance.id === id) ?? PROCEDURAL_APPEARANCES[0]!;

export interface WeaponMode {
  id: string;
  label: string;
  heldItem?: 'sword';
  /**
   * Whether this mode's action clips drive the character's root.
   *
   * A feel decision about the mode, not a clip reference: which clip plays comes
   * from the motion set, and the displacement itself comes from the canonical
   * clip's `rootMotionMode`. This flag only says whether the imported take's
   * root track is sampled at all.
   */
  usesAttackRootMotion?: boolean;
}

/**
 * Weapon modes as *presentation*. The clips each mode plays are contextual
 * bindings on every Character's motion set (`contextualKey`), so a Character
 * whose motion set binds nothing for a mode keeps its unarmed takes instead of
 * silently half-playing another rig's animation.
 */
export const WEAPON_MODES: WeaponMode[] = [
  { id: 'unarmed', label: 'Unarmed' },
  { id: 'sword', label: 'Sword (CC0)', heldItem: 'sword', usesAttackRootMotion: true },
  // The Spell_Simple clips cast from the left hand and leave the right hand
  // open, so this mode holds nothing.
  { id: 'magic', label: 'Magic, unarmed (CC0)' },
  { id: 'pistol', label: 'Pistol, unarmed (CC0)' },
  { id: 'shield', label: 'Shield, unarmed (CC0)' },
  { id: 'throw', label: 'Throw, unarmed (CC0)' },
];

export const weaponMode = (id: string): WeaponMode =>
  WEAPON_MODES.find((mode) => mode.id === id) ?? WEAPON_MODES[0]!;

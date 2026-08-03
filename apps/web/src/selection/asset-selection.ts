/**
 * What is selected in Project/Assets — a different domain from the scene.
 *
 * Following "open the source character" from an instance must not replace the
 * scene selection: the user asked to *look at* a shared definition, not to
 * stop editing the instance they were editing. Keeping the two selections in
 * separate fields is what makes that guarantee structural instead of a rule
 * every call site has to remember.
 */

export type AssetSelection =
  | { kind: 'character'; characterId: string }
  | { kind: 'behavior'; assetKey: string }
  | { kind: 'motion-set'; assetKey: string }
  | { kind: 'clip'; assetKey: string }
  | { kind: 'rig'; assetKey: string }
  | { kind: 'tuning'; assetKey: string }
  | { kind: 'weapon-mode'; weaponModeId: string };

/** The bottom editor dock's workspaces. Not a router, and not scene state. */
export type BottomWorkspace =
  | 'project'
  // One Animation workspace with Clip Preview and State Sandbox modes inside
  // it, rather than a tab named after one of the two things it did.
  | 'animation'
  | 'timeline'
  | 'graph'
  | 'replay'
  // Secondary workspaces. Same category as the five above — places you go to
  // work, not views of the current selection — so they dock in the same strip
  // rather than crowding the Contextual Inspector.
  | 'diff'
  | 'ai'
  | 'acquisition'
  | 'capability';

/**
 * How the World viewport draws the world — not which object is selected.
 *
 * Two values, and only two. `world` and `isolate-selection` are one renderer
 * under two visibility filters (see `viewport/visibility-filter.ts`), which is
 * what lets Clip Preview and the State Sandbox be visible in both.
 *
 * `Rig` used to be a third stop here. It was never a camera mode: it is a
 * single-character authoring preview, and it made the World view able to show
 * either a skinned character or the animation preview but never both. It moved
 * to Character Lab, where single-character authoring happens (DECISION 0014).
 */
export type ViewportPresentation = 'world' | 'isolate-selection';

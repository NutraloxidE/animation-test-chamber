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
  | 'animation-preview'
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
 * How the viewport presents the world — not which object is selected.
 *
 * `isolate-selection` is what the old "focused view" actually meant: show one
 * instance rather than the crowd. Making it a presentation value is what stops
 * a display toggle from reaching into the selection model, which is what the
 * old `setWorldMode(...); setPanel('world')` pair did.
 */
export type ViewportPresentation = 'world' | 'isolate-selection';

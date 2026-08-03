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
 * How the viewport presents the world — not which object is selected.
 *
 * `isolate-selection` is what the old "focused view" actually meant: show one
 * instance rather than the crowd. Making it a presentation value is what stops
 * a display toggle from reaching into the selection model, which is what the
 * old `setWorldMode(...); setPanel('world')` pair did.
 */
/**
 * `world` and `isolate-selection` are one renderer with two visibility filters
 * (see `viewport/visibility-filter.ts`); they are not two code paths any more,
 * which is what lets Clip Preview and the State Sandbox be visible in both.
 *
 * `rig` is the legacy focused viewport, kept as an explicit presentation rather
 * than as the hidden meaning of "Isolate": it owns the skinned GLTF path, the
 * weapon-grip gizmo, the terrain mesh and the debug overlays, and every one of
 * those is still reachable. Making it a named choice is the honest version of
 * what it always was — a different renderer — instead of a second renderer that
 * Isolate silently switched you to.
 */
export type ViewportPresentation = 'world' | 'isolate-selection' | 'rig';

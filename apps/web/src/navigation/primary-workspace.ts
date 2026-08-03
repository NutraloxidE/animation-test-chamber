/**
 * The production stage the user is in.
 *
 * Deliberately *above* every selection model the app already has, and
 * deliberately not one of them. `sceneSelection` says which world object is
 * selected; `bottomWorkspace` says which editor is open; `viewportPresentation`
 * says how the scene is drawn; the animation target says whose animation is
 * being inspected. All four are correct and all four are answers to questions
 * you can only ask once you know which *stage* you are working in.
 *
 * That stage was the missing piece. The app separated its selections properly
 * and then presented them as one Chamber with scattered docks, so "add a model,
 * make it a character, put it in the world" — the actual job — had no visible
 * shape. Three stages give it one:
 *
 *   Project        reusable assets and definitions
 *   Character Lab  one shared Character Definition, made production-ready
 *   World          Character Definitions placed as Runtime Instances
 */

export type PrimaryWorkspace = 'project' | 'character-lab' | 'world';

export const PRIMARY_WORKSPACES: readonly PrimaryWorkspace[] = [
  'project',
  'character-lab',
  'world',
] as const;

export const PRIMARY_WORKSPACE_LABEL: Record<PrimaryWorkspace, string> = {
  project: 'Project',
  'character-lab': 'Character Lab',
  world: 'World',
};

/** One line each, shown as the nav item's title. Stage, not feature list. */
export const PRIMARY_WORKSPACE_PURPOSE: Record<PrimaryWorkspace, string> = {
  project: 'Add, inspect and version reusable assets and definitions.',
  'character-lab': 'Make one shared Character Definition production-ready.',
  world: 'Place Character Definitions into a world as Runtime Instances.',
};

export function isPrimaryWorkspace(value: unknown): value is PrimaryWorkspace {
  return (
    typeof value === 'string' && PRIMARY_WORKSPACES.includes(value as PrimaryWorkspace)
  );
}

/**
 * Where a user returned from, so "Open in Character Lab" can offer a way back.
 *
 * Stored rather than inferred: by the time the user wants to return, the thing
 * they came from may no longer be what is selected, and reconstructing it from
 * current state would send them somewhere they never were.
 */
export interface WorkspaceReturn {
  workspace: PrimaryWorkspace;
  label: string;
}

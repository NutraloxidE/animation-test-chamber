/**
 * Route paths, in one place.
 *
 * The route parameter is the authoritative editor target (work package §4.2),
 * so the strings that build and read it are not incidental. Two rules are
 * enforced here rather than left to each call site:
 *
 *   - identity is a stable repository **id**, never a display name. A display
 *     name contains spaces, changes independently of the thing it names, and
 *     would make a bookmarked URL stop resolving the moment somebody renamed a
 *     character;
 *   - the id is encoded and decoded exactly **once**. Doing it at both the
 *     builder and the reader produces `%2520`, and doing it at neither breaks
 *     the first id containing a slash.
 *
 * Query parameters are for transient view state only — `?panel=graph`,
 * `?selected=…`. Nothing canonical may depend on them, so no helper here
 * encourages it.
 */

export const ROUTES = {
  root: '/',
  characters: '/characters',
  scenes: '/scenes',
  rigEditor: '/edit/rig/:characterId',
  sceneEditor: '/edit/scene/:sceneId',
} as const;

/** `/edit/rig/<id>`. The id is encoded here and nowhere else. */
export function rigEditorPath(characterId: string): string {
  return `/edit/rig/${encodeURIComponent(characterId)}`;
}

/** `/edit/scene/<id>`. The id is encoded here and nowhere else. */
export function sceneEditorPath(sceneId: string): string {
  return `/edit/scene/${encodeURIComponent(sceneId)}`;
}

/**
 * The id a route parameter carries.
 *
 * React Router already decodes path parameters, so this only guards the two
 * cases that would otherwise reach a resolver as a "valid" id: an absent
 * parameter and an empty one. Both must produce a not-found state rather than a
 * lookup for the empty string, which some day matches something.
 */
export function routeId(parameter: string | undefined): string | null {
  if (parameter === undefined) return null;
  const trimmed = parameter.trim();
  return trimmed.length === 0 ? null : trimmed;
}

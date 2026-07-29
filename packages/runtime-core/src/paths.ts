/**
 * Canonical paths address a value inside the project document, e.g.
 *   /graph/transitions/run-to-attack-01/blendDurationSec
 *
 * Arrays of objects that carry an `id` are addressed by that id rather than by
 * index, so a path stays stable when items are reordered. This matters because
 * paths are what protection metadata, diffs, staging and Git conflict reporting
 * are all keyed on.
 */

export type CanonicalPath = string;

export function splitPath(path: CanonicalPath): string[] {
  return path.split('/').filter((segment) => segment.length > 0);
}

export function joinPath(segments: string[]): CanonicalPath {
  return `/${segments.join('/')}`;
}

/**
 * The stable key for an item inside an array.
 *
 * Most canonical objects carry an `id`. Input bindings do not — their identity
 * *is* the action they map to, and inventing a redundant id would make the two
 * able to disagree. Anything else falls back to its index, which is not stable
 * across reordering; that is why identified collections are preferred.
 */
export function identityOf(item: unknown, index: number): string {
  if (typeof item === 'object' && item !== null) {
    const record = item as { id?: unknown; action?: unknown };
    if (typeof record.id === 'string') return record.id;
    if (typeof record.action === 'string') return record.action;
  }
  return String(index);
}

function stepInto(current: unknown, segment: string): unknown {
  if (current === null || current === undefined) return undefined;
  if (Array.isArray(current)) {
    const byIdentity = current.find((item, index) => identityOf(item, index) === segment);
    if (byIdentity !== undefined) return byIdentity;
    const index = Number(segment);
    return Number.isInteger(index) ? current[index] : undefined;
  }
  if (typeof current === 'object') {
    return (current as Record<string, unknown>)[segment];
  }
  return undefined;
}

export function getAtPath(root: unknown, path: CanonicalPath): unknown {
  let current: unknown = root;
  for (const segment of splitPath(path)) {
    current = stepInto(current, segment);
    if (current === undefined) return undefined;
  }
  return current;
}

export function hasPath(root: unknown, path: CanonicalPath): boolean {
  return getAtPath(root, path) !== undefined;
}

/**
 * Returns a structurally-shared copy of `root` with `path` set to `value`.
 * Only the objects along the path are cloned, so React state comparison and
 * undo snapshots stay cheap.
 */
export function setAtPath<T>(root: T, path: CanonicalPath, value: unknown): T {
  const segments = splitPath(path);
  if (segments.length === 0) return value as T;

  const recurse = (current: unknown, depth: number): unknown => {
    const segment = segments[depth]!;
    const isLast = depth === segments.length - 1;

    if (Array.isArray(current)) {
      let index = current.findIndex((item, position) => identityOf(item, position) === segment);
      if (index === -1) {
        const numeric = Number(segment);
        index = Number.isInteger(numeric) ? numeric : -1;
      }
      if (index < 0 || index >= current.length) {
        throw new Error(`setAtPath: cannot resolve "${segment}" in array at ${path}`);
      }
      const copy = current.slice();
      copy[index] = isLast ? value : recurse(current[index], depth + 1);
      return copy;
    }

    if (typeof current === 'object' && current !== null) {
      const copy = { ...(current as Record<string, unknown>) };
      copy[segment] = isLast ? value : recurse(copy[segment], depth + 1);
      return copy;
    }

    throw new Error(`setAtPath: cannot descend into "${segment}" at ${path}`);
  };

  return recurse(root, 0) as T;
}

/**
 * Flattens a document into path -> leaf value. Used for diffing repository
 * state against edited state without a deep-equality walk at every call site.
 */
export function flattenValues(
  root: unknown,
  prefix = '',
  out: Map<CanonicalPath, unknown> = new Map(),
): Map<CanonicalPath, unknown> {
  if (Array.isArray(root)) {
    root.forEach((item, index) => {
      flattenValues(item, `${prefix}/${identityOf(item, index)}`, out);
    });
    return out;
  }
  if (typeof root === 'object' && root !== null) {
    for (const [key, value] of Object.entries(root as Record<string, unknown>)) {
      flattenValues(value, `${prefix}/${key}`, out);
    }
    return out;
  }
  out.set(prefix === '' ? '/' : prefix, root);
  return out;
}

/** All ancestor paths of `path`, longest first, including `path` itself. */
export function ancestorPaths(path: CanonicalPath): CanonicalPath[] {
  const segments = splitPath(path);
  const result: CanonicalPath[] = [];
  for (let i = segments.length; i > 0; i -= 1) {
    result.push(joinPath(segments.slice(0, i)));
  }
  return result;
}

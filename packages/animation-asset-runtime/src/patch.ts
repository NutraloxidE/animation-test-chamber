/**
 * Canonical patches — the mechanism behind variants, tuning profiles and
 * per-character overrides (PLAN 21, 22).
 *
 * A variant stores patches rather than a copy of its parent. That is not a
 * storage optimisation: it is what makes "the parent got a fix" a question
 * with an answer. A full copy would silently keep the old behaviour forever.
 */
import { getAtPath, identityOf, setAtPath, splitPath } from '@atc/runtime-core';
import type { CanonicalPatch, ResolutionSource, ResolvedValue } from '@atc/schema';

export interface PatchApplication {
  document: unknown;
  /** One entry per patch that changed something, in application order. */
  resolved: ResolvedValue[];
  /** Patches that could not be applied, with the reason. */
  rejected: { patch: CanonicalPatch; reason: string }[];
}

/**
 * Patches are applied to a deep copy. Assets are small (the demo behaviour is
 * sixteen states) and resolution runs on document change rather than per tick,
 * so clarity is worth more here than structural sharing.
 */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function parentOf(path: string): { parentPath: string; key: string } | null {
  const segments = splitPath(path);
  if (segments.length === 0) return null;
  const key = segments[segments.length - 1]!;
  return { parentPath: `/${segments.slice(0, -1).join('/')}`, key };
}

/** Appends to the array at `path`. Used to add a state or transition. */
function appendAtPath(root: unknown, path: string, value: unknown): unknown {
  const target = getAtPath(root, path);
  if (!Array.isArray(target)) {
    throw new Error(`append expects an array at "${path}"`);
  }
  return setAtPath(root, path, [...target, value]);
}

/** Removes the array element or object member addressed by `path`. */
function removeAtPath(root: unknown, path: string): unknown {
  const split = parentOf(path);
  if (!split) throw new Error('cannot remove the document root');
  const parent = getAtPath(root, split.parentPath);
  if (Array.isArray(parent)) {
    const next = parent.filter((item, index) => identityOf(item, index) !== split.key);
    if (next.length === parent.length) {
      throw new Error(`nothing to remove at "${path}"`);
    }
    return setAtPath(root, split.parentPath, next);
  }
  if (parent && typeof parent === 'object') {
    if (!(split.key in (parent as Record<string, unknown>))) {
      throw new Error(`nothing to remove at "${path}"`);
    }
    const next = { ...(parent as Record<string, unknown>) };
    delete next[split.key];
    return setAtPath(root, split.parentPath, next);
  }
  throw new Error(`cannot remove "${path}": no container`);
}

export interface ApplyPatchesOptions {
  source: ResolutionSource;
  sourceAsset?: { assetType: string; assetId: string; version: string; contentHash: string };
  /**
   * When true, a `set` whose path does not already exist is rejected. Variants
   * and tuning profiles patch values that must exist in the parent; letting a
   * typo quietly invent a field would make the resolved document diverge from
   * anything the schema describes.
   */
  requireExistingPath?: boolean;
  /**
   * When true, only value edits are allowed — no append, no remove. This is the
   * line between a tuning profile and a behaviour variant (PLAN 19).
   */
  valuesOnly?: boolean;
}

export function applyPatches<T>(
  document: T,
  patches: readonly CanonicalPatch[],
  options: ApplyPatchesOptions,
): PatchApplication {
  let next: unknown = clone(document);
  const resolved: ResolvedValue[] = [];
  const rejected: { patch: CanonicalPatch; reason: string }[] = [];

  for (const patch of patches) {
    try {
      if (options.valuesOnly && patch.op !== 'set') {
        throw new Error(
          `a tuning profile may only adjust values; "${patch.op}" would change structure`,
        );
      }
      if (patch.op === 'set') {
        if (options.requireExistingPath && getAtPath(next, patch.path) === undefined) {
          throw new Error(`no such path in the parent asset`);
        }
        next = setAtPath(next, patch.path, patch.value);
      } else if (patch.op === 'append') {
        next = appendAtPath(next, patch.path, patch.value);
      } else {
        next = removeAtPath(next, patch.path);
      }
      resolved.push({
        value: patch.op === 'remove' ? undefined : patch.value,
        source: options.source,
        canonicalPath: patch.path,
        ...(options.sourceAsset ? { sourceAsset: options.sourceAsset as never } : {}),
      });
    } catch (error) {
      rejected.push({
        patch,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { document: next, resolved, rejected };
}

/**
 * The patch set that turns `before` into `after`, restricted to leaf values.
 *
 * Used when a chamber edit is saved to a variant or tuning profile: the human
 * moved a slider, and what needs storing is that one value, not a document.
 */
export function diffToPatches(
  before: unknown,
  after: unknown,
  prefix = '',
): CanonicalPatch[] {
  const patches: CanonicalPatch[] = [];

  const walk = (left: unknown, right: unknown, path: string): void => {
    if (Object.is(left, right)) return;
    const bothObjects =
      left !== null &&
      right !== null &&
      typeof left === 'object' &&
      typeof right === 'object' &&
      Array.isArray(left) === Array.isArray(right);

    if (!bothObjects) {
      if (JSON.stringify(left) !== JSON.stringify(right)) {
        patches.push({ path: path === '' ? '/' : path, op: 'set', value: right });
      }
      return;
    }

    if (Array.isArray(left) && Array.isArray(right)) {
      // Arrays are keyed by identity, matching canonical path semantics, so a
      // reorder is not reported as every element changing.
      const leftKeys = left.map((item, index) => identityOf(item, index));
      const rightKeys = right.map((item, index) => identityOf(item, index));
      for (const [index, key] of rightKeys.entries()) {
        const leftIndex = leftKeys.indexOf(key);
        if (leftIndex === -1) {
          patches.push({ path: path === '' ? '/' : path, op: 'append', value: right[index] });
        } else {
          walk(left[leftIndex], right[index], `${path}/${key}`);
        }
      }
      for (const key of leftKeys) {
        if (!rightKeys.includes(key)) {
          patches.push({ path: `${path}/${key}`, op: 'remove' });
        }
      }
      return;
    }

    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    for (const key of Object.keys(rightRecord)) {
      walk(leftRecord[key], rightRecord[key], `${path}/${key}`);
    }
    for (const key of Object.keys(leftRecord)) {
      if (!(key in rightRecord)) patches.push({ path: `${path}/${key}`, op: 'remove' });
    }
  };

  walk(before, after, prefix);
  return patches;
}

/**
 * The cache key for a resolved *animation bundle*.
 *
 * Moved here from the world resolver unchanged, because it is a property of a
 * Character's animation inputs and of nothing else — the same key must be
 * computed identically by the scene resolver, the rig preview and the old world
 * resolver, and three copies of it would agree until the first one grew a
 * field.
 */
import type { AssetReference, CanonicalPatch, CharacterDefinition } from '@atc/schema';
import { referenceKey } from '@atc/schema';

/**
 * Cache key for a resolved *animation bundle*.
 *
 * Every input that can change the bundle participates: the four asset
 * references, the character's animation `instanceOverrides`, and the preview
 * overrides in force for this resolution. Nothing that only changes the
 * character wrapper does — id, display name, model path and capsule dimensions
 * are deliberately absent, because two characters that differ only in those
 * ways genuinely can share a bundle.
 *
 * Keying on the character id was the original mistake and would be wrong in
 * both directions: it under-shares between two characters with one animation
 * set, and over-shares the moment one id resolves two ways.
 */
export function animationResolutionKey(
  character: CharacterDefinition,
  previewOverrides: readonly CanonicalPatch[] = [],
): string {
  const references: (AssetReference | undefined)[] = [
    character.animation.behavior,
    character.animation.motionSet,
    character.animation.rig,
    character.animation.tuning,
  ];
  return [
    references.map((r) => (r ? referenceKey(r) : '-')).join('+'),
    canonicalPatchKey(character.animation.instanceOverrides),
    canonicalPatchKey(previewOverrides),
  ].join('#');
}

/**
 * Deterministic serialization of a patch list.
 *
 * `JSON.stringify` of a patch value follows the key insertion order of whatever
 * JSON was parsed, so two semantically identical patches read from differently
 * ordered files would hash differently and silently miss the cache. Sorting
 * object keys at every depth removes that.
 */
export function canonicalPatchKey(patches: readonly CanonicalPatch[]): string {
  return patches.map((patch) => `${patch.op}:${patch.path}=${stableJson(patch.value)}`).join('|');
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`;
}

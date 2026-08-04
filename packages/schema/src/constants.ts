/**
 * Version constants.
 *
 * Lifted out of `index.ts` so that modules inside this package can read them
 * without importing the package barrel, which would close an import cycle the
 * moment the barrel re-exported the module doing the reading.
 */

/** Bumped when simulation semantics change. Replay expectations are keyed to it. */
export const FIXED_TIMESTEP_VERSION = 1;

/**
 * Current canonical schema version for newly authored data.
 *
 * 1 -> 2: characters reference animation assets instead of embedding a graph
 * and clip list, and states name a motion slot instead of a clip id.
 */
export const CURRENT_SCHEMA_VERSION = 2;

/** The last version a compatibility loader can still read (PLAN 34.3). */
export const OLDEST_READABLE_SCHEMA_VERSION = 1;

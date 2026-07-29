export * from './common.ts';
export * from './animation.ts';
export * from './input.ts';
export * from './movement.ts';
export * from './terrain.ts';
export * from './haptics.ts';
export * from './replay.ts';
export * from './acquisition.ts';
export * from './project.ts';
export * from './validate.ts';

/** Bumped when simulation semantics change. Replay expectations are keyed to it. */
export const FIXED_TIMESTEP_VERSION = 1;

/** Current canonical schema version for newly authored data. */
export const CURRENT_SCHEMA_VERSION = 1;

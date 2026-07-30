import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import type { TSchema } from '@sinclair/typebox';
import { ProjectDefinition } from './project.ts';
import { ReplayDefinition } from './replay.ts';
import { TerrainPreset } from './terrain.ts';
import { LicenseManifest, CandidateAsset } from './acquisition.ts';
import { AnimationGraphDefinition, TransitionDefinition } from './animation.ts';
import { HapticProfile } from './haptics.ts';
import { InputMapDefinition } from './input.ts';
import { MovementProfile, CameraProfile, RootMotionProfile } from './movement.ts';
import { TerrainInteractionProfile } from './terrain.ts';

export interface ValidationIssue {
  path: string;
  message: string;
  keyword: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

/**
 * Registry of every schema that can be validated by name. UI, API, tests and
 * the Unity exporter all resolve through this map so there is exactly one
 * definition of "valid" in the system.
 */
export const SCHEMA_REGISTRY = {
  ProjectDefinition,
  ReplayDefinition,
  TerrainPreset,
  LicenseManifest,
  CandidateAsset,
  AnimationGraphDefinition,
  TransitionDefinition,
  HapticProfile,
  InputMapDefinition,
  MovementProfile,
  RootMotionProfile,
  CameraProfile,
  TerrainInteractionProfile,
} as const satisfies Record<string, TSchema>;

export type SchemaName = keyof typeof SCHEMA_REGISTRY;

// allowUnionTypes is required because TerrainFeature is a discriminated union.
const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });

const compiled = new Map<string, ValidateFunction>();

/**
 * TypeBox inlines shared sub-schemas rather than emitting $refs, so a building
 * block like ProtectionMetadata appears many times inside one document, each
 * copy carrying the same $id. Ajv rejects that as an ambiguous reference. The
 * $id values are useful when emitting standalone JSON Schema files, so they stay
 * in the definitions and are stripped here instead.
 */
export function stripSchemaIds<T>(schema: T): T {
  if (Array.isArray(schema)) {
    return schema.map((entry) => stripSchemaIds(entry)) as unknown as T;
  }
  if (schema && typeof schema === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
      if (key === '$id') continue;
      out[key] = stripSchemaIds(value);
    }
    return out as T;
  }
  return schema;
}

function compile(name: SchemaName): ValidateFunction {
  const existing = compiled.get(name);
  if (existing) return existing;
  const fn = ajv.compile(stripSchemaIds(SCHEMA_REGISTRY[name]) as object);
  compiled.set(name, fn);
  return fn;
}

function toIssues(errors: ErrorObject[] | null | undefined): ValidationIssue[] {
  if (!errors) return [];
  return errors.map((error) => ({
    path: error.instancePath === '' ? '/' : error.instancePath,
    message: error.message ?? 'invalid',
    keyword: error.keyword,
  }));
}

export function validateAgainst(name: SchemaName, data: unknown): ValidationResult {
  const fn = compile(name);
  const valid = fn(data) as boolean;
  return { valid, issues: valid ? [] : toIssues(fn.errors) };
}

export function validateProject(data: unknown): ValidationResult {
  return validateAgainst('ProjectDefinition', data);
}

/**
 * Structural checks a JSON Schema cannot express: dangling references,
 * unreachable states and duplicate ids. Run alongside validateProject.
 */
export function validateProjectReferences(project: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  const p = project as {
    clips?: { id: string }[];
    graph?: {
      states?: {
        id: string;
        clipId: string;
        weaponClips?: Record<string, string>;
        layer: string;
        fallbackState?: string;
      }[];
      transitions?: { id: string; from: string; to: string }[];
      layers?: { id: string; defaultState: string }[];
    };
    defaultTerrainPresetId?: string;
  };

  const clipIds = new Set((p.clips ?? []).map((c) => c.id));
  const states = p.graph?.states ?? [];
  const stateIds = new Set(states.map((s) => s.id));
  const transitions = p.graph?.transitions ?? [];

  const seenStates = new Set<string>();
  for (const state of states) {
    if (seenStates.has(state.id)) {
      issues.push({
        path: `/graph/states/${state.id}`,
        message: 'duplicate state id',
        keyword: 'unique',
      });
    }
    seenStates.add(state.id);
    if (!clipIds.has(state.clipId)) {
      issues.push({
        path: `/graph/states/${state.id}/clipId`,
        message: `references unknown clip "${state.clipId}"`,
        keyword: 'reference',
      });
    }
    for (const [weaponModeId, clipId] of Object.entries(state.weaponClips ?? {})) {
      if (!clipIds.has(clipId)) {
        issues.push({
          path: `/graph/states/${state.id}/weaponClips/${weaponModeId}`,
          message: `references unknown clip "${clipId}"`,
          keyword: 'reference',
        });
      }
    }
    if (state.fallbackState && !stateIds.has(state.fallbackState)) {
      issues.push({
        path: `/graph/states/${state.id}/fallbackState`,
        message: `references unknown state "${state.fallbackState}"`,
        keyword: 'reference',
      });
    }
  }

  const seenTransitions = new Set<string>();
  for (const transition of transitions) {
    if (seenTransitions.has(transition.id)) {
      issues.push({
        path: `/graph/transitions/${transition.id}`,
        message: 'duplicate transition id',
        keyword: 'unique',
      });
    }
    seenTransitions.add(transition.id);
    if (transition.from !== '*' && !stateIds.has(transition.from)) {
      issues.push({
        path: `/graph/transitions/${transition.id}/from`,
        message: `references unknown state "${transition.from}"`,
        keyword: 'reference',
      });
    }
    if (!stateIds.has(transition.to)) {
      issues.push({
        path: `/graph/transitions/${transition.id}/to`,
        message: `references unknown state "${transition.to}"`,
        keyword: 'reference',
      });
    }
  }

  for (const layer of p.graph?.layers ?? []) {
    if (!stateIds.has(layer.defaultState)) {
      issues.push({
        path: `/graph/layers/${layer.id}/defaultState`,
        message: `references unknown state "${layer.defaultState}"`,
        keyword: 'reference',
      });
    }
  }

  // Reachability, per layer, from that layer's default state.
  for (const layer of p.graph?.layers ?? []) {
    const layerStates = states.filter((s) => s.layer === layer.id);
    const reachable = new Set<string>([layer.defaultState]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const transition of transitions) {
        const toState = states.find((s) => s.id === transition.to);
        if (!toState || toState.layer !== layer.id) continue;
        const fromReachable = transition.from === '*' || reachable.has(transition.from);
        if (fromReachable && !reachable.has(transition.to)) {
          reachable.add(transition.to);
          grew = true;
        }
      }
    }
    for (const state of layerStates) {
      if (!reachable.has(state.id)) {
        issues.push({
          path: `/graph/states/${state.id}`,
          message: `state is unreachable from layer default "${layer.defaultState}"`,
          keyword: 'reachability',
        });
      }
    }
  }

  return { valid: issues.length === 0, issues };
}

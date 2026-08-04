import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import type { TSchema } from '@sinclair/typebox';
import { ProjectDefinition } from './project.ts';
import { ReplayDefinition } from './replay.ts';
import { TerrainPreset } from './terrain.ts';
import { LicenseManifest, CandidateAsset } from './acquisition.ts';
import { AnimationClipDefinition, AnimationGraphDefinition, TransitionDefinition } from './animation.ts';
import { HapticProfile } from './haptics.ts';
import { InputMapDefinition } from './input.ts';
import { MovementProfile, CameraProfile, RootMotionProfile } from './movement.ts';
import { TerrainInteractionProfile } from './terrain.ts';
import {
  AnimationBehaviorAsset,
  AnimationClipAsset,
  AnimationMotionSetAsset,
  AnimationTuningProfileAsset,
  AssetReference,
  CharacterAnimationAssignment,
  HumanoidRigProfileAsset,
} from './animation-assets.ts';
import { SaveAnimationChangesRequest } from './animation-save.ts';

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
  AnimationClipDefinition,
  TransitionDefinition,
  HapticProfile,
  InputMapDefinition,
  MovementProfile,
  RootMotionProfile,
  CameraProfile,
  TerrainInteractionProfile,
  AnimationBehaviorAsset,
  AnimationMotionSetAsset,
  AnimationClipAsset,
  HumanoidRigProfileAsset,
  AnimationTuningProfileAsset,
  AssetReference,
  CharacterAnimationAssignment,
  SaveAnimationChangesRequest,
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
 * Schema validation of a resolved document.
 *
 * A resolved project is not a `ProjectDefinition` — it carries a graph and a
 * clip list the canonical schema deliberately no longer has — so it is checked
 * in three parts against the schemas that actually own each piece. Passing the
 * whole thing to `validateProject` would report the graph as an unknown extra
 * property, which is true and useless.
 */
export function validateResolvedProject(data: unknown): ValidationResult {
  const resolved = data as {
    graph?: unknown;
    clips?: unknown[];
    character?: unknown;
    motionBindings?: unknown;
    contextualMotionBindings?: unknown;
    motionContextKeys?: unknown;
    resolution?: unknown;
    clipAssetSources?: unknown;
  };
  // The resolved-only members are destructured out so `canonical` is exactly
  // the shape ProjectDefinition describes; only `graph` and `clips` are then
  // validated separately, against the schemas that own them.
  const {
    graph,
    clips,
    character: _character,
    motionBindings: _motionBindings,
    contextualMotionBindings: _contextualMotionBindings,
    motionContextKeys: _motionContextKeys,
    resolution: _resolution,
    clipAssetSources: _clipAssetSources,
    ...canonical
  } = resolved;

  const issues: ValidationIssue[] = [...validateAgainst('ProjectDefinition', canonical).issues];
  issues.push(
    ...validateAgainst('AnimationGraphDefinition', graph).issues.map((issue) => ({
      ...issue,
      path: `/graph${issue.path === '/' ? '' : issue.path}`,
    })),
  );
  for (const clip of (clips ?? []) as { id?: string }[]) {
    issues.push(
      ...validateAgainst('AnimationClipDefinition', clip).issues.map((issue) => ({
        ...issue,
        path: `/clips/${clip.id ?? '?'}${issue.path === '/' ? '' : issue.path}`,
      })),
    );
  }
  return { valid: issues.length === 0, issues };
}

/**
 * Structural checks on the canonical project (schema v2). The graph and clips
 * no longer live here, so this is about characters and their asset references;
 * everything graph-shaped moved to `validateResolvedProjectReferences`.
 */
export function validateProjectReferences(project: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  const p = project as {
    characters?: {
      id: string;
      animation?: {
        behavior?: { assetId?: string };
        motionSet?: { assetId?: string };
        rig?: { assetId?: string };
      };
    }[];
    activeCharacterId?: string;
    equipment?: { id: string; parameter: string }[];
  };

  const characters = p.characters ?? [];
  const seenCharacters = new Set<string>();
  for (const character of characters) {
    if (seenCharacters.has(character.id)) {
      issues.push({
        path: `/characters/${character.id}`,
        message: 'duplicate character id',
        keyword: 'unique',
      });
    }
    seenCharacters.add(character.id);
    for (const slot of ['behavior', 'motionSet', 'rig'] as const) {
      if (!character.animation?.[slot]?.assetId) {
        issues.push({
          path: `/characters/${character.id}/animation/${slot}`,
          message: `character "${character.id}" has no ${slot} asset reference`,
          keyword: 'reference',
        });
      }
    }
  }

  if (p.activeCharacterId && !seenCharacters.has(p.activeCharacterId)) {
    issues.push({
      path: '/activeCharacterId',
      message: `references unknown character "${p.activeCharacterId}"`,
      keyword: 'reference',
    });
  }

  issues.push(...equipmentIssues(p.equipment ?? [], null));
  return { valid: issues.length === 0, issues };
}

/**
 * Equipment consistency. Split out because half of it is answerable from the
 * canonical project alone (duplicate slots, the `equipped*` convention) and
 * half needs a graph to read the transitions that branch on the parameter.
 */
function equipmentIssues(
  equipment: { id: string; parameter: string }[],
  transitions: { id: string; conditions?: { parameter: string }[] }[] | null,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seenSlots = new Set<string>();
  const seenParameters = new Set<string>();

  for (const slot of equipment) {
    for (const [value, seen, field] of [
      [slot.id, seenSlots, 'id'],
      [slot.parameter, seenParameters, 'parameter'],
    ] as const) {
      if (seen.has(value)) {
        issues.push({
          path: `/equipment/${slot.id}/${field}`,
          message: `duplicate equipment ${field} "${value}"`,
          keyword: 'unique',
        });
      }
      seen.add(value);
    }
    /*
     * An undeclared parameter is not a schema error — it just reads false
     * forever, so the branch never fires and the animation is silently dead.
     * That is the failure worth catching by name, and the `equipped*`
     * convention is what makes it catchable.
     */
    if (!slot.parameter.startsWith('equipped')) {
      issues.push({
        path: `/equipment/${slot.id}/parameter`,
        message: `equipment parameter "${slot.parameter}" must start with "equipped"`,
        keyword: 'convention',
      });
    }
  }

  if (transitions === null) return issues;

  const readParameters = new Set<string>();
  for (const transition of transitions) {
    for (const condition of transition.conditions ?? []) {
      readParameters.add(condition.parameter);
      if (
        condition.parameter.startsWith('equipped') &&
        !seenParameters.has(condition.parameter)
      ) {
        issues.push({
          path: `/graph/transitions/${transition.id}/conditions`,
          message: `condition reads "${condition.parameter}", which no equipment slot declares`,
          keyword: 'reference',
        });
      }
    }
  }
  for (const slot of equipment) {
    if (!readParameters.has(slot.parameter)) {
      issues.push({
        path: `/equipment/${slot.id}`,
        message: `equipment "${slot.id}" is declared but no transition branches on "${slot.parameter}"`,
        keyword: 'reference',
      });
    }
  }
  return issues;
}

/**
 * Structural checks on a *resolved* project: dangling references, unreachable
 * states, duplicate ids, and — new in schema v2 — that every state's motion
 * slot actually resolved to a clip. A missing binding used to be impossible to
 * express; now it is the most likely way a new character breaks, so it is
 * caught here rather than as an undefined clip at tick time.
 */
export function validateResolvedProjectReferences(project: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  const p = project as {
    clips?: { id: string }[];
    equipment?: { id: string; parameter: string }[];
    motionBindings?: Record<string, string>;
    graph?: {
      states?: {
        id: string;
        motionSlot: string;
        contextualMotionSlots?: Record<string, string>;
        layer: string;
        fallbackState?: string;
      }[];
      transitions?: {
        id: string;
        from: string;
        to: string;
        conditions?: { parameter: string }[];
      }[];
      layers?: { id: string; defaultState: string }[];
    };
    defaultTerrainPresetId?: string;
  };

  const clipIds = new Set((p.clips ?? []).map((c) => c.id));
  const bindings = p.motionBindings ?? {};
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
    for (const slot of [state.motionSlot, ...Object.values(state.contextualMotionSlots ?? {})]) {
      const clipId = bindings[slot];
      if (clipId === undefined) {
        issues.push({
          path: `/graph/states/${state.id}/motionSlot`,
          message: `motion slot "${slot}" is not bound by the motion set`,
          keyword: 'reference',
        });
      } else if (!clipIds.has(clipId)) {
        issues.push({
          path: `/graph/states/${state.id}/motionSlot`,
          message: `motion slot "${slot}" resolves to unknown clip "${clipId}"`,
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

  issues.push(...equipmentIssues(p.equipment ?? [], transitions));

  return { valid: issues.length === 0, issues };
}

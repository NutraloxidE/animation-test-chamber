/**
 * Which Component fields a Scene instance may override, and how (§3.2).
 *
 * The operation `scene.set_component_override` has existed since the Scene
 * cutover, and until now nothing could author one: a human could clear an
 * override and revert them all, but not create one. This is the table that
 * closes that, and its shape is the point.
 *
 * **It is an enumerated table, not a JSON Pointer editor.** §3.2 forbids
 * arbitrary pointer editing, and the reason is the same one that makes
 * `applyComponentPatches` refuse identity fields: a control that could address
 * any path could repoint `/componentType`, or reach through
 * `/assignment/motionSet` into a shared asset's contents, and every consumer
 * that had already narrowed on the old shape would be holding the wrong one. A
 * field that is not in this table cannot be overridden from the Inspector, and
 * adding one is a deliberate edit here rather than a string somebody typed.
 *
 * **Every entry carries its own bounds.** They mirror the schema's, so the
 * Inspector can refuse before staging (§3.6) — but the schema remains the
 * authority and the server re-checks. A bound that drifts from the schema makes
 * the Inspector wrong, not the document: `applySceneGameObjectOperation`
 * validates the resulting Scene either way.
 *
 * Pure and React-free: "this Component type yields exactly these fields, and
 * this input yields exactly this patch" needs no DOM.
 */
import type { CanonicalPatch, GameObjectComponentDefinition } from '@atc/schema';
import { getAtPath } from '@atc/runtime-core';
import { gameplayScriptRegistry } from '@atc/gameplay';

export type OverrideFieldKind = 'boolean' | 'number' | 'text' | 'color' | 'enum';

export interface OverrideField {
  /** Canonical path *inside the Component*, as `applyComponentPatches` reads it. */
  path: string;
  label: string;
  kind: OverrideFieldKind;
  min?: number;
  max?: number;
  step?: number;
  options?: readonly string[];
  /**
   * True when the schema marks the field optional, so clearing the input is a
   * meaningful instruction rather than an empty number.
   */
  optional?: boolean;
}

/** `enabled` is on every Component, and means the same thing on each. */
const ENABLED: OverrideField = { path: '/enabled', label: 'Enabled', kind: 'boolean' };

/**
 * The overridable fields, by Component type.
 *
 * `equipment-sockets` deliberately offers only `enabled`. Its payload is a list
 * of sockets, and the canonical path syntax resolves an array entry by an `id`
 * field — which a socket does not have; it has `socketId`. A path into that list
 * would therefore resolve *by index*, and an index means something different the
 * moment the Prefab reorders its sockets. Editing a socket is a change to the
 * shared Prefab, and the Prefab Editor is where it belongs.
 *
 * `animator.assignment` is likewise absent. Repointing an instance at a
 * different Motion Set version is a real and supported patch — it is what
 * variants do — but choosing one needs an asset picker with compatibility
 * checking, and a free-text reference field would be a way to author a dangling
 * one.
 */
const FIELDS: Record<string, readonly OverrideField[]> = {
  'model-renderer': [
    ENABLED,
    { path: '/castShadow', label: 'Cast shadow', kind: 'boolean' },
    { path: '/receiveShadow', label: 'Receive shadow', kind: 'boolean' },
  ],
  animator: [
    ENABLED,
    {
      path: '/defaultContextKey',
      label: 'Default motion context',
      kind: 'text',
      optional: true,
    },
  ],
  'character-motor': [
    ENABLED,
    { path: '/intentChannel', label: 'Intent channel', kind: 'text' },
    { path: '/movementScale', label: 'Movement scale', kind: 'number', min: 0, max: 4, step: 0.05 },
    { path: '/turnScale', label: 'Turn scale', kind: 'number', min: 0, max: 4, step: 0.05 },
  ],
  'capsule-collider': [
    ENABLED,
    { path: '/radius', label: 'Radius', kind: 'number', min: 0.05, max: 2, step: 0.01 },
    { path: '/height', label: 'Height', kind: 'number', min: 0.2, max: 4, step: 0.01 },
  ],
  'equipment-sockets': [ENABLED],
  camera: [
    ENABLED,
    {
      path: '/projection',
      label: 'Projection',
      kind: 'enum',
      options: ['perspective', 'orthographic'],
    },
    {
      path: '/fieldOfViewDeg',
      label: 'Field of view (deg)',
      kind: 'number',
      min: 1,
      max: 179,
      step: 1,
      optional: true,
    },
    {
      path: '/orthographicSize',
      label: 'Orthographic size',
      kind: 'number',
      min: 0.01,
      max: 1000,
      step: 0.01,
      optional: true,
    },
  ],
  light: [
    ENABLED,
    {
      path: '/lightType',
      label: 'Light type',
      kind: 'enum',
      options: ['directional', 'point', 'spot'],
    },
    { path: '/intensity', label: 'Intensity', kind: 'number', min: 0, max: 1000, step: 0.1 },
    { path: '/color', label: 'Colour', kind: 'color' },
    { path: '/range', label: 'Range', kind: 'number', min: 0, max: 10000, step: 0.1, optional: true },
    {
      path: '/spotAngleRad',
      label: 'Spot angle (rad)',
      kind: 'number',
      min: 0,
      max: Math.PI,
      step: 0.01,
      optional: true,
    },
  ],
  tags: [],
};

/** What the Inspector may offer for this Component type. Empty is a valid answer. */
export function overridableFields(component: string | GameObjectComponentDefinition): readonly OverrideField[] {
  const componentType = typeof component === 'string' ? component : component.componentType;
  if (typeof component !== 'string' && component.componentType === 'script') {
    const entry = gameplayScriptRegistry.resolve(component.script);
    if (!entry) return [];
    return [ENABLED, ...Object.entries(entry.definition.properties).filter(([, descriptor]) => descriptor.instanceOverride).map(([key, descriptor]) => ({
      path: `/properties/${key}`,
      label: key,
      kind: descriptor.kind === 'boolean' ? 'boolean' as const : descriptor.kind === 'number' ? 'number' as const : descriptor.kind === 'enum' ? 'enum' as const : 'text' as const,
      min: descriptor.min,
      max: descriptor.max,
      step: descriptor.step,
      options: descriptor.values,
    }))];
  }
  return FIELDS[componentType] ?? [];
}

/** The resolved value at a field, as the Inspector's control should show it. */
export function fieldValue(
  component: GameObjectComponentDefinition,
  field: OverrideField,
): string | number | boolean | undefined {
  const value = getAtPath(component, field.path);
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return value;
  }
  return undefined;
}

export type FieldPatchResult =
  | { ok: true; patch: CanonicalPatch }
  | { ok: false; message: string };

/**
 * One control's raw input, as a canonical patch — or a refusal (§3.6).
 *
 * Refused *before* staging, with the reason next to the control the human just
 * moved. The server re-checks everything below and remains authoritative; what
 * this buys is that an out-of-range number never becomes a staged operation the
 * human has to discover was refused several steps later.
 *
 * Clearing an optional field produces a `remove`, not a `set` of `undefined`: a
 * patch that set `undefined` would serialise to a document with the key present
 * and the value missing, which is a different document from the one without the
 * key and is not what "clear this" means.
 */
export function patchForField(
  field: OverrideField,
  raw: string | boolean,
): FieldPatchResult {
  // Booleans first, so the text handling below never sees `false` as "cleared".
  if (field.kind === 'boolean') {
    return { ok: true, patch: { path: field.path, op: 'set', value: Boolean(raw) } };
  }

  const text = String(raw);

  if (text.trim() === '') {
    if (!field.optional) {
      return { ok: false, message: `${field.label} is required and cannot be cleared` };
    }
    return { ok: true, patch: { path: field.path, op: 'remove' } };
  }

  switch (field.kind) {
    case 'number': {
      const value = Number(text);
      if (!Number.isFinite(value)) {
        return { ok: false, message: `${field.label} must be a finite number` };
      }
      if (field.min !== undefined && value < field.min) {
        return { ok: false, message: `${field.label} must be at least ${field.min}` };
      }
      if (field.max !== undefined && value > field.max) {
        return { ok: false, message: `${field.label} must be at most ${field.max}` };
      }
      return { ok: true, patch: { path: field.path, op: 'set', value } };
    }
    case 'enum': {
      if (!(field.options ?? []).includes(text)) {
        return {
          ok: false,
          message: `${field.label} must be one of ${(field.options ?? []).join(', ')}`,
        };
      }
      return { ok: true, patch: { path: field.path, op: 'set', value: text } };
    }
    case 'color': {
      if (!/^#[0-9a-fA-F]{6}$/.test(text)) {
        return { ok: false, message: `${field.label} must be a #rrggbb colour` };
      }
      return { ok: true, patch: { path: field.path, op: 'set', value: text } };
    }
    case 'text':
      return { ok: true, patch: { path: field.path, op: 'set', value: text } };
  }
}

/**
 * The scope a field's current value came from (§3.3).
 *
 * `OVERRIDDEN HERE` is the one that matters: it is the difference between "this
 * value is shared with every other placement of this Prefab" and "this
 * placement alone changed it", and a human about to edit needs to know which
 * before they do, not after.
 */
export type FieldScope = 'overridden-here' | 'inherited';

export function fieldScope(
  patches: readonly CanonicalPatch[] | undefined,
  field: OverrideField,
): FieldScope {
  return (patches ?? []).some((patch) => patch.path === field.path)
    ? 'overridden-here'
    : 'inherited';
}

/**
 * The override this edit produces, merged with whatever the instance already
 * overrode on the same Component.
 *
 * Merged rather than replaced, because `scene.set_component_override` replaces
 * the whole override for a node/Component pair. Sending only the field just
 * edited would silently drop every other field the instance had already
 * overridden on that Component — the human changed one number and lost the rest.
 */
export function mergePatch(
  existing: readonly CanonicalPatch[] | undefined,
  patch: CanonicalPatch,
): CanonicalPatch[] {
  const others = (existing ?? []).filter((entry) => entry.path !== patch.path);
  return [...others, patch];
}

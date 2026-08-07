/**
 * The override field table, and the patches it produces.
 *
 * These are the checks that keep the Inspector from becoming a JSON Pointer
 * editor by accident (§3.2). The table is enumerated, so the interesting
 * assertions are about what is *absent* from it and what an input is refused
 * for — not about the happy path, which is one line.
 */
import { describe, expect, it } from 'vitest';
import type { GameObjectComponentDefinition } from '@atc/schema';
import {
  fieldScope,
  fieldValue,
  mergePatch,
  overridableFields,
  patchForField,
  type OverrideField,
} from '../../../apps/web/src/scene-editor/component-override-fields.ts';

const field = (componentType: string, path: string): OverrideField => {
  const found = overridableFields(componentType).find((entry) => entry.path === path);
  if (!found) throw new Error(`no field ${path} on ${componentType}`);
  return found;
};

const light = {
  schemaVersion: 1,
  componentId: 'light',
  componentType: 'light',
  enabled: true,
  lightType: 'point',
  intensity: 2.5,
  color: '#ffd8a8',
  range: 8,
} as unknown as GameObjectComponentDefinition;

describe('what the table offers', () => {
  it('offers enabled on every Component type that has fields at all', () => {
    for (const componentType of [
      'model-renderer',
      'animator',
      'character-motor',
      'capsule-collider',
      'equipment-sockets',
      'camera',
      'light',
    ]) {
      expect(
        overridableFields(componentType).some((entry) => entry.path === '/enabled'),
        componentType,
      ).toBe(true);
    }
  });

  it('offers nothing for a Component type it does not know', () => {
    expect(overridableFields('no-such-component')).toEqual([]);
  });

  it('offers nothing for tags, which is authoring metadata', () => {
    expect(overridableFields('tags')).toEqual([]);
  });

  /*
   * The absences are the contract. A control for any of these would be a way to
   * author a patch that either addresses a shared asset's contents or resolves
   * by array position — both of which the override model exists to prevent.
   */
  it('offers no path into the Animator assignment', () => {
    const paths = overridableFields('animator').map((entry) => entry.path);
    expect(paths.some((path) => path.startsWith('/assignment'))).toBe(false);
  });

  it('offers no path into the socket list, which resolves by position', () => {
    const paths = overridableFields('equipment-sockets').map((entry) => entry.path);
    expect(paths).toEqual(['/enabled']);
  });

  it('offers no identity field on any Component type', () => {
    for (const componentType of ['model-renderer', 'animator', 'camera', 'light']) {
      const paths = overridableFields(componentType).map((entry) => entry.path);
      expect(paths).not.toContain('/componentId');
      expect(paths).not.toContain('/componentType');
      expect(paths).not.toContain('/schemaVersion');
    }
  });

  it('offers no path into the model binding, which names a shared asset', () => {
    const paths = overridableFields('model-renderer').map((entry) => entry.path);
    expect(paths.some((path) => path.startsWith('/model'))).toBe(false);
  });
});

describe('reading the current value', () => {
  it('reads a scalar at the field path', () => {
    expect(fieldValue(light, field('light', '/intensity'))).toBe(2.5);
    expect(fieldValue(light, field('light', '/color'))).toBe('#ffd8a8');
    expect(fieldValue(light, field('light', '/enabled'))).toBe(true);
  });

  it('reads an absent optional field as undefined rather than throwing', () => {
    expect(fieldValue(light, field('light', '/spotAngleRad'))).toBeUndefined();
  });
});

describe('turning an input into a patch', () => {
  it('produces a set for a valid number', () => {
    const result = patchForField(field('light', '/intensity'), '3.5');
    expect(result).toEqual({ ok: true, patch: { path: '/intensity', op: 'set', value: 3.5 } });
  });

  it('produces a set for a boolean, including false', () => {
    expect(patchForField(field('light', '/enabled'), false)).toEqual({
      ok: true,
      patch: { path: '/enabled', op: 'set', value: false },
    });
  });

  it('refuses a number outside the schema bound', () => {
    const low = patchForField(field('capsule-collider', '/radius'), '0.01');
    const high = patchForField(field('capsule-collider', '/radius'), '99');
    expect(low.ok).toBe(false);
    expect(high.ok).toBe(false);
  });

  it('refuses a non-finite number', () => {
    expect(patchForField(field('light', '/intensity'), 'not a number').ok).toBe(false);
  });

  it('refuses a colour that is not #rrggbb', () => {
    expect(patchForField(field('light', '/color'), 'red').ok).toBe(false);
    expect(patchForField(field('light', '/color'), '#fff').ok).toBe(false);
    expect(patchForField(field('light', '/color'), '#a1b2c3').ok).toBe(true);
  });

  it('refuses an enum value the schema does not have', () => {
    expect(patchForField(field('light', '/lightType'), 'area').ok).toBe(false);
    expect(patchForField(field('light', '/lightType'), 'spot').ok).toBe(true);
  });

  /*
   * Clearing an optional field is a `remove`, never a `set` of undefined. A set
   * of undefined serialises to a key that is present with no value, which is a
   * different document from one without the key.
   */
  it('clears an optional field with a remove', () => {
    expect(patchForField(field('light', '/range'), '')).toEqual({
      ok: true,
      patch: { path: '/range', op: 'remove' },
    });
  });

  it('refuses to clear a required field', () => {
    const result = patchForField(field('light', '/intensity'), '   ');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('cannot be cleared');
  });
});

describe('scope', () => {
  it('reports a field the instance overrode as overridden here', () => {
    const patches = [{ path: '/intensity', op: 'set' as const, value: 9 }];
    expect(fieldScope(patches, field('light', '/intensity'))).toBe('overridden-here');
  });

  it('reports every other field as inherited', () => {
    const patches = [{ path: '/intensity', op: 'set' as const, value: 9 }];
    expect(fieldScope(patches, field('light', '/color'))).toBe('inherited');
    expect(fieldScope(undefined, field('light', '/color'))).toBe('inherited');
  });
});

describe('merging into the existing override', () => {
  /*
   * `scene.set_component_override` replaces the whole override for a
   * node/Component pair. Sending only the field just edited would silently drop
   * every other field the instance had already overridden on that Component.
   */
  it('keeps the other overridden fields', () => {
    const existing = [
      { path: '/intensity', op: 'set' as const, value: 9 },
      { path: '/color', op: 'set' as const, value: '#000000' },
    ];
    const merged = mergePatch(existing, { path: '/range', op: 'set', value: 12 });
    expect(merged.map((patch) => patch.path).sort()).toEqual(['/color', '/intensity', '/range']);
  });

  it('replaces rather than duplicates when the same field is edited twice', () => {
    const once = mergePatch(undefined, { path: '/intensity', op: 'set', value: 1 });
    const twice = mergePatch(once, { path: '/intensity', op: 'set', value: 2 });
    expect(twice).toEqual([{ path: '/intensity', op: 'set', value: 2 }]);
  });
});

import { describe, expect, it } from 'vitest';
import { TERRAIN_PRESETS, findTerrainPreset, resolveTerrain, sampleGround, slopeAngle } from '@atc/terrain-runtime';
import { validateAgainst } from '@atc/schema';
import { loadResolvedDemoProject } from '../fixtures/project.ts';

const project = loadResolvedDemoProject();
const profile = project.terrain;

function query(overrides: Partial<Parameters<typeof resolveTerrain>[2]> = {}) {
  return {
    position: { x: 0, y: 0, z: 0 },
    yawRad: 0,
    verticalVelocity: 0,
    horizontalSpeed: 0,
    wasGrounded: true,
    timeSec: 0,
    ...overrides,
  };
}

describe('terrain presets', () => {
  it('provides every preset named in the plan', () => {
    const ids = TERRAIN_PRESETS.map((preset) => preset.id);
    for (const expected of [
      'flat',
      'gentle-uphill',
      'gentle-downhill',
      'steep-slope',
      'small-step',
      'stairs',
      'ledge',
      'narrow-platform',
      'uneven-ground',
      'wall',
      'moving-platform',
      'rotating-platform',
      'ice',
      'mud',
      'high-friction',
    ]) {
      expect(ids).toContain(expected);
    }
  });

  it('validates every preset against the schema', () => {
    for (const preset of TERRAIN_PRESETS) {
      const result = validateAgainst('TerrainPreset', preset);
      expect(result.issues, `${preset.id}: ${JSON.stringify(result.issues)}`).toEqual([]);
    }
  });
});

describe('ground sampling', () => {
  it('returns flat ground for the flat preset', () => {
    const sample = sampleGround(findTerrainPreset('flat'), 0, 0, 0);
    expect(sample.height).toBe(0);
    expect(sample.normal.y).toBe(1);
  });

  it('rises across a slope and tilts the normal', () => {
    const preset = findTerrainPreset('gentle-uphill');
    const bottom = sampleGround(preset, 0, 2, 0);
    const middle = sampleGround(preset, 0, 7, 0);
    const top = sampleGround(preset, 0, 12, 0);

    expect(bottom.height).toBeCloseTo(0, 5);
    expect(middle.height).toBeCloseTo(1, 5);
    expect(top.height).toBeCloseTo(2, 5);
    expect(slopeAngle(middle.normal)).toBeGreaterThan(0.1);
  });

  it('steps up in discrete increments on stairs', () => {
    const preset = findTerrainPreset('stairs');
    const first = sampleGround(preset, 0, 3.1, 0);
    const second = sampleGround(preset, 0, 3.5, 0);
    expect(first.height).toBeCloseTo(0.18, 5);
    expect(second.height).toBeCloseTo(0.36, 5);
  });

  it('reports no ground past a ledge', () => {
    const preset = findTerrainPreset('ledge');
    expect(sampleGround(preset, 0, 5, 0).height).toBe(0);
    expect(sampleGround(preset, 0, 7, 0).height).toBeNull();
  });

  it('takes the highest contributor when features overlap', () => {
    const preset = findTerrainPreset('small-step');
    // A box sits on top of the base plane.
    expect(sampleGround(preset, 0, 6, 0).height).toBeCloseTo(0.2, 5);
    expect(sampleGround(preset, 0, 20, 0).height).toBeCloseTo(0, 5);
  });

  it('moves a platform deterministically with simulation time', () => {
    const preset = findTerrainPreset('moving-platform');
    const atZero = sampleGround(preset, 0, 8, 0);
    const atQuarter = sampleGround(preset, 0, 8, 1.5);
    expect(atZero.platformVelocity.x).toBeGreaterThan(0);
    // A quarter period in, the platform is at its extreme and momentarily still.
    expect(Math.abs(atQuarter.platformVelocity.x)).toBeLessThan(0.01);
    expect(sampleGround(preset, 0, 8, 0).platformVelocity.x).toBe(atZero.platformVelocity.x);
  });

  it('carries surface material properties', () => {
    expect(sampleGround(findTerrainPreset('ice'), 0, 0, 0).surface.accelerationScale).toBeLessThan(0.5);
    expect(sampleGround(findTerrainPreset('mud'), 0, 0, 0).surface.dragScale).toBeGreaterThan(1);
  });
});

describe('terrain state detection', () => {
  it('reports Grounded on flat ground', () => {
    const result = resolveTerrain(findTerrainPreset('flat'), profile, query());
    expect(result.grounded).toBe(true);
    expect(result.state).toBe('Grounded');
  });

  it('reports Airborne when far above the ground', () => {
    const result = resolveTerrain(findTerrainPreset('flat'), profile, query({ position: { x: 0, y: 5, z: 0 } }));
    expect(result.grounded).toBe(false);
    expect(result.state).toBe('Airborne');
  });

  it('reports SlopeUp while ascending', () => {
    const result = resolveTerrain(
      findTerrainPreset('gentle-uphill'),
      profile,
      query({ position: { x: 0, y: 1, z: 7 } }),
    );
    expect(result.state).toBe('SlopeUp');
  });

  it('reports SlopeDown while descending', () => {
    const result = resolveTerrain(
      findTerrainPreset('gentle-downhill'),
      profile,
      query({ position: { x: 0, y: -1, z: 7 } }),
    );
    expect(result.state).toBe('SlopeDown');
  });

  it('reports Sliding on a slope past the slide angle', () => {
    const result = resolveTerrain(
      findTerrainPreset('steep-slope'),
      profile,
      query({ position: { x: 0, y: 4.8, z: 5 } }),
    );
    expect(result.state).toBe('Sliding');
  });

  it('reports NearLedge when the ground ahead disappears', () => {
    const result = resolveTerrain(
      findTerrainPreset('ledge'),
      profile,
      query({ position: { x: 0, y: 0, z: 5.8 } }),
    );
    expect(result.nearLedge).toBe(true);
    expect(result.state).toBe('NearLedge');
  });

  it('reports AgainstWall when the obstacle ahead is too high to step onto', () => {
    const result = resolveTerrain(
      findTerrainPreset('wall'),
      profile,
      query({ position: { x: 0, y: 0, z: 7.3 } }),
    );
    expect(result.againstWall).toBe(true);
    expect(result.state).toBe('AgainstWall');
  });

  it('reports OnMovingPlatform and inherits its velocity', () => {
    const result = resolveTerrain(
      findTerrainPreset('moving-platform'),
      profile,
      query({ position: { x: 0, y: 0, z: 8 } }),
    );
    expect(result.state).toBe('OnMovingPlatform');
    expect(Math.abs(result.platformVelocity.x)).toBeGreaterThan(0);
  });

  it('classifies landing severity by impact speed', () => {
    const light = resolveTerrain(
      findTerrainPreset('flat'),
      profile,
      query({ wasGrounded: false, verticalVelocity: -2 }),
    );
    const heavy = resolveTerrain(
      findTerrainPreset('flat'),
      profile,
      query({ wasGrounded: false, verticalVelocity: -12 }),
    );
    expect(light.state).toBe('LandingLight');
    expect(heavy.state).toBe('LandingHeavy');
  });

  it('slows the character going uphill and not downhill', () => {
    const uphill = resolveTerrain(
      findTerrainPreset('gentle-uphill'),
      profile,
      query({ position: { x: 0, y: 1, z: 7 } }),
    );
    const downhill = resolveTerrain(
      findTerrainPreset('gentle-downhill'),
      profile,
      query({ position: { x: 0, y: -1, z: 7 } }),
    );
    expect(uphill.speedScale).toBeLessThan(1);
    expect(downhill.speedScale).toBeGreaterThan(1);
  });
});

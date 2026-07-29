import type { SurfaceMaterial, TerrainPreset } from '@atc/schema';

/**
 * Terrain presets are canonical data expressed as typed TypeScript rather than
 * loose JSON, so the compiler enforces the schema at author time and there is
 * exactly one definition to edit. `pnpm schema:generate` emits the JSON view
 * under presets/terrain/ for the Unity export bundle. See DECISIONS/0003.
 */

const DEFAULT: SurfaceMaterial = { id: 'default', friction: 1, accelerationScale: 1, dragScale: 1 };
const ICE: SurfaceMaterial = { id: 'ice', friction: 0.98, accelerationScale: 0.15, dragScale: 0.05 };
const MUD: SurfaceMaterial = { id: 'mud', friction: 0.55, accelerationScale: 0.6, dragScale: 2.5 };
const GRIP: SurfaceMaterial = { id: 'grip', friction: 1, accelerationScale: 1.6, dragScale: 1.8 };

const base = (id: string, label: string, features: TerrainPreset['features'], surfaces = [DEFAULT]): TerrainPreset => ({
  schemaVersion: 1,
  id,
  label,
  features,
  surfaces,
});

export const TERRAIN_PRESETS: TerrainPreset[] = [
  base('flat', 'Flat', [{ kind: 'plane', height: 0, surface: 'default' }]),

  base('gentle-uphill', 'Gentle uphill', [
    { kind: 'plane', height: 0, surface: 'default' },
    { kind: 'slope', startZ: 2, endZ: 12, rise: 2, surface: 'default' },
  ]),

  base('gentle-downhill', 'Gentle downhill', [
    { kind: 'slope', startZ: 2, endZ: 12, rise: -2, surface: 'default' },
  ]),

  // ~58°, deliberately past the demo profile's 54° slide angle so this preset
  // actually exercises sliding rather than being a merely brisk walk.
  base('steep-slope', 'Steep slope', [
    { kind: 'plane', height: 0, surface: 'default' },
    { kind: 'slope', startZ: 2, endZ: 7, rise: 8, surface: 'default' },
  ]),

  base('small-step', 'Small step', [
    { kind: 'plane', height: 0, surface: 'default' },
    { kind: 'box', center: { x: 0, y: 0.1, z: 6 }, size: { x: 12, y: 0.2, z: 8 }, surface: 'default' },
  ]),

  base('stairs', 'Stairs', [
    { kind: 'plane', height: 0, surface: 'default' },
    { kind: 'steps', startZ: 3, stepDepth: 0.32, stepHeight: 0.18, count: 14, surface: 'default' },
  ]),

  base('ledge', 'Ledge', [{ kind: 'ledge', edgeZ: 6, height: 0, surface: 'default' }]),

  base('narrow-platform', 'Narrow platform', [
    { kind: 'box', center: { x: 0, y: 0, z: 0 }, size: { x: 1.4, y: 0.4, z: 24 }, surface: 'default' },
  ]),

  base('uneven-ground', 'Uneven ground', [
    { kind: 'plane', height: -0.4, surface: 'default' },
    { kind: 'uneven', amplitude: 0.22, frequencyX: 0.9, frequencyZ: 0.7, surface: 'default' },
  ]),

  base('wall', 'Wall and low obstacle', [
    { kind: 'plane', height: 0, surface: 'default' },
    { kind: 'box', center: { x: 0, y: 1, z: 8 }, size: { x: 10, y: 2, z: 1 }, surface: 'default' },
    { kind: 'box', center: { x: 0, y: 0.15, z: 4 }, size: { x: 3, y: 0.3, z: 0.8 }, surface: 'default' },
  ]),

  base('moving-platform', 'Moving platform', [
    { kind: 'plane', height: -3, surface: 'default' },
    { kind: 'box', center: { x: 0, y: -0.1, z: 0 }, size: { x: 6, y: 0.2, z: 6 }, surface: 'default' },
    {
      kind: 'moving-platform',
      center: { x: 0, y: -0.1, z: 8 },
      size: { x: 4, y: 0.2, z: 4 },
      axis: 'x',
      amplitude: 3,
      periodSec: 6,
      angularVelocity: 0,
      surface: 'default',
    },
  ]),

  base('rotating-platform', 'Rotating platform', [
    { kind: 'plane', height: -3, surface: 'default' },
    {
      kind: 'moving-platform',
      center: { x: 0, y: -0.1, z: 0 },
      size: { x: 6, y: 0.2, z: 6 },
      axis: 'y',
      amplitude: 0,
      periodSec: 8,
      angularVelocity: 0.6,
      surface: 'default',
    },
  ]),

  base('ice', 'Ice', [{ kind: 'plane', height: 0, surface: 'ice' }], [DEFAULT, ICE]),

  base('mud', 'Mud', [{ kind: 'plane', height: 0, surface: 'mud' }], [DEFAULT, MUD]),

  base(
    'high-friction',
    'High-friction surface',
    [{ kind: 'plane', height: 0, surface: 'grip' }],
    [DEFAULT, GRIP],
  ),
];

export function findTerrainPreset(id: string): TerrainPreset {
  const preset = TERRAIN_PRESETS.find((candidate) => candidate.id === id);
  if (!preset) {
    throw new Error(
      `unknown terrain preset "${id}"; available: ${TERRAIN_PRESETS.map((p) => p.id).join(', ')}`,
    );
  }
  return preset;
}

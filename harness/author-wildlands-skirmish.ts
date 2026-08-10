/**
 * Authors the Wildlands Skirmish canonical data.
 *
 * A generator rather than a hand-written Scene, for the reason §6 of the brief
 * asks for: the arena's placement must be *reproducible*. Every tree, rock and
 * mountain comes out of one seeded stream, so re-running this produces the same
 * world, and a reviewer can read the intent — clusters, clearings, a corridor
 * between the two bases — instead of ninety literal coordinates.
 *
 * It writes three kinds of thing and nothing else:
 *
 *   low-poly glTF meshes   apps/web/public/assets/environment/wildlands/
 *   Prefabs                assets/prefabs/<id>/1.0.0.json
 *   one Scene              projects/demo-character/project.json
 *
 * Run with `pnpm assets:wildlands`. Nothing about the game reads this file at
 * runtime; it is an authoring tool whose output is the canonical data.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { computeContentHash } from '@atc/animation-asset-runtime';
import type {
  GameObjectInstanceDefinition,
  GameObjectPrefabAsset,
  GameObjectPrefabReference,
  ProjectDefinition,
  SceneDefinition,
} from '@atc/schema';
import { gameplayScriptRegistry } from '@atc/gameplay';
import { REPO_ROOT, writeRepoFile } from './lib.ts';
import { buildPrefabIndexFile } from './generate-prefab-asset-index.ts';
import { PREFAB_LIBRARY_INDEX_PATH, loadPrefabRegistry } from './prefabs.ts';

const SCENE_ID = 'wildlands-skirmish';
const MESH_DIR = 'apps/web/public/assets/environment/wildlands';
const MESH_URL = '/assets/environment/wildlands';
const CREATED_AT = '2026-08-09T00:00:00.000Z';
const CREATED_BY = 'assets:wildlands';

/* -------------------------------------------------------------------------- */
/* A very small glTF writer                                                    */
/* -------------------------------------------------------------------------- */

interface Part {
  positions: number[];
  normals: number[];
  indices: number[];
  color: [number, number, number];
  emissive?: [number, number, number];
  roughness?: number;
  metallic?: number;
}

type Vec = [number, number, number];

function quad(part: Part, a: Vec, b: Vec, c: Vec, d: Vec): void {
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const uz = b[2] - a[2];
  const vx = d[0] - a[0];
  const vy = d[1] - a[1];
  const vz = d[2] - a[2];
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const length = Math.hypot(nx, ny, nz) || 1;
  const base = part.positions.length / 3;
  for (const vertex of [a, b, c, d]) {
    part.positions.push(vertex[0], vertex[1], vertex[2]);
    part.normals.push(nx / length, ny / length, nz / length);
  }
  part.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

function triangle(part: Part, a: Vec, b: Vec, c: Vec): void {
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const uz = b[2] - a[2];
  const vx = c[0] - a[0];
  const vy = c[1] - a[1];
  const vz = c[2] - a[2];
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const length = Math.hypot(nx, ny, nz) || 1;
  const base = part.positions.length / 3;
  for (const vertex of [a, b, c]) {
    part.positions.push(vertex[0], vertex[1], vertex[2]);
    part.normals.push(nx / length, ny / length, nz / length);
  }
  part.indices.push(base, base + 1, base + 2);
}

function emptyPart(color: [number, number, number], extra: Partial<Part> = {}): Part {
  return { positions: [], normals: [], indices: [], color, ...extra };
}

function box(part: Part, cx: number, cy: number, cz: number, w: number, h: number, d: number): void {
  const x0 = cx - w / 2;
  const x1 = cx + w / 2;
  const y0 = cy - h / 2;
  const y1 = cy + h / 2;
  const z0 = cz - d / 2;
  const z1 = cz + d / 2;
  quad(part, [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]);
  quad(part, [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]);
  quad(part, [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]);
  quad(part, [x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]);
  quad(part, [x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]);
  quad(part, [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]);
}

/** A cone, cylinder or truncated cone, depending on the two radii. */
function tube(
  part: Part,
  cx: number,
  y0: number,
  cz: number,
  height: number,
  bottomRadius: number,
  topRadius: number,
  segments: number,
  jitter: (index: number) => number = () => 1,
): void {
  const y1 = y0 + height;
  for (let index = 0; index < segments; index += 1) {
    const a0 = (Math.PI * 2 * index) / segments;
    const a1 = (Math.PI * 2 * (index + 1)) / segments;
    const j0 = jitter(index);
    const j1 = jitter(index + 1);
    const b0: Vec = [cx + Math.cos(a0) * bottomRadius * j0, y0, cz + Math.sin(a0) * bottomRadius * j0];
    const b1: Vec = [cx + Math.cos(a1) * bottomRadius * j1, y0, cz + Math.sin(a1) * bottomRadius * j1];
    const t0: Vec = [cx + Math.cos(a0) * topRadius * j0, y1, cz + Math.sin(a0) * topRadius * j0];
    const t1: Vec = [cx + Math.cos(a1) * topRadius * j1, y1, cz + Math.sin(a1) * topRadius * j1];
    if (topRadius < 1e-4) triangle(part, b0, b1, [cx, y1, cz]);
    else quad(part, b0, b1, t1, t0);
    if (bottomRadius > 1e-4) triangle(part, [cx, y0, cz], b1, b0);
    if (topRadius > 1e-4) triangle(part, [cx, y1, cz], t0, t1);
  }
}

/** A faceted blob: good enough for a rock, and cheap. */
function blob(part: Part, cx: number, cy: number, cz: number, radius: number, seed: number): void {
  const rings = 4;
  const segments = 7;
  const random = mulberry32(seed);
  const offsets: number[][] = [];
  for (let ring = 0; ring <= rings; ring += 1) {
    const row: number[] = [];
    for (let segment = 0; segment <= segments; segment += 1) row.push(0.72 + random() * 0.5);
    row[segments] = row[0]!;
    offsets.push(row);
  }
  const point = (ring: number, segment: number): Vec => {
    const phi = (Math.PI * ring) / rings;
    const theta = (Math.PI * 2 * segment) / segments;
    const r = radius * offsets[ring]![segment % segments]!;
    return [
      cx + Math.sin(phi) * Math.cos(theta) * r,
      cy + Math.cos(phi) * r * 0.85,
      cz + Math.sin(phi) * Math.sin(theta) * r,
    ];
  };
  for (let ring = 0; ring < rings; ring += 1) {
    for (let segment = 0; segment < segments; segment += 1) {
      quad(part, point(ring, segment), point(ring, segment + 1), point(ring + 1, segment + 1), point(ring + 1, segment));
    }
  }
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Packs parts into one self-contained glTF document with an embedded buffer. */
function gltfDocument(parts: Part[]): string {
  const chunks: Buffer[] = [];
  let offset = 0;
  const bufferViews: Record<string, number>[] = [];
  const accessors: Record<string, unknown>[] = [];
  const meshPrimitives: Record<string, unknown>[] = [];
  const materials: Record<string, unknown>[] = [];

  const pushView = (data: Buffer, target: number): number => {
    const padding = (4 - (offset % 4)) % 4;
    if (padding > 0) {
      chunks.push(Buffer.alloc(padding));
      offset += padding;
    }
    chunks.push(data);
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.byteLength, target });
    offset += data.byteLength;
    return bufferViews.length - 1;
  };

  for (const part of parts) {
    const positions = Buffer.from(new Float32Array(part.positions).buffer);
    const normals = Buffer.from(new Float32Array(part.normals).buffer);
    const indices = Buffer.from(new Uint32Array(part.indices).buffer);
    const positionView = pushView(positions, 34962);
    const normalView = pushView(normals, 34962);
    const indexView = pushView(indices, 34963);

    const min: Vec = [Infinity, Infinity, Infinity];
    const max: Vec = [-Infinity, -Infinity, -Infinity];
    for (let index = 0; index < part.positions.length; index += 3) {
      for (let axis = 0; axis < 3; axis += 1) {
        const value = part.positions[index + axis]!;
        min[axis] = Math.min(min[axis]!, value);
        max[axis] = Math.max(max[axis]!, value);
      }
    }
    accessors.push({ bufferView: positionView, componentType: 5126, count: part.positions.length / 3, type: 'VEC3', min, max });
    accessors.push({ bufferView: normalView, componentType: 5126, count: part.normals.length / 3, type: 'VEC3' });
    accessors.push({ bufferView: indexView, componentType: 5125, count: part.indices.length, type: 'SCALAR' });
    materials.push({
      pbrMetallicRoughness: {
        baseColorFactor: [...part.color, 1],
        metallicFactor: part.metallic ?? 0,
        roughnessFactor: part.roughness ?? 0.92,
      },
      emissiveFactor: part.emissive ?? [0, 0, 0],
      doubleSided: true,
    });
    const base = accessors.length - 3;
    meshPrimitives.push({
      attributes: { POSITION: base, NORMAL: base + 1 },
      indices: base + 2,
      material: materials.length - 1,
    });
  }

  const buffer = Buffer.concat(chunks);
  const document = {
    asset: { version: '2.0', generator: 'atc-wildlands-authoring' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'wildlands-prop' }],
    meshes: [{ primitives: meshPrimitives }],
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength: buffer.byteLength, uri: `data:application/octet-stream;base64,${buffer.toString('base64')}` }],
  };
  return `${JSON.stringify(document)}\n`;
}

/* -------------------------------------------------------------------------- */
/* The props themselves                                                        */
/* -------------------------------------------------------------------------- */

const GRASS: [number, number, number] = [0.32, 0.46, 0.22];
const GRASS_DARK: [number, number, number] = [0.24, 0.37, 0.18];
const BARK: [number, number, number] = [0.28, 0.2, 0.13];
const LEAF: [number, number, number] = [0.2, 0.42, 0.19];
const PINE: [number, number, number] = [0.14, 0.31, 0.2];
const STONE: [number, number, number] = [0.45, 0.44, 0.42];
const STONE_DARK: [number, number, number] = [0.32, 0.32, 0.33];
const ALLY: [number, number, number] = [0.16, 0.42, 0.85];
const ENEMY: [number, number, number] = [0.72, 0.16, 0.18];

function meshes(): Record<string, Part[]> {
  const random = mulberry32(20260809);
  const table: Record<string, Part[]> = {};

  /* Ground: one big low plate, plus a ring skirt so the horizon is not a void. */
  const ground = emptyPart(GRASS);
  box(ground, 0, -0.5, 0, 260, 1, 260);
  const groundPatch = emptyPart(GRASS_DARK);
  for (let index = 0; index < 26; index += 1) {
    const angle = random() * Math.PI * 2;
    const radius = 6 + random() * 44;
    tube(groundPatch, Math.cos(angle) * radius, 0.008, Math.sin(angle) * radius, 0.004, 2 + random() * 5, 2 + random() * 5, 7);
  }
  table['ground'] = [ground, groundPatch];

  /* A gentle hill: a wide, shallow dome. Decorative relief around the arena. */
  const hill = emptyPart(GRASS_DARK);
  tube(hill, 0, 0, 0, 2.4, 9, 4.5, 12, (index) => 0.9 + ((index * 37) % 11) / 40);
  tube(hill, 0, 2.4, 0, 1.1, 4.5, 1.4, 12);
  table['hill'] = [hill];

  /* The outer boundary: big faceted cones, read as mountains from the arena. */
  const mountain = emptyPart(STONE_DARK);
  tube(mountain, 0, 0, 0, 22, 13, 1.6, 9, (index) => 0.82 + ((index * 53) % 13) / 26);
  const snow = emptyPart([0.86, 0.88, 0.92]);
  tube(snow, 0, 17.5, 0, 4.6, 3.6, 0.6, 9);
  table['mountain'] = [mountain, snow];

  const broadleafTrunk = emptyPart(BARK);
  tube(broadleafTrunk, 0, 0, 0, 2.6, 0.28, 0.2, 6);
  const broadleafCanopy = emptyPart(LEAF);
  blob(broadleafCanopy, 0, 3.6, 0, 1.75, 7);
  blob(broadleafCanopy, 0.8, 2.9, 0.5, 1.1, 11);
  table['tree-broadleaf'] = [broadleafTrunk, broadleafCanopy];

  const pineTrunk = emptyPart(BARK);
  tube(pineTrunk, 0, 0, 0, 1.4, 0.24, 0.18, 6);
  const pineCanopy = emptyPart(PINE);
  tube(pineCanopy, 0, 1.1, 0, 2.1, 1.55, 0, 8);
  tube(pineCanopy, 0, 2.6, 0, 1.9, 1.15, 0, 8);
  tube(pineCanopy, 0, 3.9, 0, 1.7, 0.8, 0, 8);
  table['tree-pine'] = [pineTrunk, pineCanopy];

  const rock = emptyPart(STONE);
  blob(rock, 0, 0.55, 0, 1.05, 23);
  blob(rock, 0.9, 0.3, 0.4, 0.55, 29);
  table['rock'] = [rock];

  /* The central landmark: a leaning monolith on a stone shelf. */
  const landmarkBase = emptyPart(STONE_DARK);
  tube(landmarkBase, 0, 0, 0, 1.1, 5.2, 4.2, 9);
  blob(landmarkBase, 3.4, 0.9, 1.6, 1.5, 41);
  blob(landmarkBase, -2.8, 0.8, -2.4, 1.3, 43);
  const landmarkSpire = emptyPart([0.51, 0.47, 0.55]);
  tube(landmarkSpire, 0, 1.1, 0, 12.5, 1.5, 0.55, 7);
  const landmarkCrown = emptyPart([0.95, 0.78, 0.32], { emissive: [0.35, 0.24, 0.05], roughness: 0.4 });
  tube(landmarkCrown, 0, 13.6, 0, 1.5, 0.7, 0, 6);
  table['landmark'] = [landmarkBase, landmarkSpire, landmarkCrown];

  for (const [name, accent, lamp] of [
    ['shop', ALLY, [1, 0.82, 0.42] as [number, number, number]],
    ['camp', ENEMY, [1, 0.42, 0.3] as [number, number, number]],
  ] as const) {
    const posts = emptyPart(BARK);
    for (const [x, z] of [
      [-2.2, -1.6],
      [2.2, -1.6],
      [-2.2, 1.6],
      [2.2, 1.6],
    ] as const)
      box(posts, x, 1.3, z, 0.22, 2.6, 0.22);
    box(posts, 0, 1, 1.6, 4.6, 0.9, 0.5);
    const roof = emptyPart(accent);
    box(roof, 0, 2.75, 0, 5.4, 0.28, 4.2);
    tube(roof, 0, 2.9, 0, 1.5, 3.2, 0.2, 4);
    const lantern = emptyPart(lamp, { emissive: lamp, roughness: 0.3 });
    /* Lit, so the base is findable at night without any lighting rule. */
    box(lantern, -2.2, 2.7, -1.6, 0.34, 0.34, 0.34);
    box(lantern, 2.2, 2.7, 1.6, 0.34, 0.34, 0.34);
    table[name] = [posts, roof, lantern];
  }

  const coin = emptyPart([0.98, 0.79, 0.24], { emissive: [0.35, 0.26, 0.04], metallic: 0.6, roughness: 0.3 });
  tube(coin, 0, -0.06, 0, 0.12, 0.34, 0.34, 10);
  table['coin'] = [coin];

  return table;
}

/* -------------------------------------------------------------------------- */
/* Prefabs                                                                     */
/* -------------------------------------------------------------------------- */

function seal(asset: GameObjectPrefabAsset): GameObjectPrefabAsset {
  return { ...asset, metadata: { ...asset.metadata, contentHash: computeContentHash(asset) } };
}

function propPrefab(id: string, displayName: string, meshName: string, tags: string[], scripts: unknown[] = []): GameObjectPrefabAsset {
  return seal({
    metadata: {
      schemaVersion: 1,
      assetType: 'game-object-prefab',
      id,
      version: '1.0.0',
      displayName,
      description: `Wildlands Skirmish scenery: ${displayName}.`,
      tags: ['wildlands', ...tags],
      createdAt: CREATED_AT,
      createdBy: CREATED_BY,
      contentHash: '',
    },
    derivation: { mode: 'base' },
    abstract: false,
    root: {
      nodeId: 'root',
      displayName,
      enabled: true,
      transform: {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1, y: 1, z: 1 },
      },
      components: [
        {
          schemaVersion: 1,
          componentId: 'model',
          componentType: 'model-renderer',
          enabled: true,
          model: { kind: 'repository-model', assetPath: `${MESH_URL}/${meshName}.gltf`, scale: 1, rotationYRad: 0 },
          castShadow: true,
          receiveShadow: true,
        },
        { schemaVersion: 1, componentId: 'tags', componentType: 'tags', enabled: true, tags: ['wildlands', ...tags] },
        ...(scripts as never[]),
      ],
      children: [],
    },
  } as unknown as GameObjectPrefabAsset);
}

function scriptComponent(componentId: string, scriptId: string, properties: Record<string, unknown>): unknown {
  const reference = gameplayScriptRegistry.find({ assetId: scriptId, version: '1.0.0' })?.reference;
  if (!reference) throw new Error(`gameplay script "${scriptId}" is not registered; run pnpm gameplay:generate`);
  return {
    schemaVersion: 1,
    componentId,
    componentType: 'script',
    enabled: true,
    script: { assetType: 'gameplay-script', assetId: scriptId, version: '1.0.0', contentHash: reference.contentHash },
    properties,
  };
}

/** The combatant Prefab: Universal Base plus sockets, team colour and script. */
function combatantPrefab(team: 'ally' | 'enemy'): GameObjectPrefabAsset {
  const id = `wildlands-${team}-combatant`;
  return seal({
    metadata: {
      schemaVersion: 1,
      assetType: 'game-object-prefab',
      id,
      version: '1.0.0',
      displayName: team === 'ally' ? 'Wildlands Ally' : 'Wildlands Raider',
      description: 'Universal Base Superhero composed for Wildlands Skirmish: canonical rig, motion set and behaviour, plus the sockets the game hangs equipment and team markers on.',
      tags: ['character', 'humanoid', 'wildlands', `skirmish-${team}`],
      createdAt: CREATED_AT,
      createdBy: CREATED_BY,
      contentHash: '',
    },
    derivation: {
      mode: 'variant',
      parent: prefabReference('quaternius-universal-base'),
      patches: [
        {
          kind: 'patch-component',
          nodeId: 'root',
          componentId: 'tags',
          patches: [
            {
              path: '/tags',
              op: 'set',
              value: ['character', 'humanoid', 'skirmish-combatant', `skirmish-${team}`, ...(team === 'ally' ? [] : [])],
            },
          ],
        },
        {
          kind: 'patch-component',
          nodeId: 'root',
          componentId: 'animator',
          patches: [
            /*
             * One targeted graph override, not a retimed animation library: the
             * canonical `any-to-hit` transition already exists and already
             * enters the authored `universal-hit` take — it just listens for a
             * parameter nothing could set. Pointing it at the namespaced
             * gameplay parameter is what lets a Script *state* that damage
             * landed while the behaviour asset keeps owning the reaction.
             */
            {
              path: '/assignment/instanceOverrides',
              op: 'set',
              value: [
                {
                  path: '/graph/transitions/any-to-hit/conditions',
                  op: 'set',
                  value: [{ parameter: 'gameplay.damaged', operator: 'equals', value: true }],
                },
              ],
            },
          ],
        },
        {
          kind: 'patch-component',
          nodeId: 'root',
          componentId: 'equipment-sockets',
          patches: [
            {
              path: '/sockets',
              op: 'set',
              value: [
                /* The authored grip stays exactly as the base Prefab had it. */
                { socketId: 'right-hand-sword', boneName: 'hand_r', localPosition: [0, -0.035, 0], localRotation: [0, 1.5707963267948966, -0.18], acceptedItemTags: ['sword'] },
                { socketId: 'left-hand', boneName: 'hand_l', localPosition: [0, -0.03, 0], localRotation: [0, -1.5707963267948966, 0.18], acceptedItemTags: ['shield', 'focus'] },
                { socketId: 'head', boneName: 'Head', localPosition: [0, 0.06, 0.01], localRotation: [0, 0, 0], acceptedItemTags: ['helmet'] },
                { socketId: 'chest', boneName: 'spine_03', localPosition: [0, 0.02, 0.02], localRotation: [0, 0, 0], acceptedItemTags: ['chest-armor'] },
                { socketId: 'pelvis', boneName: 'pelvis', localPosition: [0, 0, 0], localRotation: [0, 0, 0], acceptedItemTags: ['leg-armor'] },
                /* No bone: these ride the object, so they stay level. */
                { socketId: 'overhead', localPosition: [0, 2.15, 0], localRotation: [0, 0, 0], acceptedItemTags: ['marker'] },
                { socketId: 'ground', localPosition: [0, 0.02, 0], localRotation: [0, 0, 0], acceptedItemTags: ['team-ring'] },
              ],
            },
          ],
        },
      ],
    },
    abstract: false,
  } as unknown as GameObjectPrefabAsset);
}

let registryCache: ReturnType<typeof loadPrefabRegistry> | null = null;
function prefabReference(assetId: string, version = '1.0.0'): GameObjectPrefabReference {
  registryCache ??= loadPrefabRegistry();
  return registryCache.referenceTo(assetId, version);
}

/* -------------------------------------------------------------------------- */
/* The Scene                                                                   */
/* -------------------------------------------------------------------------- */

const ARENA_RADIUS = 46;
const ALLY_BASE = { x: 0, z: 32 };
const ENEMY_BASE = { x: 0, z: -32 };

interface Placement {
  id: string;
  prefab: string;
  x: number;
  z: number;
  yaw: number;
  scale: number;
}

/**
 * Scenery placement.
 *
 * Clustered rather than uniformly scattered, because a uniform scatter reads as
 * noise and — more importantly — leaves no clearings for ten characters to
 * fight in. Clusters are seeded from one stream and every candidate is rejected
 * if it lands in the central arena, in a base, or in the corridor between them.
 */
function scenery(): Placement[] {
  const random = mulberry32(0x5ba7);
  const placements: Placement[] = [];
  const blocked: { x: number; z: number; radius: number }[] = [
    { x: 0, z: 0, radius: 13 },
    { x: ALLY_BASE.x, z: ALLY_BASE.z, radius: 13 },
    { x: ENEMY_BASE.x, z: ENEMY_BASE.z, radius: 13 },
  ];
  const free = (x: number, z: number, clearance: number): boolean => {
    if (Math.hypot(x, z) > ARENA_RADIUS + 4) return false;
    for (const zone of blocked) if (Math.hypot(x - zone.x, z - zone.z) < zone.radius + clearance) return false;
    for (const placement of placements) if (Math.hypot(x - placement.x, z - placement.z) < 2.4) return false;
    /* A walkable corridor down the middle, so the two bases can always meet. */
    if (Math.abs(x) < 5.5) return false;
    return true;
  };

  let index = 0;
  for (let cluster = 0; cluster < 9; cluster += 1) {
    const angle = (Math.PI * 2 * cluster) / 9 + random() * 0.5;
    const radius = 18 + random() * 22;
    const cx = Math.cos(angle) * radius;
    const cz = Math.sin(angle) * radius;
    const density = 3 + Math.floor(random() * 5);
    for (let tree = 0; tree < density; tree += 1) {
      const x = cx + (random() - 0.5) * 11;
      const z = cz + (random() - 0.5) * 11;
      if (!free(x, z, 1)) continue;
      index += 1;
      placements.push({
        id: `wildlands-tree-${index}`,
        prefab: random() < 0.55 ? 'wildlands-tree-pine' : 'wildlands-tree-broadleaf',
        x,
        z,
        yaw: random() * Math.PI * 2,
        scale: 0.85 + random() * 0.55,
      });
    }
  }

  for (let rock = 0; rock < 16; rock += 1) {
    const angle = random() * Math.PI * 2;
    const radius = 15 + random() * 28;
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;
    if (!free(x, z, 0.5)) continue;
    placements.push({
      id: `wildlands-rock-${rock + 1}`,
      prefab: 'wildlands-rock',
      x,
      z,
      yaw: random() * Math.PI * 2,
      scale: 0.7 + random() * 1.5,
    });
  }

  for (let hill = 0; hill < 7; hill += 1) {
    const angle = (Math.PI * 2 * hill) / 7 + 0.4;
    const radius = 40 + random() * 6;
    placements.push({
      id: `wildlands-hill-${hill + 1}`,
      prefab: 'wildlands-hill',
      x: Math.cos(angle) * radius,
      z: Math.sin(angle) * radius,
      yaw: random() * Math.PI * 2,
      scale: 1 + random() * 0.9,
    });
  }

  for (let mountain = 0; mountain < 13; mountain += 1) {
    const angle = (Math.PI * 2 * mountain) / 13 + 0.17;
    const radius = 62 + random() * 10;
    placements.push({
      id: `wildlands-mountain-${mountain + 1}`,
      prefab: 'wildlands-mountain',
      x: Math.cos(angle) * radius,
      z: Math.sin(angle) * radius,
      yaw: random() * Math.PI * 2,
      scale: 0.85 + random() * 0.9,
    });
  }

  return placements;
}

function instance(
  id: string,
  displayName: string,
  prefab: GameObjectPrefabReference,
  position: { x: number; y: number; z: number },
  yaw: number,
  scale = 1,
  extra: Partial<GameObjectInstanceDefinition> = {},
): GameObjectInstanceDefinition {
  return {
    schemaVersion: 2,
    id,
    displayName,
    enabled: true,
    prefab,
    transform: {
      position,
      rotation: { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) },
      scale: { x: scale, y: scale, z: scale },
    },
    componentOverrides: [],
    bindings: {},
    relations: {},
    ...extra,
  } as GameObjectInstanceDefinition;
}

function combatantInstances(): GameObjectInstanceDefinition[] {
  const objects: GameObjectInstanceDefinition[] = [];
  const coinHash = prefabReference('wildlands-coin').contentHash;
  for (const team of ['ally', 'enemy'] as const) {
    const base = team === 'ally' ? ALLY_BASE : ENEMY_BASE;
    const facing = team === 'ally' ? Math.PI : 0;
    for (let seat = 1; seat <= 5; seat += 1) {
      const isPlayer = team === 'ally' && seat === 1;
      const angle = (Math.PI * 2 * (seat - 1)) / 5;
      const x = base.x + Math.cos(angle) * 4.2;
      const z = base.z + Math.sin(angle) * 4.2;
      const id = isPlayer ? 'skirmish-player' : `skirmish-${team}-${seat}`;
      objects.push(
        instance(
          id,
          isPlayer ? 'Player' : `${team === 'ally' ? 'Ally' : 'Raider'} ${seat}`,
          prefabReference(`wildlands-${team}-combatant`),
          { x, y: 0.2, z },
          facing,
          1,
          {
            bindings: { characterIntent: isPlayer ? { kind: 'human', playerIndex: 0 } : { kind: 'ai', channelId: `${id}-ai` } },
            componentOverrides: [
              {
                nodeId: 'root',
                componentId: 'combatant',
                patches: [
                  { path: '/properties/team', op: 'set', value: team },
                  { path: '/properties/seat', op: 'set', value: seat },
                  { path: '/properties/isPlayer', op: 'set', value: isPlayer },
                  { path: '/properties/spawnX', op: 'set', value: base.x },
                  { path: '/properties/spawnZ', op: 'set', value: base.z },
                  { path: '/properties/safeZoneX', op: 'set', value: ALLY_BASE.x },
                  { path: '/properties/safeZoneZ', op: 'set', value: ALLY_BASE.z },
                  { path: '/properties/startingLoadout', op: 'set', value: isPlayer ? 0 : (seat - 1) % 4 },
                ],
              },
            ],
          },
        ),
      );
    }
  }
  /* The tag the AI uses to recognise the player it is threatening. */
  const player = objects.find((object) => object.id === 'skirmish-player');
  if (player)
    player.componentOverrides = [
      ...player.componentOverrides,
      { nodeId: 'root', componentId: 'tags', patches: [{ path: '/tags', op: 'set', value: ['character', 'humanoid', 'skirmish-combatant', 'skirmish-ally', 'skirmish-player'] }] },
    ] as never;
  if (coinHash === '') throw new Error('coin prefab hash is empty');
  return objects;
}

function buildScene(): SceneDefinition {
  const objects: GameObjectInstanceDefinition[] = [];
  objects.push(instance('wildlands-ground', 'Grassland', prefabReference('wildlands-ground'), { x: 0, y: 0, z: 0 }, 0));
  objects.push(instance('wildlands-landmark', 'Sunspire Monolith', prefabReference('wildlands-landmark'), { x: 0, y: 0, z: 0 }, 0.3));
  objects.push(instance('wildlands-shop', 'Quartermaster', prefabReference('wildlands-shop'), { x: ALLY_BASE.x + 6, y: 0, z: ALLY_BASE.z + 2 }, Math.PI));
  objects.push(instance('wildlands-camp', 'Raider Camp', prefabReference('wildlands-camp'), { x: ENEMY_BASE.x - 6, y: 0, z: ENEMY_BASE.z - 2 }, 0));
  for (const placement of scenery())
    objects.push(instance(placement.id, placement.id, prefabReference(placement.prefab), { x: placement.x, y: 0, z: placement.z }, placement.yaw, placement.scale));

  objects.push(...combatantInstances());

  objects.push(
    instance('match-director', 'Match Director', prefabReference('wildlands-director'), { x: 0, y: 0, z: 0 }, 0, 1, {
      componentOverrides: [
        {
          nodeId: 'root',
          componentId: 'director',
          patches: [
            { path: '/properties/pickupPrefabHash', op: 'set', value: prefabReference('wildlands-coin').contentHash },
            { path: '/properties/debugEnabled', op: 'set', value: true },
          ],
        },
      ] as never,
    }),
  );

  /*
   * A dim fill only. The match's own sun is animated by the game layer from the
   * day clock, so an authored light at full strength would flatten dusk and
   * make night as bright as noon; this one exists so the Scene still reads in
   * an editor viewport that has no game running.
   */
  objects.push(
    instance('scene-light', 'Scene Fill Light', prefabReference('default-scene-light'), { x: 30, y: 60, z: 20 }, 0, 1, {
      componentOverrides: [
        {
          nodeId: 'root',
          componentId: 'light',
          patches: [
            { path: '/intensity', op: 'set', value: 0.35 },
            { path: '/color', op: 'set', value: '#cfe0ff' },
          ],
        },
      ] as never,
    }),
  );
  objects.push(
    instance('scene-camera', 'Scene Camera', prefabReference('default-scene-camera'), { x: ALLY_BASE.x, y: 3.4, z: ALLY_BASE.z + 7 }, 0, 1, {
      relations: { cameraTargetGameObjectId: 'skirmish-player' },
    }),
  );

  return {
    schemaVersion: 2,
    id: SCENE_ID,
    displayName: 'Wildlands Skirmish',
    entities: [],
    intentTracks: [],
    gameObjects: objects,
    activeCameraGameObjectId: 'scene-camera',
  } as unknown as SceneDefinition;
}

/* -------------------------------------------------------------------------- */

function writePrefab(asset: GameObjectPrefabAsset): void {
  writeRepoFile(`assets/prefabs/${asset.metadata.id}/${asset.metadata.version}.json`, `${JSON.stringify(asset, null, 2)}\n`);
  registryCache = null;
}

function main(): void {
  mkdirSync(resolve(REPO_ROOT, MESH_DIR), { recursive: true });
  for (const [name, parts] of Object.entries(meshes())) {
    writeFileSync(resolve(REPO_ROOT, MESH_DIR, `${name}.gltf`), gltfDocument(parts));
  }
  console.log(`wrote ${Object.keys(meshes()).length} glTF props`);

  writePrefab(propPrefab('wildlands-ground', 'Wildlands Ground', 'ground', ['scenery', 'ground']));
  writePrefab(propPrefab('wildlands-hill', 'Wildlands Hill', 'hill', ['scenery']));
  writePrefab(propPrefab('wildlands-mountain', 'Wildlands Mountain', 'mountain', ['scenery', 'boundary']));
  writePrefab(propPrefab('wildlands-tree-broadleaf', 'Wildlands Broadleaf', 'tree-broadleaf', ['scenery', 'tree']));
  writePrefab(propPrefab('wildlands-tree-pine', 'Wildlands Pine', 'tree-pine', ['scenery', 'tree']));
  writePrefab(propPrefab('wildlands-rock', 'Wildlands Rock', 'rock', ['scenery', 'rock']));
  writePrefab(propPrefab('wildlands-landmark', 'Sunspire Monolith', 'landmark', ['scenery', 'landmark']));
  writePrefab(propPrefab('wildlands-shop', 'Quartermaster Stall', 'shop', ['landmark', 'shop']));
  writePrefab(propPrefab('wildlands-camp', 'Raider Camp', 'camp', ['landmark', 'camp']));
  writePrefab(
    propPrefab('wildlands-coin', 'Wildlands Scrip', 'coin', ['pickup', 'skirmish-pickup'], [
      scriptComponent('spin', 'spin-and-bob', { turnsPerSecond: 0.7, bobHeight: 0.18, bobPerSecond: 0.8 }),
    ]),
  );

  /* The director is an ordinary GameObject: a script and nothing else. */
  writePrefab(
    seal({
      metadata: {
        schemaVersion: 1,
        assetType: 'game-object-prefab',
        id: 'wildlands-director',
        version: '1.0.0',
        displayName: 'Wildlands Match Director',
        description: 'The match lifecycle, day clock, score, economy and progression for Wildlands Skirmish.',
        tags: ['wildlands', 'skirmish-director'],
        createdAt: CREATED_AT,
        createdBy: CREATED_BY,
        contentHash: '',
      },
      derivation: { mode: 'base' },
      abstract: false,
      root: {
        nodeId: 'root',
        displayName: 'Match Director',
        enabled: true,
        transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } },
        components: [
          { schemaVersion: 1, componentId: 'tags', componentType: 'tags', enabled: true, tags: ['wildlands', 'skirmish-director'] },
          scriptComponent('director', 'skirmish-director', {
            playerId: 'skirmish-player',
            matchSeconds: 300,
            endingSeconds: 7,
            bannerSeconds: 2.6,
            koXp: 40,
            assistXp: 15,
            koCurrency: 14,
            potionHeal: 45,
            startingPotions: 1,
            pickupLifetimeSeconds: 26,
            pickupRadius: 2.4,
            pickupPrefabId: 'wildlands-coin',
            pickupPrefabVersion: '1.0.0',
            pickupPrefabHash: '',
            debugEnabled: true,
          }),
        ],
        children: [],
      },
    } as unknown as GameObjectPrefabAsset),
  );

  for (const team of ['ally', 'enemy'] as const) {
    const prefab = combatantPrefab(team);
    const withScript = seal({
      ...prefab,
      derivation: {
        ...prefab.derivation,
        patches: [
          ...(prefab.derivation as { patches: unknown[] }).patches,
          {
            kind: 'add-component',
            nodeId: 'root',
            component: scriptComponent('combatant', 'skirmish-combatant', {
              team,
              seat: 1,
              isPlayer: false,
              directorId: 'match-director',
              spawnX: team === 'ally' ? ALLY_BASE.x : ENEMY_BASE.x,
              spawnZ: team === 'ally' ? ALLY_BASE.z : ENEMY_BASE.z,
              baseMaxHp: 120,
              baseMaxStamina: 100,
              baseAttack: 22,
              baseDefense: 5,
              staminaRegenPerSecond: 11,
              dodgeStaminaCost: 24,
              attackWindupSeconds: 0.22,
              aggroRadius: 26,
              leashRadius: 40,
              arenaRadius: ARENA_RADIUS,
              respawnSeconds: 3,
              spawnProtectionSeconds: 2,
              safeZoneRadius: 11,
              safeZoneX: ALLY_BASE.x,
              safeZoneZ: ALLY_BASE.z,
              startingLoadout: 0,
            }),
          },
        ],
      },
    } as unknown as GameObjectPrefabAsset);
    writePrefab(withScript);
  }

  writeRepoFile(PREFAB_LIBRARY_INDEX_PATH, buildPrefabIndexFile());

  const projectPath = resolve(REPO_ROOT, 'projects/demo-character/project.json');
  const project = JSON.parse(readFileSync(projectPath, 'utf8')) as ProjectDefinition & { scenes: SceneDefinition[] };
  const scene = buildScene();
  const existing = project.scenes.findIndex((candidate) => candidate.id === SCENE_ID);
  if (existing >= 0) project.scenes[existing] = scene;
  else project.scenes.push(scene);
  writeFileSync(projectPath, `${JSON.stringify(project, null, 2)}\n`);
  console.log(`wrote Scene "${SCENE_ID}" with ${scene.gameObjects?.length ?? 0} GameObjects`);
  writeRepoFile(PREFAB_LIBRARY_INDEX_PATH, buildPrefabIndexFile());
}

main();

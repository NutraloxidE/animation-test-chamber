import type {
  GameObjectPrefabAsset,
  ReplayDefinition,
  ResolvedProject,
  SceneDefinition,
} from '@atc/schema';
import {
  ACTION_NAMES,
  BaseGameObjectPrefabAsset,
  GameObjectComponentDefinition,
  GameObjectInstanceDefinition,
  prefabAssetFilePath,
  AnimationGraphDefinition,
  CameraProfile,
  HapticProfile,
  InputMapDefinition,
  MovementProfile,
  ProjectDefinition as ProjectSchema,
  ReplayDefinition as ReplaySchema,
  RootMotionProfile,
  TerrainInteractionProfile,
  TerrainPreset,
} from '@atc/schema';
import { TERRAIN_PRESETS } from '@atc/terrain-runtime';
import { generateCSharpDtos } from './csharp.ts';
import { ADAPTER_FILES } from './scaffold.ts';

export interface ExportFile {
  path: string;
  content: string;
}

const TERRAIN_STATES = [
  'Grounded',
  'SlopeUp',
  'SlopeDown',
  'Sliding',
  'NearLedge',
  'SteppingUp',
  'SteppingDown',
  'Airborne',
  'LandingLight',
  'LandingHeavy',
  'OnMovingPlatform',
  'AgainstWall',
];

const SEMANTIC_EVENTS = [
  'FootContactLeft',
  'FootContactRight',
  'AttackWindup',
  'AttackHit',
  'AttackRecoil',
  'JumpTakeoff',
  'Landing',
  'DamageReceived',
  'DodgeStart',
  'DodgeEnd',
  'GuardImpact',
];

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Builds the Unity export bundle (PLAN 16.1).
 *
 * Everything here is a generated artifact. The browser side stays canonical:
 * nothing in this bundle is ever read back as a source of truth, which is why
 * each file carries a `_generated` marker and the adapter README says so.
 */
export interface UnityPrefabExport {
  id: string;
  version: string;
  document: GameObjectPrefabAsset;
}

export function buildUnityBundle(
  project: ResolvedProject,
  replays: ReplayDefinition[],
  generatedAt = new Date().toISOString(),
  prefabs: readonly UnityPrefabExport[] = [],
): ExportFile[] {
  const marker = {
    _generated: true,
    _source: 'Animation Test Chamber browser runtime',
    _generatedAt: generatedAt,
    _warning: 'Regenerate with `pnpm unity:export`. Edits here are overwritten and never imported back.',
  };

  const files: ExportFile[] = [
    { path: 'project.json', content: json({ ...marker, project }) },
    { path: 'animation-graph.json', content: json({ ...marker, graph: project.graph }) },
    { path: 'input-map.json', content: json({ ...marker, inputMap: project.inputMap }) },
    {
      path: 'movement-profile.json',
      content: json({ ...marker, movement: project.movement, rootMotion: project.rootMotion }),
    },
    {
      path: 'terrain-profile.json',
      content: json({ ...marker, terrain: project.terrain, presets: TERRAIN_PRESETS }),
    },
    { path: 'haptic-profile.json', content: json({ ...marker, haptics: project.haptics }) },
    {
      path: 'assets-manifest.json',
      content: json({
        ...marker,
        character: {
          id: project.character.id,
          /*
           * The binding, not a flattened path. A procedural appearance has no
           * file to import, and emitting `null` for it told the Unity side
           * "some character" — the same ambiguity the web catalog used to
           * carry. `kind` makes the importer's two cases explicit.
           */
          model: project.character.model,
          skeletonId: project.character.skeleton.id,
        },
        clips: project.clips.map((clip) => ({
          id: clip.id,
          assetPath: clip.assetPath,
          proceduralGenerator: clip.proceduralGenerator ?? null,
          // An imported clip is a *take* inside a file. Exporting the path
          // without the take name would leave the Unity importer guessing
          // which of forty animations this clip meant.
          externalSource: clip.externalSource ?? null,
          durationSec: clip.durationSec,
          rootMotionMode: clip.rootMotionMode,
          rootMotionCurve: clip.rootMotionCurve ?? 'Linear',
          recoveryTransitionStartNormalized:
            clip.recoveryTransitionStartNormalized ?? null,
        })),
        // Licence terms travel with the manifest so an export cannot quietly
        // strip provenance from an asset that had restrictions attached.
        candidates: project.candidates.map((candidate) => ({
          id: candidate.id,
          state: candidate.state,
          license: candidate.provenance.license,
        })),
      }),
    },
  ];

  for (const replay of replays) {
    files.push({ path: `replays/${replay.id}.json`, content: json({ ...marker, replay }) });
  }

  /*
   * Prefabs and Scene instances travel as the same split the canonical data
   * uses (§16): one reusable asset per Prefab version, and Scene GameObjects
   * that *reference* one. The adapter turns the first into a Unity prefab and
   * the second into an instantiation — and gets no special path per former
   * entity kind, because there are no longer any kinds to special-case.
   *
   * Ids and versions are preserved exactly. A Unity-side rename would break
   * the one property that makes this bundle checkable against the repository.
   */
  for (const prefab of prefabs) {
    files.push({
      path: `prefabs/${prefab.id}/${prefab.version}.json`,
      content: json({ ...marker, prefab: prefab.document }),
    });
  }
  files.push({
    path: 'prefabs/manifest.json',
    content: json({
      ...marker,
      prefabs: prefabs.map((prefab) => ({
        id: prefab.id,
        version: prefab.version,
        contentHash: prefab.document.metadata.contentHash,
        abstract: prefab.document.abstract,
        derivation: prefab.document.derivation.mode,
        canonicalPath: prefabAssetFilePath(prefab.id, prefab.version),
        sourcePath: `prefabs/${prefab.id}/${prefab.version}.json`,
      })),
      scenes: project.scenes.map((scene: SceneDefinition) => ({
        id: scene.id,
        activeCameraGameObjectId: scene.activeCameraGameObjectId ?? null,
        gameObjects: (scene.gameObjects ?? []).map((gameObject) => ({
          id: gameObject.id,
          prefab: gameObject.prefab,
        })),
      })),
    }),
  });

  const dtos = generateCSharpDtos(
    {
      ProjectDefinition: ProjectSchema,
      AnimationGraphDefinition,
      InputMapDefinition,
      MovementProfile,
      RootMotionProfile,
      TerrainInteractionProfile,
      TerrainPreset,
      CameraProfile,
      HapticProfile,
      ReplayDefinition: ReplaySchema,
      GameObjectPrefabAsset: BaseGameObjectPrefabAsset,
      GameObjectComponentDefinition,
      GameObjectInstanceDefinition,
    },
    {
      Action: [...ACTION_NAMES],
      TerrainState: TERRAIN_STATES,
      SemanticEvent: SEMANTIC_EVENTS,
    },
  );

  files.push({ path: 'AnimationTestChamberAdapter/Runtime/Generated/ChamberDtos.cs', content: dtos });

  for (const file of ADAPTER_FILES) {
    files.push({ path: `AnimationTestChamberAdapter/${file.path}`, content: file.content });
  }

  return files;
}

import { Type, type Static } from '@sinclair/typebox';
import { Id, ProtectionMetadata, SchemaVersion, ValueProvenance } from './common.ts';
import { AnimationClipDefinition, AnimationGraphDefinition, SkeletonDefinition } from './animation.ts';
import { CharacterAnimationAssignment, type AssetReference, type ResolvedValue } from './animation-assets.ts';
import { InputMapDefinition } from './input.ts';
import { CameraProfile, MovementProfile, RootMotionProfile } from './movement.ts';
import { TerrainInteractionProfile } from './terrain.ts';
import { HapticProfile } from './haptics.ts';
import { CandidateAsset } from './acquisition.ts';
import { SceneDefinition } from './scene.ts';
import { WorldDefinition } from './world.ts';

/**
 * A procedural appearance generated in code, named by preset id.
 *
 * The appearance is code, but *which* appearance a Character wears is authored
 * data — that is the whole distinction this binding exists to draw. Before it,
 * the answer lived in a web-only catalog the route could not reach, so two
 * Characters could look identical while claiming to be different, and a
 * different-looking preview could be mistaken for a different Character.
 */
const ProceduralHumanoidBinding = Type.Object(
  {
    kind: Type.Literal('procedural-humanoid'),
    /** Appearance preset id, resolved by the renderer against its own catalog. */
    presetId: Id,
  },
  { additionalProperties: false },
);

/** An imported model file in the repository, with the transform it needs. */
const RepositoryModelBinding = Type.Object(
  {
    kind: Type.Literal('repository-model'),
    /** Path the web app can fetch, e.g. `/assets/characters/<id>/<file>.glb`. */
    assetPath: Type.String({ minLength: 1 }),
    scale: Type.Number({ minimum: 0.001, maximum: 1000 }),
    rotationYRad: Type.Number({ minimum: -Math.PI * 2, maximum: Math.PI * 2 }),
    /** Bone a held item attaches to. Absent means this model holds nothing. */
    rightHandBone: Type.Optional(Type.String({ minLength: 1 })),
    /**
     * Where a held item sits in that bone's local space, per weapon mode.
     *
     * Authored defaults, not session state. These were preset fields, which
     * meant a grip a human had positioned by hand belonged to a preview record
     * rather than to the Character — so it could not be reviewed, and the
     * transient in-browser override was the only place it existed.
     */
    weaponGrips: Type.Optional(
      Type.Record(
        Type.String({ minLength: 1 }),
        Type.Object(
          {
            position: Type.Tuple([Type.Number(), Type.Number(), Type.Number()]),
            rotation: Type.Tuple([Type.Number(), Type.Number(), Type.Number()]),
          },
          { additionalProperties: false },
        ),
      ),
    ),
  },
  { additionalProperties: false },
);

/**
 * How a Character is *shown* — authored, not previewed.
 *
 * Model choice is Character identity (work package §3.2). It is stored beside
 * the animation references rather than resolved from a renderer-side catalog,
 * so `/edit/rig/<id>` and the Viewport cannot disagree about who is on screen.
 */
export const CharacterModelBinding = Type.Union(
  [ProceduralHumanoidBinding, RepositoryModelBinding],
  { $id: 'CharacterModelBinding' },
);
export type CharacterModelBinding = Static<typeof CharacterModelBinding>;

export const CharacterDefinition = Type.Object(
  {
    schemaVersion: SchemaVersion,
    id: Id,
    displayName: Type.String(),
    /**
     * The one authored answer to "which model is this?". Replaces the old
     * nullable `modelAssetPath`, whose `null` meant "some procedural character,
     * ask the renderer" — a question only a web-only catalog could answer.
     */
    model: CharacterModelBinding,
    /** Meters; used for capsule probes and step-up checks. */
    capsuleRadius: Type.Number({ minimum: 0.05, maximum: 2 }),
    capsuleHeight: Type.Number({ minimum: 0.2, maximum: 4 }),
    /**
     * References, not contents. A character that owned its graph and clips
     * could not share them, which is the entire problem this replaces.
     */
    animation: CharacterAnimationAssignment,
    protection: Type.Optional(ProtectionMetadata),
  },
  { $id: 'CharacterDefinition', additionalProperties: false },
);
export type CharacterDefinition = Static<typeof CharacterDefinition>;

/**
 * Learned per-project preferences (PLAN 14.4). This is not model training —
 * it is canonical data the rule-based provider reads before proposing.
 */
export const PreferenceProfile = Type.Object(
  {
    schemaVersion: SchemaVersion,
    preferredBlendMinSec: Type.Number({ minimum: 0, maximum: 2 }),
    preferredBlendMaxSec: Type.Number({ minimum: 0, maximum: 2 }),
    /** 0 = weighty, 1 = twitchy. */
    responsiveness: Type.Number({ minimum: 0, maximum: 1 }),
    momentumPreference: Type.Number({ minimum: 0, maximum: 1 }),
    rootMotionPolicy: Type.Union([
      Type.Literal('prefer-in-place'),
      Type.Literal('prefer-root-motion'),
      Type.Literal('prefer-hybrid'),
    ]),
    ikCorrectionPreference: Type.Number({ minimum: 0, maximum: 1 }),
    hapticIntensityPreference: Type.Number({ minimum: 0, maximum: 1 }),
    /** Accepted/rejected proposal variants, newest last. */
    acceptanceHistory: Type.Array(
      Type.Object(
        {
          proposalVariant: Type.String(),
          accepted: Type.Boolean(),
          humanAdjustedAfter: Type.Boolean(),
          at: Type.String(),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { $id: 'PreferenceProfile', additionalProperties: false },
);
export type PreferenceProfile = Static<typeof PreferenceProfile>;

export const RevisionDefinition = Type.Object(
  {
    schemaVersion: SchemaVersion,
    id: Type.String({ minLength: 1 }),
    parentId: Type.Union([Type.String(), Type.Null()]),
    createdAt: Type.String(),
    author: Type.String(),
    message: Type.String(),
    /** Canonical paths touched by this revision. */
    changedPaths: Type.Array(Type.String()),
    provenance: Type.Optional(ValueProvenance),
    /** Git commit SHA once the revision reaches a branch. */
    commitSha: Type.Optional(Type.String()),
  },
  { $id: 'RevisionDefinition', additionalProperties: false },
);
export type RevisionDefinition = Static<typeof RevisionDefinition>;

/**
 * One toggleable piece of equipment.
 *
 * The slot exists so equipment is *data*: declaring it here is the whole job.
 * The parameter becomes a boolean transitions can test, the chamber grows a
 * toggle for it, and a state branches to the equipped pose by naming that
 * parameter in a condition — no code anywhere learns the word "shield".
 * Adding the next slot is this object plus the transitions that read it.
 */
export const EquipmentSlotDefinition = Type.Object(
  {
    id: Id,
    /** Boolean parameter name transition conditions test, e.g. `equippedShield`. */
    parameter: Type.String({ minLength: 1 }),
    label: Type.String(),
    /** Whether the chamber opens with this equipped. */
    defaultEquipped: Type.Boolean(),
    protection: Type.Optional(ProtectionMetadata),
  },
  { $id: 'EquipmentSlotDefinition', additionalProperties: false },
);
export type EquipmentSlotDefinition = Static<typeof EquipmentSlotDefinition>;

export const ProjectDefinition = Type.Object(
  {
    schemaVersion: SchemaVersion,
    id: Id,
    displayName: Type.String(),
    /** Current revision id; bumped on every applied change. */
    revisionId: Type.String({ minLength: 1 }),
    /**
     * Every character in the project. The demo ships two so that "one behaviour,
     * two characters" is a thing the repository *demonstrates* rather than a
     * thing the architecture merely permits.
     */
    characters: Type.Array(CharacterDefinition, { minItems: 1 }),
    /** Which character the chamber opens with. */
    activeCharacterId: Id,
    /**
     * Every Scene in the project.
     *
     * May be empty, and an empty list is not a degenerate case: a repository
     * that only authors reusable Characters is a legitimate shape, and the Rig
     * Editor needs no Scene to open one. The old singular optional `world` is
     * gone — `scenes` replaced it — and a document still carrying `world` is a
     * legacy document, read only through `loadProjectDocument`.
     */
    scenes: Type.Array(SceneDefinition),
    /**
     * Which Scene the Scene list opens on.
     *
     * A *navigation preference*, nothing more. `/edit/scene/:sceneId` resolves
     * its target from the route and never consults this field, so a stale or
     * absent `activeSceneId` cannot cause one Scene's edits to land in another.
     */
    activeSceneId: Type.Optional(Id),
    /**
     * The legacy multi-instance world.
     *
     * @deprecated Migration-only, and removed once `@atc/world-runtime` retires.
     * Production code must read `scenes` — `harness:repo-guard` fails a new
     * reference to this field. It stays declared for exactly as long as the old
     * runtime and its un-migrated tests still parse documents that contain it.
     */
    world: Type.Optional(WorldDefinition),
    inputMap: InputMapDefinition,
    /** Toggleable equipment. Each slot publishes one boolean parameter. */
    equipment: Type.Array(EquipmentSlotDefinition),
    movement: MovementProfile,
    rootMotion: RootMotionProfile,
    terrain: TerrainInteractionProfile,
    camera: CameraProfile,
    haptics: HapticProfile,
    preferences: PreferenceProfile,
    /** Terrain preset selected when the chamber opens. */
    defaultTerrainPresetId: Id,
    candidates: Type.Array(CandidateAsset),
    revisions: Type.Array(RevisionDefinition),
    /**
     * Project-wide invariants. Repo Guard fails when any of these paths is
     * removed or has its protection weakened.
     */
    invariants: Type.Array(
      Type.Object(
        {
          path: Type.String(),
          reason: Type.String(),
        },
        { additionalProperties: false },
      ),
    ),
    protection: Type.Optional(ProtectionMetadata),
  },
  { $id: 'ProjectDefinition', additionalProperties: false },
);
export type ProjectDefinition = Static<typeof ProjectDefinition>;

/**
 * The project as one character sees it, after asset resolution.
 *
 * This is a *derived* document, never a file. It exists because the runtime,
 * the panels, the diff engine and the Unity exporter all reasonably want a
 * graph and a clip list, and asking each of them to walk an asset registry
 * instead would have spread reference resolution across the whole codebase.
 * Resolution happens once, here, and everything downstream sees the same
 * ordinary project it always did.
 *
 * It is deliberately not a TypeBox schema: validating it as canonical data is
 * exactly the mistake it invites, so there is nothing to validate it with.
 * `validateResolvedProjectReferences` checks its structure instead.
 *
 * See `ResolvedProject` below; `ResolvedCharacter` comes first because it is
 * part of that shape.
 */

/**
 * A character with its skeleton filled in from its rig profile.
 *
 * The skeleton deliberately does not live on `CharacterDefinition` any more.
 * Two characters sharing a rig used to mean two copies of the same sixteen
 * bones, free to drift apart, with nothing able to say which was right. The
 * rig asset is now the only place a skeleton is written down.
 */
export interface ResolvedCharacter extends CharacterDefinition {
  skeleton: SkeletonDefinition;
  /** Rigs sharing this key can play each other's clips without retargeting. */
  rigCompatibilityKey: string;
}

export interface ResolvedProject extends ProjectDefinition {
  /** The character this document was resolved for. */
  character: ResolvedCharacter;
  graph: AnimationGraphDefinition;
  clips: AnimationClipDefinition[];
  /**
   * Motion slot id -> clip id. This is the only place the two halves meet: the
   * behaviour supplied the slots, the motion set supplied the clips.
   */
  motionBindings: Record<string, string>;
  /**
   * Context key -> slot -> clip id, for slots a context overrides.
   *
   * Contexts are resolved at tick time rather than baked in, so switching
   * weapon is not a document change. Baking the active weapon into this
   * document would mean every weapon switch produced a different document and
   * discarded the edit session's history along with it.
   */
  contextualMotionBindings: Record<string, Record<string, string>>;
  /** Provenance of every resolved value, for the inspector's origin column. */
  resolution: ResolvedValue[];
  /** Context keys the motion set binds, for the chamber's weapon selector. */
  motionContextKeys: string[];
  /**
   * Resolved clip id -> the published `AnimationClipAsset` it came from
   * (PLAN Part II §13). This is what lets a staged clip edit be saved back
   * as a new version of the asset that actually authored it, rather than
   * guessed at from the clip id alone — and what catches two different
   * assets supplying the same resolved clip id before that ambiguity reaches
   * a save. Never written to a canonical file; resolve-time only.
   */
  clipAssetSources: Record<string, AssetReference>;
}

/** The active character, or the first one when the id no longer exists. */
export function activeCharacter(project: ProjectDefinition): CharacterDefinition {
  return (
    project.characters.find((entry) => entry.id === project.activeCharacterId) ??
    project.characters[0]!
  );
}

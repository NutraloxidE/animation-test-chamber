/**
 * Character → Prefab migration (§11).
 *
 * Turns the five canonical Characters and the Scene entities that place them
 * into GameObject Prefab assets and GameObject instances, deterministically and
 * idempotently. Run it twice and the second run writes nothing; `--check`
 * asserts exactly that without writing, which is what a CI stage wants.
 *
 * Two rules shape everything below.
 *
 * **Effective behaviour is preserved exactly.** Every model binding, animation
 * assignment, rig, tuning, instance override, capsule dimension and grip is
 * carried across by *value*, read from the project document. Nothing here
 * derives a model or a clip from an id — `tests/unit/prefabs/equivalence.test.ts`
 * compares the migrated Prefabs against the pre-migration Characters field by
 * field, and it would pass just as happily against a lookup table, which is
 * exactly why the migration must not contain one.
 *
 * **The five concrete Prefabs are variants, not copies.** They inherit one
 * abstract `humanoid-character-base` and store only what they change. That is
 * what makes "fix the shared motor on all five" a single publish rather than
 * five, and it is the property a snapshot-based migration would silently lose.
 *
 * The base is abstract because a humanoid with no model is a shape to inherit,
 * not a thing to stand somewhere — it deliberately carries no `ModelRenderer`,
 * so each concrete variant *adds* one rather than overriding a placeholder that
 * would otherwise be a second, wrong answer to "which model is this?".
 */
import type {
  AnimatorComponent,
  CameraSceneEntity,
  CapsuleColliderComponent,
  CharacterDefinition,
  CharacterSceneEntity,
  EquipmentSocketDefinition,
  EquipmentSocketsComponent,
  GameObjectInstanceDefinition,
  GameObjectPrefabAsset,
  GameObjectPrefabReference,
  LightSceneEntity,
  ModelRendererComponent,
  PrefabNodeDefinition,
  PrefabPatch,
  ProjectDefinition,
  RenderableModelBinding,
  SceneDefinition,
  SceneEntityDefinition,
} from '@atc/schema';
import { IDENTITY_TRANSFORM, prefabAssetFilePath,
  LEGACY_CHARACTER_PREFAB_IDS,
} from '@atc/schema';
import { createBasePrefab, createPrefabVariant } from '@atc/prefab-runtime';
import { computeContentHash } from '@atc/animation-asset-runtime';
import { loadCanonicalProject, PROJECT_PATH } from './animation-assets.ts';
import { readRepoFile, writeRepoFile } from './lib.ts';

/**
 * A fixed authoring timestamp.
 *
 * Wall-clock time in a generated asset would change its content hash on every
 * run, which would change every reference to it, which would make "the
 * migration is idempotent" false in the most expensive possible way.
 */
const MIGRATION_TIMESTAMP = '2026-08-06T00:00:00.000Z';
const MIGRATION_AUTHOR = 'prefabs:migrate';

/**
 * Old Character id → new Prefab id (§11.3).
 *
 * Re-exported, not redeclared: the table lives in the schema package so the
 * migration and the legacy route redirect read the same one.
 */
export { LEGACY_CHARACTER_PREFAB_IDS };

export const HUMANOID_BASE_PREFAB_ID = 'humanoid-character-base';
export const DEFAULT_SCENE_CAMERA_PREFAB_ID = 'default-scene-camera';

/** Component ids are stable within a node and are what every override addresses. */
const COMPONENT_IDS = {
  model: 'model',
  animator: 'animator',
  motor: 'character-motor',
  capsule: 'capsule',
  sockets: 'equipment-sockets',
  camera: 'camera',
  light: 'light',
  tags: 'tags',
} as const;

const ROOT_NODE_ID = 'root';

export interface MigratedPrefab {
  path: string;
  content: string;
  document: GameObjectPrefabAsset;
}

export interface PrefabMigrationResult {
  prefabs: MigratedPrefab[];
  /** The project document with every Scene given its `gameObjects` view. */
  project: ProjectDefinition;
  projectContent: string;
  /** Old Character id → the exact Prefab reference it became. */
  identityMap: Record<string, GameObjectPrefabReference>;
}

function node(
  overrides: Partial<PrefabNodeDefinition> & Pick<PrefabNodeDefinition, 'displayName'>,
): PrefabNodeDefinition {
  return {
    nodeId: ROOT_NODE_ID,
    enabled: true,
    transform: IDENTITY_TRANSFORM,
    components: [],
    children: [],
    ...overrides,
  };
}

function animatorComponent(character: CharacterDefinition): AnimatorComponent {
  return {
    schemaVersion: 1,
    componentId: COMPONENT_IDS.animator,
    componentType: 'animator',
    enabled: true,
    // By value, from the character document. The four references and the
    // instance overrides move here unchanged (§5.4).
    assignment: character.animation,
  };
}

function capsuleComponent(character: CharacterDefinition): CapsuleColliderComponent {
  return {
    schemaVersion: 1,
    componentId: COMPONENT_IDS.capsule,
    componentType: 'capsule-collider',
    enabled: true,
    radius: character.capsuleRadius,
    height: character.capsuleHeight,
    // The old capsule had no offset: it was implicitly centred on the entity
    // origin, and stating that is not a change of behaviour.
    center: { x: 0, y: 0, z: 0 },
  };
}

function modelComponent(model: RenderableModelBinding): ModelRendererComponent {
  return {
    schemaVersion: 1,
    componentId: COMPONENT_IDS.model,
    componentType: 'model-renderer',
    enabled: true,
    model,
    castShadow: true,
    receiveShadow: true,
  };
}

/**
 * The model binding, minus the attachment fields that are no longer part of it.
 *
 * `rightHandBone` and `weaponGrips` are dropped here *because* they are picked
 * up by `socketsComponent` below; dropping them without moving them would be
 * the one silent behaviour loss this migration could plausibly commit.
 */
function renderableModel(character: CharacterDefinition): RenderableModelBinding {
  const model = character.model;
  if (model.kind === 'procedural-humanoid') {
    return { kind: 'procedural-humanoid', presetId: model.presetId };
  }
  return {
    kind: 'repository-model',
    assetPath: model.assetPath,
    scale: model.scale,
    rotationYRad: model.rotationYRad,
  };
}

/**
 * The grips a character authored, as sockets.
 *
 * One socket per hand bone, carrying one grip per weapon mode as
 * `acceptedItemTags`. The old shape keyed a position/rotation pair by weapon
 * mode on a single bone; the new one is a list of sockets, so a mode that
 * authored its own grip becomes its own socket named after it. That keeps every
 * authored number reachable while removing the assumption that a hand holds a
 * weapon.
 */
function socketsComponent(
  character: CharacterDefinition,
): EquipmentSocketsComponent | undefined {
  const model = character.model;
  if (model.kind !== 'repository-model' || model.rightHandBone === undefined) return undefined;

  const grips = model.weaponGrips ?? {};
  const sockets: EquipmentSocketDefinition[] = Object.keys(grips)
    .sort()
    .map((mode) => ({
      socketId: `right-hand-${mode}`,
      boneName: model.rightHandBone!,
      localPosition: grips[mode]!.position,
      localRotation: grips[mode]!.rotation,
      acceptedItemTags: [mode],
    }));

  if (sockets.length === 0) {
    sockets.push({
      socketId: 'right-hand',
      boneName: model.rightHandBone,
      localPosition: [0, 0, 0],
      localRotation: [0, 0, 0],
      acceptedItemTags: [],
    });
  }

  return {
    schemaVersion: 1,
    componentId: COMPONENT_IDS.sockets,
    componentType: 'equipment-sockets',
    enabled: true,
    sockets,
  };
}

function serialize(document: unknown): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

function referenceTo(document: GameObjectPrefabAsset): GameObjectPrefabReference {
  return {
    assetType: 'game-object-prefab',
    assetId: document.metadata.id,
    version: document.metadata.version,
    contentHash: computeContentHash(document),
  };
}

/**
 * The whole migration, as a value.
 *
 * Returns rather than writes so the determinism stage can run it twice and
 * compare, and so the tests can assert on its output without touching disk.
 */
export function runPrefabMigration(project: ProjectDefinition): PrefabMigrationResult {
  const prefabs: MigratedPrefab[] = [];
  const emit = (document: GameObjectPrefabAsset): GameObjectPrefabReference => {
    prefabs.push({
      path: prefabAssetFilePath(document.metadata.id, document.metadata.version),
      content: serialize(document),
      document,
    });
    return referenceTo(document);
  };

  const characters = project.characters;
  const baseCharacter = characters.find((entry) => entry.id === 'demo-humanoid') ?? characters[0]!;

  /* ---------------------------------------------------------------------- */
  /* The abstract humanoid base                                             */
  /* ---------------------------------------------------------------------- */

  const baseReference = emit(
    createBasePrefab(
      {
        id: HUMANOID_BASE_PREFAB_ID,
        displayName: 'Humanoid Character Base',
        description:
          'The shared humanoid composition: an Animator on the project behaviour, a ' +
          'CharacterMotor, and a capsule. Abstract — it carries no model, so it is a ' +
          'shape to inherit rather than a thing to place.',
        tags: ['character', 'humanoid', 'base'],
        createdAt: MIGRATION_TIMESTAMP,
        createdBy: MIGRATION_AUTHOR,
        abstract: true,
      },
      node({
        displayName: 'Humanoid',
        components: [
          animatorComponent(baseCharacter),
          {
            schemaVersion: 1,
            componentId: COMPONENT_IDS.motor,
            componentType: 'character-motor',
            enabled: true,
            // The presence of this component — not a `kind` field — is what
            // makes every variant below controllable.
            intentChannel: 'primary',
            movementScale: 1,
            turnScale: 1,
          },
          capsuleComponent(baseCharacter),
          {
            schemaVersion: 1,
            componentId: COMPONENT_IDS.tags,
            componentType: 'tags',
            enabled: true,
            tags: ['character', 'humanoid'],
          },
        ],
      }),
    ),
  );

  /* ---------------------------------------------------------------------- */
  /* The five concrete characters, as variants                              */
  /* ---------------------------------------------------------------------- */

  const identityMap: Record<string, GameObjectPrefabReference> = {};

  for (const character of characters) {
    const prefabId = LEGACY_CHARACTER_PREFAB_IDS[character.id] ?? character.id;
    const patches: PrefabPatch[] = [
      {
        kind: 'add-component',
        nodeId: ROOT_NODE_ID,
        component: modelComponent(renderableModel(character)),
      },
    ];

    // Only what actually differs from the base is stored. A patch that set a
    // value to what it already is would make the variant look like it had
    // overridden something, and the Inspector's "inherited" badge would be a lie.
    const baseAssignment = baseCharacter.animation;
    const assignment = character.animation;
    const animatorPatches = (
      ['behavior', 'motionSet', 'rig', 'tuning', 'instanceOverrides'] as const
    )
      .filter((field) => JSON.stringify(assignment[field]) !== JSON.stringify(baseAssignment[field]))
      .map((field) => ({
        path: `/assignment/${field}`,
        op: 'set' as const,
        value: assignment[field],
      }));
    // One override per component, not one per field: `PrefabComponentOverride`
    // is addressed by component id, and two entries naming the same component
    // would make "what does this variant override?" a question with two answers.
    if (animatorPatches.length > 0) {
      patches.push({
        kind: 'patch-component',
        nodeId: ROOT_NODE_ID,
        componentId: COMPONENT_IDS.animator,
        patches: animatorPatches,
      });
    }

    const capsulePatches = (
      [
        ['radius', character.capsuleRadius, baseCharacter.capsuleRadius],
        ['height', character.capsuleHeight, baseCharacter.capsuleHeight],
      ] as const
    )
      .filter(([, mine, theirs]) => mine !== theirs)
      .map(([field, mine]) => ({ path: `/${field}`, op: 'set' as const, value: mine }));
    if (capsulePatches.length > 0) {
      patches.push({
        kind: 'patch-component',
        nodeId: ROOT_NODE_ID,
        componentId: COMPONENT_IDS.capsule,
        patches: capsulePatches,
      });
    }

    const sockets = socketsComponent(character);
    if (sockets) {
      patches.push({ kind: 'add-component', nodeId: ROOT_NODE_ID, component: sockets });
    }

    identityMap[character.id] = emit(
      createPrefabVariant(
        {
          id: prefabId,
          displayName: character.displayName,
          description: `Migrated from Character "${character.id}".`,
          tags: ['character', 'humanoid'],
          createdAt: MIGRATION_TIMESTAMP,
          createdBy: MIGRATION_AUTHOR,
        },
        baseReference,
        patches,
      ),
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Scenes                                                                 */
  /* ---------------------------------------------------------------------- */

  const cameraPrefabs = new Map<string, GameObjectPrefabReference>();
  const lightPrefabs = new Map<string, GameObjectPrefabReference>();

  const scenes = project.scenes.map((scene) =>
    migrateScene(scene, {
      identityMap,
      emit,
      cameraPrefabs,
      lightPrefabs,
    }),
  );

  const migratedProject: ProjectDefinition = { ...project, scenes };

  return {
    prefabs,
    project: migratedProject,
    projectContent: serialize(migratedProject),
    identityMap,
  };
}

interface SceneMigrationContext {
  identityMap: Record<string, GameObjectPrefabReference>;
  emit: (document: GameObjectPrefabAsset) => GameObjectPrefabReference;
  cameraPrefabs: Map<string, GameObjectPrefabReference>;
  lightPrefabs: Map<string, GameObjectPrefabReference>;
}

/**
 * One Scene's entities, as GameObject instances.
 *
 * Every entity kind lands on the same instance type. What used to be the
 * difference between them — a `characterId`, a `lightType`, a `targetEntityId` —
 * is now either the Prefab that is referenced or an instance relation, and the
 * `kind` discriminator has nothing left to discriminate.
 *
 * Cameras and lights become instances of *generated reusable* Prefabs keyed by
 * their component payload, so two identical lights share one Prefab rather than
 * minting two. The key is derived from the payload rather than from a UUID
 * (§11.4), which is what keeps a second migration run producing the same ids.
 */
function migrateScene(scene: SceneDefinition, context: SceneMigrationContext): SceneDefinition {
  const gameObjects: GameObjectInstanceDefinition[] = [];

  for (const entity of scene.entities) {
    const instance = migrateEntity(entity, context);
    if (instance) gameObjects.push(instance);
  }

  const migrated: SceneDefinition = {
    ...scene,
    gameObjects,
    ...(scene.activeCameraEntityId !== undefined
      ? { activeCameraGameObjectId: scene.activeCameraEntityId }
      : {}),
  };
  return migrated;
}

function migrateEntity(
  entity: SceneEntityDefinition,
  context: SceneMigrationContext,
): GameObjectInstanceDefinition | undefined {
  const common = {
    schemaVersion: entity.schemaVersion,
    id: entity.id,
    displayName: entity.displayName,
    enabled: entity.enabled,
    transform: entity.transform,
    componentOverrides: [],
    ...(entity.protection ? { protection: entity.protection } : {}),
  };

  switch (entity.kind) {
    case 'character': {
      const character = entity as CharacterSceneEntity;
      const prefab = context.identityMap[character.characterId];
      if (!prefab) return undefined;
      return {
        ...common,
        prefab,
        bindings: { characterIntent: character.controller },
        relations: {},
      };
    }
    case 'camera': {
      const camera = entity as CameraSceneEntity;
      const prefab = cameraPrefabFor(camera, context);
      return {
        ...common,
        prefab,
        bindings: {},
        relations:
          camera.targetEntityId !== undefined
            ? { cameraTargetGameObjectId: camera.targetEntityId }
            : {},
      };
    }
    case 'light': {
      const light = entity as LightSceneEntity;
      return {
        ...common,
        prefab: lightPrefabFor(light, context),
        bindings: {},
        relations: {},
      };
    }
    case 'prop':
      // Props migrate to a Prefab derived from the asset they render. The demo
      // project authors none, so rather than guess at a shape nothing exercises,
      // this stays unimplemented and says so: a migration that silently dropped
      // a prop would be worse than one that refuses to invent it.
      throw new Error(
        `prop entity "${entity.id}" has no Prefab migration yet; see reports/gameobject-prefab-migration-audit.md`,
      );
  }
}

/**
 * A reusable camera Prefab for one authored camera.
 *
 * The follow target is deliberately not part of the key: it is an instance
 * relation, so two cameras that differ only in what they watch share one Prefab.
 */
function cameraPrefabFor(
  camera: CameraSceneEntity,
  context: SceneMigrationContext,
): GameObjectPrefabReference {
  const key = JSON.stringify([camera.projection, camera.fieldOfViewDeg, camera.orthographicSize]);
  const existing = context.cameraPrefabs.get(key);
  if (existing) return existing;

  const id =
    context.cameraPrefabs.size === 0
      ? DEFAULT_SCENE_CAMERA_PREFAB_ID
      : `${DEFAULT_SCENE_CAMERA_PREFAB_ID}-${context.cameraPrefabs.size + 1}`;

  const reference = context.emit(
    createBasePrefab(
      {
        id,
        displayName: 'Scene Camera',
        description: 'Generated from a migrated Scene camera entity.',
        tags: ['camera'],
        createdAt: MIGRATION_TIMESTAMP,
        createdBy: MIGRATION_AUTHOR,
      },
      node({
        displayName: 'Camera',
        components: [
          {
            schemaVersion: 1,
            componentId: COMPONENT_IDS.camera,
            componentType: 'camera',
            enabled: true,
            projection: camera.projection,
            ...(camera.fieldOfViewDeg !== undefined
              ? { fieldOfViewDeg: camera.fieldOfViewDeg }
              : {}),
            ...(camera.orthographicSize !== undefined
              ? { orthographicSize: camera.orthographicSize }
              : {}),
          },
        ],
      }),
    ),
  );
  context.cameraPrefabs.set(key, reference);
  return reference;
}

function lightPrefabFor(
  light: LightSceneEntity,
  context: SceneMigrationContext,
): GameObjectPrefabReference {
  const key = JSON.stringify([
    light.lightType,
    light.intensity,
    light.color,
    light.range,
    light.spotAngleRad,
  ]);
  const existing = context.lightPrefabs.get(key);
  if (existing) return existing;

  // Derived from the payload, never from a counter alone, so the same light in
  // the same project migrates to the same Prefab id on every run.
  const id = `scene-light-${light.lightType}-${light.color.slice(1).toLowerCase()}`;
  const reference = context.emit(
    createBasePrefab(
      {
        id,
        displayName: `${light.lightType[0]!.toUpperCase()}${light.lightType.slice(1)} Light`,
        description: 'Generated from a migrated Scene light entity.',
        tags: ['light'],
        createdAt: MIGRATION_TIMESTAMP,
        createdBy: MIGRATION_AUTHOR,
      },
      node({
        displayName: 'Light',
        components: [
          {
            schemaVersion: 1,
            componentId: COMPONENT_IDS.light,
            componentType: 'light',
            enabled: true,
            lightType: light.lightType,
            intensity: light.intensity,
            color: light.color,
            ...(light.range !== undefined ? { range: light.range } : {}),
            ...(light.spotAngleRad !== undefined ? { spotAngleRad: light.spotAngleRad } : {}),
          },
        ],
      }),
    ),
  );
  context.lightPrefabs.set(key, reference);
  return reference;
}

/** Runs the migration against the repository's canonical project. */
export function runMigration(): PrefabMigrationResult {
  return runPrefabMigration(loadCanonicalProject());
}

function main(): void {
  const check = process.argv.includes('--check');
  const result = runMigration();
  const pending: { path: string; content: string }[] = [];

  for (const prefab of result.prefabs) {
    if (readRepoFile(prefab.path) !== prefab.content) {
      pending.push({ path: prefab.path, content: prefab.content });
    }
  }
  if (readRepoFile(PROJECT_PATH) !== result.projectContent) {
    pending.push({ path: PROJECT_PATH, content: result.projectContent });
  }

  if (pending.length === 0) {
    console.log(
      `[OK] ${result.prefabs.length} Prefab(s) and ${Object.keys(result.identityMap).length} ` +
        'migrated Character identities already current',
    );
    return;
  }

  if (check) {
    console.error('[FAIL] the repository is not the migrated form; run `pnpm prefabs:migrate`');
    for (const entry of pending) console.error(`  ${entry.path}`);
    process.exit(1);
  }

  for (const entry of pending) {
    writeRepoFile(entry.path, entry.content);
    console.log(`[WROTE] ${entry.path}`);
  }
}

if (process.argv[1]?.includes('migrate-character-prefabs')) main();

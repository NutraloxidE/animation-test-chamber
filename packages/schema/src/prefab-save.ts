/**
 * Adoption requests (work package §14).
 *
 * The defect these close is specific. The UI could describe a shared Behavior
 * edit as affecting every holder while the server published a new version and
 * re-pointed only the active Character — so the sentence a human read and the
 * change a machine made were two different claims, and nothing compared them.
 *
 * Three rules make that unrepresentable rather than merely discouraged:
 *
 *  1. **Publishing is not adoption.** Publishing `Behavior 1.0.1` creates a
 *     version. It moves no reference by itself.
 *
 *  2. **A request names its targets.** There is no `updateScope: 'shared'` and
 *     no `updateScope: 'all'` in this file, deliberately. A scope is a
 *     description the server re-evaluates against whatever it happens to see;
 *     an enumerated id list is the decision the human actually approved. The UI
 *     may offer "All current holder Prefabs" as a *button*; what goes on the
 *     wire is the ids that button expanded to.
 *
 *  3. **The snapshot travels with it.** `expected` carries what the client
 *     believed when it drew the confirmation dialog. A holder list that has
 *     moved since is a 409 and no writes — not a silent recomputation, because
 *     recomputing "all holders" server-side after a human approved a different
 *     set is exactly the ambiguity rule 2 removes.
 */
import { Type, type Static } from '@sinclair/typebox';
import { Id } from './common.ts';
import { AnimationAsset, AssetReference } from './animation-assets.ts';
import { GameObjectPrefabReference } from './prefab.ts';

/** One Scene GameObject standing on one Prefab version, named exactly. */
export const SceneInstanceReference = Type.Object(
  {
    sceneId: Id,
    gameObjectId: Id,
    prefab: GameObjectPrefabReference,
  },
  { $id: 'SceneInstanceReference', additionalProperties: false },
);
export type SceneInstanceReference = Static<typeof SceneInstanceReference>;

export const SceneInstanceTarget = Type.Object(
  { sceneId: Id, gameObjectId: Id },
  { $id: 'SceneInstanceTarget', additionalProperties: false },
);
export type SceneInstanceTarget = Static<typeof SceneInstanceTarget>;

/**
 * Publish an animation asset version and re-point named Prefabs at it.
 *
 * `targetPrefabIds` may be empty. That is a real, useful request — "publish the
 * version, adopt it nowhere yet" — and it is the case that proves publishing
 * and adoption are separate.
 */
export const PublishAnimationAndUpdatePrefabsRequest = Type.Object(
  {
    source: AssetReference,
    /** Proposed contents. The server assigns the next immutable version and seals it. */
    draft: Type.Ref(AnimationAsset),
    expected: Type.Object(
      {
        sourceContentHash: Type.String({ minLength: 1 }),
        projectRevisionId: Type.String({ minLength: 1 }),
        /** Every Prefab version the client believed holds `source`, when it asked. */
        holderPrefabReferences: Type.Array(GameObjectPrefabReference),
      },
      { additionalProperties: false },
    ),
    /** Exactly which Prefab lineages adopt the new version. Never a scope. */
    targetPrefabIds: Type.Array(Id),
  },
  { $id: 'PublishAnimationAndUpdatePrefabsRequest', additionalProperties: false },
);
export type PublishAnimationAndUpdatePrefabsRequest = Static<
  typeof PublishAnimationAndUpdatePrefabsRequest
>;

/** Publish a Prefab version and re-point named Scene instances at it. */
export const PublishPrefabAndUpdateInstancesRequest = Type.Object(
  {
    source: GameObjectPrefabReference,
    expected: Type.Object(
      {
        sourceContentHash: Type.String({ minLength: 1 }),
        projectRevisionId: Type.String({ minLength: 1 }),
        sceneInstanceReferences: Type.Array(SceneInstanceReference),
      },
      { additionalProperties: false },
    ),
    targets: Type.Array(SceneInstanceTarget),
  },
  { $id: 'PublishPrefabAndUpdateInstancesRequest', additionalProperties: false },
);
export type PublishPrefabAndUpdateInstancesRequest = Static<
  typeof PublishPrefabAndUpdateInstancesRequest
>;

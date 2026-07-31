/**
 * The save request contract (PLAN Part II §14).
 *
 * Replaces the old `graphPatches` / `clipPatches` pair, which the server
 * received and only ever read one half of — a clip edit staged alongside a
 * graph edit had nowhere to go and was silently dropped. Graph and clip
 * changes now carry their own, independently chosen destination, and every
 * clip change names the exact published asset it came from, so the server
 * never has to guess which asset a patch belongs to.
 */
import { Type, type Static } from '@sinclair/typebox';
import { Id } from './common.ts';
import { AssetReference, CanonicalPatch } from './animation-assets.ts';

export const GraphChangeDestination = Type.Union(
  [
    Type.Object({ kind: Type.Literal('character-override') }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal('tuning-profile') }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal('existing-behavior-variant') }, { additionalProperties: false }),
    Type.Object(
      {
        kind: Type.Literal('new-behavior-variant'),
        newAssetId: Id,
        displayName: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    ),
    Type.Object({ kind: Type.Literal('shared-behavior') }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal('none') }, { additionalProperties: false }),
  ],
  { $id: 'GraphChangeDestination' },
);
export type GraphChangeDestination = Static<typeof GraphChangeDestination>;

export const ClipChangeDestination = Type.Union(
  [
    Type.Object({ kind: Type.Literal('character-override') }, { additionalProperties: false }),
    Type.Object(
      { kind: Type.Literal('new-clip-versions-and-motion-set') },
      { additionalProperties: false },
    ),
    Type.Object({ kind: Type.Literal('none') }, { additionalProperties: false }),
  ],
  { $id: 'ClipChangeDestination' },
);
export type ClipChangeDestination = Static<typeof ClipChangeDestination>;

/** One changed clip: the published asset it came from, and the patches against it. */
export const ClipChange = Type.Object(
  {
    sourceClip: AssetReference,
    clipId: Id,
    patches: Type.Array(CanonicalPatch),
  },
  { $id: 'ClipChange', additionalProperties: false },
);
export type ClipChange = Static<typeof ClipChange>;

export const SaveAnimationChangesRequest = Type.Object(
  {
    characterId: Id,
    graph: Type.Object(
      { patches: Type.Array(CanonicalPatch), destination: GraphChangeDestination },
      { additionalProperties: false },
    ),
    clips: Type.Object(
      { changes: Type.Array(ClipChange), destination: ClipChangeDestination },
      { additionalProperties: false },
    ),
    expected: Type.Object(
      {
        projectRevisionId: Type.String({ minLength: 1 }),
        assetReferences: Type.Array(AssetReference),
      },
      { additionalProperties: false },
    ),
    createdBy: Type.Optional(Type.String()),
    createdAt: Type.Optional(Type.String()),
  },
  { $id: 'SaveAnimationChangesRequest', additionalProperties: false },
);
export type SaveAnimationChangesRequest = Static<typeof SaveAnimationChangesRequest>;

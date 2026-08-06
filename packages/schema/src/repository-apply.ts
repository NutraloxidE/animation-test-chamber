/**
 * The `POST /api/repository/apply` wire contract, as a runtime schema.
 *
 * This file exists because the endpoint receives JSON. Every field below was
 * previously described only by a TypeScript interface and read through a
 * `raw as Partial<RepositoryApplyRequestBody>` cast, which is not a check —
 * it is a claim about a client, made by the server, on the client's behalf.
 * `curl` does not typecheck, and neither does a mis-built client.
 *
 * The TypeScript types are `Static<>` derivations of these schemas rather than
 * a parallel set of hand-written interfaces. Two hand-maintained shapes for one
 * wire format drift, and the drift is invisible until the day the server
 * accepts something the client can no longer produce.
 *
 * `additionalProperties: false` on every object boundary is the load-bearing
 * part. Without it an unknown field is silently ignored, which is the worst
 * available outcome: a caller that misspelled `approvedPaths` would be told its
 * approval was accepted, and the server would apply the change with no approval
 * at all.
 */
import { Type, type Static } from '@sinclair/typebox';
import { Id } from './common.ts';
import { GameObjectSceneOperation } from './scene.ts';

/**
 * A canonical document path, as it appears in protection decisions and Apply
 * reports: `/entities/honoka-01/transform`.
 *
 * Anchored at `/` so a relative path cannot be smuggled in, and bounded so a
 * pathological string cannot be used to bloat a report.
 */
export const CanonicalPathString = Type.String({
  pattern: '^/',
  minLength: 1,
  maxLength: 512,
});

/**
 * What the request is editing.
 *
 * `character` is declared here even though this endpoint refuses it, and that
 * is deliberate: refusing it as *unsupported* after the request is proven
 * structurally valid says something true and useful, whereas refusing it as a
 * malformed target would send the caller looking for a typo they did not make.
 */
export const RepositoryDocumentTarget = Type.Union(
  [
    Type.Object(
      { kind: Type.Literal('character'), id: Id },
      { additionalProperties: false },
    ),
    Type.Object({ kind: Type.Literal('scene'), id: Id }, { additionalProperties: false }),
  ],
  { $id: 'RepositoryDocumentTarget' },
);
export type RepositoryDocumentTarget = Static<typeof RepositoryDocumentTarget>;

/**
 * The baseline the caller believes it is editing.
 *
 * Required, never defaulted. A request that omits its expected revision is not
 * a request to apply against "whatever is current" — it is a request whose
 * author did not consider concurrency, and honouring it is how the second
 * writer silently erases the first.
 */
export const RepositoryApplyExpected = Type.Object(
  { projectRevisionId: Type.String({ minLength: 1, maxLength: 128 }) },
  { $id: 'RepositoryApplyExpected', additionalProperties: false },
);
export type RepositoryApplyExpected = Static<typeof RepositoryApplyExpected>;

/**
 * A human's exact sign-off on the protected paths one Apply would change.
 *
 * `approvedPaths` is an exact list, not a prefix and not a wildcard, and
 * `uniqueItems` makes a repeated path a refusal rather than something the
 * server has to decide how to count. The server recomputes the protected paths
 * itself and compares; this field is the human's answer, never the question.
 *
 * `reason` is required and must contain something other than whitespace. An
 * approval with no stated reason is an audit record that explains nothing, and
 * the report is the only place anyone will later look to find out why a
 * protected value moved.
 */
export const ProtectionApproval = Type.Object(
  {
    approvedPaths: Type.Array(CanonicalPathString, { uniqueItems: true, maxItems: 256 }),
    reason: Type.String({ minLength: 1, maxLength: 2000, pattern: '\\S' }),
  },
  { $id: 'ProtectionApproval', additionalProperties: false },
);
export type ProtectionApproval = Static<typeof ProtectionApproval>;

/** Who is asking. A human and an agent are not interchangeable here. */
export const RepositoryApplyActor = Type.Union(
  [Type.Literal('human'), Type.Literal('ai')],
  { $id: 'RepositoryApplyActor' },
);
export type RepositoryApplyActor = Static<typeof RepositoryApplyActor>;

/**
 * The complete request.
 *
 * Note what is *absent*, because their absence is the contract:
 *
 *   unlockedPaths   a local UI unlock is a gesture in front of one control in
 *                   one browser. It is not a server authorization artifact, and
 *                   a request that declares its own unlocks is the caller that
 *                   wants past the lock filling in the field that grants it.
 *                   A confirmed protected Apply travels as an exact `approval`.
 *
 *   approved        a bare boolean names nothing. It cannot be checked against
 *                   what the operations actually touched, so it approves
 *                   whatever the request turns out to do.
 *
 *   changedPaths    the server computes these by replaying the operations. A
 *                   client-supplied list is a claim about a computation the
 *                   server is about to perform itself.
 */
export const RepositoryApplyRequest = Type.Object(
  {
    target: RepositoryDocumentTarget,
    expected: RepositoryApplyExpected,
    /**
     * GameObject operations, and only those (DECISION 0025).
     *
     * This field named `SceneOperation` — the entity union — until the Scene
     * cutover. The change is not additive on purpose: accepting both unions
     * would have made the endpoint a *dual* write path, one branch writing
     * `gameObjects` and the other writing `entities`, and "which collection is
     * canonical" would have been decided per request by whichever client sent
     * it. An entity operation is now refused by name, with the GameObject
     * operation to send instead.
     */
    operations: Type.Array(GameObjectSceneOperation, { maxItems: 1000 }),
    actor: RepositoryApplyActor,
    intent: Type.String({ minLength: 1, maxLength: 2000, pattern: '\\S' }),
    approval: Type.Optional(ProtectionApproval),
  },
  { $id: 'RepositoryApplyRequest', additionalProperties: false },
);
export type RepositoryApplyRequest = Static<typeof RepositoryApplyRequest>;

/**
 * The outcome discriminator, carried in the response body.
 *
 * A stable status the client can switch on, rather than prose it has to
 * pattern-match. `unavailable` is the one member the server never sends: it is
 * the browser's word for "this deployment has no API", and it lives in the same
 * union so the client has exactly one thing to handle.
 */
export const RepositoryApplyStatus = Type.Union(
  [
    Type.Literal('applied'),
    Type.Literal('no-change'),
    Type.Literal('conflict'),
    Type.Literal('invalid'),
    Type.Literal('rolled-back'),
    Type.Literal('repository-read-only'),
    Type.Literal('unavailable'),
  ],
  { $id: 'RepositoryApplyStatus' },
);
export type RepositoryApplyStatus = Static<typeof RepositoryApplyStatus>;

/** The statuses the server itself can return. `unavailable` is browser-only. */
export type RepositoryApplyServerStatus = Exclude<RepositoryApplyStatus, 'unavailable'>;

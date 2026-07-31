# 01 — Schema and asset boundary review (Gate B, first half)

Reviewer: main agent (Opus 5) in the architecture-and-audit role.
Scope: `packages/schema/src/animation-assets.ts`, the `StateDefinition` changes
in `animation.ts`, and `ProjectDefinition` v2 in `project.ts`.

## Findings

**The schema is not over-generalised.** Five concrete asset types, no plugin
registry, no generic "asset" table. `AnimationAssetType` is a closed union and
`assetFilePath` is a total function over it, so adding a sixth type is a
compile error in every place that has to care — which is the point.

**Motion slot ids needed their own pattern.** `Id` forbids dots deliberately: a
dot in a canonical path segment would be ambiguous everywhere else. Slots are
dotted (`locomotion.idle`) and never appear as a path segment, so `MotionSlotId`
got its own pattern rather than `Id` being loosened for everyone.

**`AnimationBehaviorAsset.graph` is optional, and that is load-bearing.** A
variant has no graph field at all. This is what makes "a variant is a full copy"
structurally impossible rather than merely discouraged — the resolver builds the
graph from parent plus patches, and there is nowhere to accidentally cache it.
`tests/unit/animation-assets/derivation-and-resolution.test.ts` asserts both the
absence and the size ratio against the parent.

**Policy fields are three booleans, not one enum.** `locksMovementUntilRecovery`,
`returnsAuthorityOnRecovery` and `providesLocomotionAuthority` replaced three
different name checks that happened to be about movement. They are genuinely
independent questions — `dodge` answers yes to the second and no to the first —
so collapsing them into a mode enum would have needed a value per combination.

**Repo Guard interaction was checked before the edit landed.** The guard fails
when a schema file gains more than two `Type.Optional(` wrappers at once.
`animation.ts` nets +1: `weaponClips` and `clipId` left, `contextualMotionSlots`
and `recoveryPolicy` arrived, and `completionPolicy.holdTicks` was made required
(0 = the previous behaviour) specifically to stay inside that budget honestly
rather than by loosening the guard.

**`ResolvedProject` has no TypeBox schema, deliberately.** Validating a derived
document as canonical data is the mistake the type exists to prevent, so there
is nothing to validate it with. `validateResolvedProject` checks it in three
parts against the schemas that actually own each piece, and
`validateResolvedProjectReferences` covers the structural rules.

## One risk accepted

`CharacterDefinition` no longer carries `skeleton`; the rig asset owns it and
`ResolvedCharacter` receives it during resolution. This means a character cannot
be rendered without resolving its rig. That is correct — a character with an
unresolvable rig should not render — but it does mean the renderer's failure
mode moved from "wrong skeleton" to "no skeleton". `resolveCharacterAnimation`
supplies an empty skeleton and an issue rather than throwing, so the library can
still open and show what is broken.

## Gate B (first half): PASS

# 00 — Design review and Gate A (Design Freeze)

Reviewer: main agent (Opus 5), acting in the Opus 5 Low architecture-and-audit
role defined by the plan. See `agents/ORCHESTRATION.md` for why the review roles
were filled this way and what that means for the plan's Section 45 checklist.

## Existing architecture, as found

Commit `30f3972`. The demo character owned everything:

```
projects/demo-character/project.json   (3362 lines)
  character.skeleton                   16 bones
  clips[]                              35 clip definitions
  graph.states[]                       16 states, each naming a clipId
  graph.states[].weaponClips           per-weapon clip override map
  graph.transitions[]                  44 transitions
```

Nothing was reusable. Adding a second humanoid meant copying the graph, and the
copy would immediately start drifting.

## Name-based runtime behaviour, enumerated (PLAN 33)

Five branches inferred behaviour from how a state was spelled. Each was real,
wanted behaviour that a second character could only inherit by choosing the same
names:

| Site | Branch | Replaced by |
| --- | --- | --- |
| `animation-runtime/graph.ts:23` | `actionState.endsWith('-recovery') ? 0 : 0.78` | `StateDefinition.recoveryPolicy.authorityReturnAtNormalized` |
| `animation-runtime/graph.ts:33` | `actionState === 'dodge' \|\| endsWith('-recovery')` | `movementAuthorityPolicy.returnsAuthorityOnRecovery` |
| `animation-runtime/graph.ts:35` | `locomotionState === 'walk' \|\| === 'run'` | `movementAuthorityPolicy.providesLocomotionAuthority` |
| `animation-runtime/graph.ts:410` | `layer.stateId.startsWith('attack-')` | `completionPolicy.mode === 'hold-final-frame'` |
| `replay-runtime/simulation.ts:546` | `stateId.startsWith('attack-')` | `movementAuthorityPolicy.locksMovementUntilRecovery` |
| `replay-runtime/simulation.ts:608` | `stateId !== 'walk' && stateId !== 'run'` | `movementAuthorityPolicy.locomotionSpeedReference` |

`harness/repo-guard.ts` now fails on any of these patterns reappearing in
`animation-runtime`, `replay-runtime` or `terrain-runtime`.

## Frozen baseline

- `tests/fixtures/animation-assets/legacy-demo-project.v1.json` — the schema v1
  document, byte-identical to what `30f3972` shipped. It is the migration's
  input and the oracle's source.
- `tests/fixtures/animation-assets/legacy-replay-traces.json` — traces for all
  nine replay fixtures, captured by running the **pre-change code** in a git
  worktree at `30f3972`. Each entry carries a SHA-256 over the whole tick array
  plus readable sequences and metrics. The hash is what decides; the rest exists
  so a failure names itself.
- Baseline test result: **242 passed, 3 failed**. The three failures pre-exist
  this work — see `05-final-acceptance.md`.

## Gate A findings

**Asset type responsibilities do not overlap.** Behaviour owns sequencing and
declares slots. Motion set owns the slot→clip binding. Clip owns one piece of
motion. Rig owns the skeleton. Tuning owns numeric adjustment. The one place two
types could have overlapped — the skeleton, present on both the character and
the rig — was resolved by *removing* it from `CharacterDefinition`. Two
characters sharing a rig had two copies of the same sixteen bones, free to drift,
with nothing able to say which was right.

**Behaviour does not know clip ids.** `StateDefinition.clipId` is gone;
`motionSlot` replaces it. Enforced by the schema (`clipId` would be an unknown
property under `additionalProperties: false`) and asserted in
`tests/unit/animation-assets/migration.test.ts`.

**Version and hash semantics are fixed.** SemVer strings; `1.0.0` on creation;
patch bump for ordinary republication. Hash is SHA-256 over key-sorted JSON with
`contentHash` blanked. A reference carrying a stale hash is refused at load.

**Variant versus fork is unambiguous.** A variant stores only patches and has no
`graph` field at all — it is structurally incapable of being a full copy. A fork
carries its own graph and reads no parent, so the parent can be deleted.
`transitiveDependencies` returns nothing for a fork; `usedBy` still reports the
origin, labelled provenance-only.

**Migration is comparable.** The v1 fixture is retained, so the pre-migration
runtime can be re-run at any time; `harness/shadow-compare.ts` diffs it against
the asset-resolved runtime on every harness run.

## Deviations from the plan, and why

1. **`ResolvedProject` was introduced** (plan §14–21 do not name it). Without it,
   every consumer that reasonably wants a graph and a clip list — the runtime,
   six panels, the diff engine, the Unity exporter, the AI adapter — would have
   had to walk the registry itself, putting reference resolution in a dozen
   places. Resolution happens once; everything downstream sees the ordinary
   project document it always did. It is a derived type with no TypeBox schema,
   deliberately, so it cannot be mistaken for canonical data.

2. **`AnimationClipAsset.clip` reuses `AnimationClipDefinition` verbatim** rather
   than restating its fields as plan §17 lists them. The field list is identical;
   restating it would have created a second description of what a clip is, and
   the timeline, foot-IK solver and Unity exporter would all have needed an
   asset-aware branch.

3. **Contexts are resolved at tick time, not baked into the document.** Plan
   §32.3 asks for contextual motion; the plan's `resolvedContextKey` phrasing
   suggested a per-context document. That would make every weapon switch a
   document change and discard the chamber's edit history on a selector click.
   The resolved document carries every context's bindings and the motion
   resolver picks one per tick, which is free.

4. **`ProjectDefinition.characters[]` replaces `character`.** The plan requires a
   second character (§43) but does not say where it lives. A sibling field would
   have made "the character" and "the other characters" different kinds of
   thing.

## Gate A: PASS

Large-scale implementation was cleared to begin.

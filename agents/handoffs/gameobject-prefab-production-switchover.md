# Handoff — GameObject Prefab Production Switchover

**GAMEOBJECT PREFAB PRODUCTION SWITCHOVER: HOLD.**

§4 (runtime correctness) landed. §5–§15 — the actual cutover — did not. The dual
source of truth is still in place. Full detail in
`reports/gameobject-prefab-production-switchover-audit.md`; this is the shortest
thing a next run can start from.

- Repository: `NutraloxidE/animation-test-chamber`
- Branch: `claude/new-session-j71ojl`
- Start SHA: `2297629`
- End SHA: `c0e544d` plus the report commit
- `main` neither merged nor rebased. Nothing force-pushed.

## What changed

`packages/game-object-runtime/src/runtime.ts` and `components.ts` only, plus
`tests/unit/game-objects/hierarchy.test.ts` and DECISION 0023.

`RuntimeGameObject.transformState` is **gone**. It is now:

```ts
localTransform          // authored, relative to the parent; mutable
get worldTransform()    // derived: compose(parent.worldTransform, localTransform)
setLocalTransform(t)    // how a host moves a non-character object
```

and components receive `{ tick, deltaSeconds }` rather than a bare number.

## Why the cutover was reverted rather than committed

The schema cutover fans out to ~250 type errors across capability-runtime,
world-runtime, the harness, ~20 test files, the whole web app and the API. On
top of *fixing* those, §6/§8/§9/§10/§11 require building things that do not
exist: `GameObjectRenderer`, `/prefabs`, `/edit/prefab/:id`, the Prefab Editor,
the Prefab Overview, the Scene Editor GameObject hierarchy, seven API routes and
the confirmation UI. A half-applied schema cutover leaves the repository unable
to compile, which is worse than not starting.

The reverted work is not lost as *design* — §3 of the audit records every
decision it established, and those are the expensive part. Re-typing the code
against that section is much faster than re-deriving it.

## Where to start

The order in the work package (§18) is right. The one thing worth knowing before
step 4: **`AnimationSubjectDefinition` is the pivot.** Introducing it first —
before touching `SceneDefinition` or `ProjectDefinition` — lets
`ResolvedProject.character` keep its field name across 146 call sites while
`CharacterDefinition` leaves production. Trying to remove `Project.characters`
before that type exists is what makes the blast radius unmanageable.

Second thing worth knowing: **do the web layer before the schema**, or at least
build `GameObjectRenderer` and the Prefab routes against the *existing*
`gameObjects` field first. They can be written today — `gameObjects` is already
populated and `resolveSceneGameObjects` / `instantiateScene` already work. Once
the renderer and routes read GameObjects, removing `entities` stops being a
250-error change and becomes a deletion.

## Traps

- `RuntimeGameObject` no longer has `transformState`. Anything reaching for it
  wants `worldTransform`.
- A `CharacterMotor` node is world-authoritative and is *not* carried by its
  parent. Its children still compose from it. This is deliberate — the
  simulation integrates against world-space terrain — and it is the one place
  the hierarchy convention has an exception.
- `composeTransforms` rounds to 1e-9 and collapses `-0`. That is what keeps a
  migration byte-identical across platforms; do not remove it for speed without
  checking `prefabs:check`.
- The demo project still carries both Scene views. `gameObjects` is **derived**
  by `pnpm prefabs:migrate` — do not hand-edit it. That stops being true the
  moment §13.2 is done, and the migration must stop regenerating it then.

## Verification at the end SHA

```bash
pnpm typecheck                     # PASS
pnpm lint                          # PASS
pnpm harness:one-shot              # see the audit for both runs
```

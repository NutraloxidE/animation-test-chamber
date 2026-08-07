# 0024 — The production cutover is consumer-first, and stops where a dual path would start

Status: accepted (partially implemented — see "Where this stands")
Supersedes nothing. Extends 0020, 0021, 0022, 0023.

## Context

The Prefab/GameObject foundation was finished and verified: schema, Registry,
Resolver, usage graph, `GameObjectInstanceDefinition`,
`ResolvedGameObjectDefinition`, `RuntimeGameObject`, `RuntimeScene`, the five
Character→Prefab migrations, transform composition and the component tick
contract. None of it was in the production path. Production still composed
scenes out of `Project.characters`, `Scene.entities` and an entity-kind union,
and the GameObject view of each Scene was *generated* from the entity view.

A previous attempt started from the other end — deleting the legacy schema
first — and produced hundreds of cascading type errors before any replacement
consumer existed. It was reverted.

## Decision

**Consumers first, canonical deletion last.** The order is: build the renderer
against the already-populated `gameObjects` field; add the Prefab routes; switch
the Scene runtime and editor; add the Prefab APIs; introduce
`AnimationSubjectDefinition` and the migration-only legacy schemas; only then
remove `Project.characters` and `Scene.entities`; then migrate the demo project
and stop generating the mirror.

The reason is not sequencing taste. `Scene.entities` cannot be removed before a
replacement consumer exists, because until then removing it deletes the only
thing that renders. Deleting it first makes every downstream file fail for a
reason unrelated to what it is supposed to do, and the compiler stops being able
to tell you which of those failures is the real one.

**Rendering is derived from Components, never from a kind.** `entity.kind` made
"a character carrying a lamp" unrepresentable: an entity was a character *or* a
light. `render-projection.ts` asks one question per Component and a node may
answer yes to any subset, so all seven required compositions fall out with no
branch that has to know the combination exists. A Prefab id is never a
model-selection switch; the model comes from `ModelRendererComponent.model`,
which arrived from canonical Prefab data.

**A missing Component is an error, not a fallback.** A motor with no Animator is
reported rather than drawn — it would otherwise slide across the terrain in a
T-pose, a bug that reads as "the animation broke". An active camera naming an
object with no Camera Component is reported rather than resolved to whichever
object does have one.

**Route identity is authoritative, and the legacy route is only a redirect.**
`/edit/prefab/:prefabId` never falls back to the first Prefab.
`/edit/rig/:characterId` maps through the *one* legacy Character→Prefab table
and redirects; the old editor must not mount on the way through, because
mounting it rebuilds an edit session and runs a preview runtime for a URL whose
only remaining job is keeping bookmarks alive.

**One mapping source.** `LEGACY_CHARACTER_PREFAB_IDS` moved into
`packages/schema/src/migration.ts` and is imported by both the migration and the
redirect. Two copies of that table would agree right up until somebody added a
Character to one of them.

**No half-cutover of the Scene path.** Switching the Scene Viewport to
`RuntimeScene` while the Scene Editor's operations still wrote `entities` would
be exactly the parallel entity runtime this package forbids: two answers to what
is in the Scene, free to disagree. The Scene cutover is therefore all-or-nothing
with the GameObject operations and the API write path.

## Where this stands

Implemented: the Components-derived render projection and `GameObjectRenderer`;
the browser Prefab registry (the generated index now carries documents, not only
summaries); `/prefabs`, `/edit/prefab/:prefabId`, the Prefab Editor panels and
Prefab Overview; the legacy rig redirect; the renderer harness wired into
`harness:one-shot`.

Not implemented: the Scene runtime/editor cutover, the GameObject Scene
operations, the Prefab and adoption APIs, exact-target confirmation UI,
`AnimationSubjectDefinition`, the migration-only legacy schemas, canonical
removal of `characters`/`entities`, the demo-project migration and mirror
removal, Asset Library and Unity cutover, and the Repo Guard rules for all of
the above.

The production composition path is therefore still the legacy one. This decision
records the order and the reasons so the remaining work does not restart from
the wrong end.

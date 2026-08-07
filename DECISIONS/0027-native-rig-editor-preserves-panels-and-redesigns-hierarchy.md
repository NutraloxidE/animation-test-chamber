# 0027 — The native Rig Editor preserves the panels and redesigns only the Hierarchy

## Status

Accepted. Being implemented; the first vertical slice is in.

## Context

The Rig Editor was removed from the route table when editor identity moved to
Prefabs (0012, 0021). What was never removed was the fine-tuning UI: comparing
`main@2e5b2a2` against this branch shows fifteen of the workspace's components —
Inspector, Graph, Timeline, Timing, Replay, Terrain, AI, Diff, Haptics, Import,
World, `Field`, `MobilePad`, both World components and the Save Destination
dialog — are **byte-identical blobs**. Only `App.tsx`, `Hierarchy.tsx`,
`AssetLibrary.tsx`, `Viewport.tsx`, `styles.css`, `store.ts` and `engine.ts`
differ.

So the question was never "how do we rebuild the animation tools". It was "what
do those components read". They read a global, Character-bound Zustand store,
and the Character is the thing that no longer exists as an editing target.

## Decision

**`main` is a UI donor, not a merge source.** Nothing is merged, rebased or
cherry-picked from it. It supplies the behavioural baseline, the control
inventory, the test-ID inventory and the panel ordering, recorded in
`reports/rig-editor-main-ui-inventory.md` and
`tests/fixtures/rig-editor-main-testids.json`.

**Every fine-tuning panel is a preservation target.** A panel is not removed,
merged, renamed or simplified because its old Character-bound source is gone. A
panel that cannot operate for a subject keeps its tab and renders a structured
reason. `World` is restored to the tab list it had been dropped from.

**The Hierarchy is the single exception.** The old tree is Character, weapon
mode, equipment and graph states — a model that must not survive as the
structural tree of a workspace whose subject is a Prefab node's Animator. It is
redesigned around Prefab lineage, resolved nodes, Components and the exact
Animator.

**Workspace identity lives in the path**:
`/edit/prefab/:prefabId/animation/:nodeId/:componentId`. The workspace owns a
session, an engine, staging and publication; a `?component=animator` query would
let a bookmark restore the URL without restoring what it identified. The
Component is named by `componentId`, never by type, because one node may carry
several Animators and "the first Animator" is not an identity.

**One subject-scoped facade, not eleven rewirings.** Panels read
`AnimationChamberFacade` through a store whose selector semantics match the
legacy chamber's exactly, so a preserved component changes its import and
nothing else.

**The document is Character-free.** `AnimationChamberDocument` keeps the
property names the panels already read — an explicitly permitted compatibility
decision — while the values come from the resolved subject bundle and the
repository's *project-level* tuning profiles. `movement`, `rootMotion`,
`terrain`, `camera`, `inputMap` and `haptics` were always project-level, never
Character-level, which is what makes this possible without inventing state. No
Character is reconstructed.

## Consequences

Three shared types became generic so a Character-free document can use them
without a cast: `EditSession<TDocument>`, `resolveWeaponMode<TDocument>` and the
motion resolver's `MotionResolutionDocument`. Each defaults to, or is satisfied
structurally by, `ResolvedProject`, so no existing caller changed.

`ChamberEngine` still takes a `ResolvedProject` and still reaches the simulation
boundary through it. Rather than block the slice on that refactor, the panels
observe an `AnimationLivePreview` port — the four members they actually use —
which `ChamberEngine` satisfies structurally and which has an idle
implementation for subjects with no runnable body. Making the engine
subject-native replaces the idle implementation and changes no panel.

`panels/chamber-source.ts` resolves to the facade inside a provider and to the
legacy store outside one. It exists because both chambers are mounted while the
migration proceeds, it lives outside `animation-chamber/` so the native
directory never imports the legacy store, and it is expected to be deleted once
every caller arrives through the native route.

The motion-context selector now derives from the subject's resolved Motion Set
keys rather than the static `WEAPON_MODES` catalogue, which was wrong in both
directions — it hid contexts the catalogue did not know and showed contexts the
Motion Set did not bind. The catalogue survives as a display ordering, so the
demo project's chips are unchanged.

## Alternatives rejected

*Rebuild a simplified Rig Editor.* It discards working, tested UI and silently
redefines "restored" as "less than before".

*Reconstruct a `CharacterDefinition` from the subject.* The panels would not
change at all, which is exactly the appeal — and the result is canonical-looking
state with no canonical owner, where "what happens when this is saved" has no
answer.

*Keep the workspace embedded under `/edit/prefab/:prefabId`.* Composition and
authoring would share a page and, eventually, two live viewports.

# 0014 — Project → Character Lab → World

## Status

Accepted. Implementation in progress; see `reports/character-lab-world-placement.md`
for exactly which phases have landed.

## Context

The application exposes six different values that all read as "the selected
character", and no two of them mean the same thing:

| Value | Actually means | Scope |
| --- | --- | --- |
| `activeCharacterId` | the Character Definition the edit session resolved | shared definition |
| `characterPresetId` | a browser render-preset catalogue entry | preview renderer only |
| `sceneSelection` | the selected World object | world instance |
| `RuntimeInstance.source.characterId` | the definition one Instance references | world instance → shared |
| animation target | the World Instance Clip Preview / State Sandbox act on | world instance |
| Asset Library character picker | whose shared animation assets are being edited | shared definition |

So "switch character" has five defensible meanings, and the UI does not say
which one a given control performs. The individual states are separated
correctly in the store — that work is done — but the *sequence* a person is
supposed to follow is not presented anywhere.

`characterPresetId` is the worst of them. It is not canonical, it does not
change what any Instance references, it mostly affects one renderer, and it is
labelled `Character render preset` in a UI whose other "character" controls are
canonical. A reasonable person reads it as the project's character selector.

## Decision

The top level of the application is three **production stages**, not viewport
modes and not docks:

```text
Project  →  Character Lab  →  World
```

- **Project** manages reusable assets and definitions.
- **Character Lab** edits exactly one shared Character Definition.
- **World** places Character Definitions as Runtime Instances.

`primaryWorkspace` is a new top-level state, independent of bottom editor tabs,
viewport presentation, scene selection, asset selection, graph selection and
animation target. Those all keep their current meanings; what changes is that
there is now a stage above them that says which question the user is answering.

### Character Lab owns the rig preview

`Rig` is removed from the World viewport presentation cycle. World presentation
returns to `World | Isolate` — one renderer under a visibility filter, as
DECISION 0013 established.

This resolves an open question from that decision. The skinned GLTF renderer
had become a third World camera mode, which made the default World view either
show a skinned character *or* show Clip Preview, but not both. It was never a
camera mode: it is a single-character authoring preview, and Character Lab is
where single-character authoring happens.

### The application is not the AI agent

Claude Code and Codex run **externally**, against the repository, while the app
is open. "AI-friendly" therefore means discoverable schemas, typed commands,
machine-readable CLI output, stable asset locations, executable validation,
transactional writes and explicit human review points — not an AI tab.

The existing AI Proposal panel keeps working but leaves primary navigation. It
is not deleted; deleting working functionality needs its own deprecation
decision.

### Canonical identity, not preset identity

`characterPresetId` stops being a user-facing selection. Character Lab resolves
what to render from the Character Definition itself — `modelAssetPath`, the
referenced Rig, and the resolved animation bundle — with the procedural body as
the explicit fallback when `modelAssetPath` is null. The preset catalogue
survives only as a rendering *adapter*, and anything preview-only that remains
is named `Preview Stage` / `Fallback Model`, never `Character`.

No `CharacterDefinition` schema expansion unless a real editor field needs one.
Behaviour, motion-set, skeleton and clip contents stay in their own assets and
stay referenced.

## Consequences

- One new top-level state and one new nav bar; every existing surface keeps its
  own selection model.
- The World viewport presentation cycle loses a stop.
- `characterPresetId` remains in the store as a rendering adapter input during
  migration, and every remaining dependency on it is inventoried in the report
  rather than left to be discovered.
- Character Lab and World share one animation workspace through an explicit
  subject adapter, rather than growing a second Clip Preview.

# 0012 — Scene hierarchy represents existence; the inspector edits the selection

## Status

Accepted.

## Context

The multi-instance world landed (DECISION 0009) and the runtime became
world-first: a world holds runtime instances, each with its own transform,
intent source and overrides, all referencing shared character definitions. The
UI did not follow.

It ended up with two incompatible navigation systems at once:

- a left-hand "Hierarchy" that was really a settings form — character preset
  select, weapon mode select, equipment checkboxes, terrain, and the animator's
  layers and states, all indented under one another as though indentation made
  them one tree;
- the actual runtime instance list, hidden inside a right-hand tab named
  `World`, next to `Timing` and `Haptics`.

So the question "what am I looking at?" had two answers that could disagree.
`selectedInstanceId` was written by the world panel; `activePanel` was written
by the pseudo-hierarchy. Both were writable, neither was derived from the
other, and when they diverged the right-hand dock showed one object's
properties under another object's name.

Two specific controls made the ambiguity concrete. `setWeaponMode(id)` and
`setEquipped(slotId, equipped)` were global engine setters with no instance
anywhere in their signatures. In a world holding two instances of the same
character definition — which is the acceptance fixture — there was no answer
the code could give to "which one did that change?"

## Decision

Five sentences, each of which decides where a control goes:

1. **The hierarchy represents scene/world existence.** It renders the staged
   world, its instances, their derived attachments, terrain and camera. A row
   answers *what is this, is it selected, is it enabled, does it have
   children*, and nothing else.
2. **The inspector edits the selected scene object.** Its content is a function
   of one `SceneSelection`, not of a tab index.
3. **Preview workspaces perform temporary operations.** Animation Preview owns
   "play this now"; it writes nothing.
4. **Project/Assets owns reusable shared definitions.** Anything whose edit
   affects more than one instance lives there, under a `SHARED` badge.
5. **Focused view is a viewport presentation, not a second authoring model.**
   It became `World | Isolate`, and changing it touches neither the selection
   nor the inspector.

### One selection, derived rather than duplicated

```ts
type SceneSelection =
  | { kind: 'world' }
  | { kind: 'instance'; instanceId: string }
  | { kind: 'attachment'; instanceId: string; slotId: string }
  | { kind: 'terrain' }
  | { kind: 'camera' };
```

`selectedInstanceId` is now a *function* of the selection, not a field beside
it. An attachment resolves to its parent instance, so clicking the shield and
clicking the instance target the same object for every loadout edit. There is
exactly one writer (`selectScene`), and removing an instance reconciles the
selection back to the world root inside that writer rather than at each call
site.

Asset selection, bottom workspace and viewport presentation are separate
fields. Opening a source character from an instance moves the *bottom dock*, so
the inspector stays on the scene object the user was editing.

### Attachments are derived, not canonical

Attachment rows project the project's declared equipment slots onto an
instance. No schema changed. Creating explicit attachment entities would have
cost a migration, generated output, a Unity DTO review and a legacy
compatibility story to buy one indentation level. If explicit entities ever
arrive, the selection semantics do not have to change.

### Loadout is instance-qualified, through commands

Two new commands, `world.set_instance_weapon_mode` and
`world.set_instance_equipment`, write `RuntimeInstanceOverrides` fields the
schema already had. Clearing an override *removes* it rather than writing the
current default back — an override recorded as `false` because that was the
default at the time would silently stop following the definition the moment
somebody changed it.

The focused chamber keeps working: an edit targeting the world's
`focusedInstanceId` also reaches the focused engine, because the focused
chamber is a view over that instance rather than a second runtime. An edit to
any other instance deliberately does not.

### Preview is applied on the read side

The Animation Preview override is applied in `WorldChamberEngine.poseOf` —
after the simulation has stepped — never in `Simulation.step`. That placement
is the whole design. A preview that forced a state into the fixed step would
change the tick record, which is what replay determinism is measured against,
and "preview does not mutate canonical data" would become a claim about
discipline rather than a property of the code.

## Consequences

- The right-hand dock has no tab strip. Reaching a scene object means selecting
  it, which is more clicks for someone who knew the old tab layout and fewer
  for someone reasoning about the scene.
- Graph, Timeline, Replay, Project and the secondary panels moved to a bottom
  dock, so the inspector stays visible while they are open. Previously opening
  the graph hid whatever was being inspected.
- `PanelId`, `activePanel`, `setPanel`, `worldMode`, `setWeaponMode` and
  `setEquipped` are gone. Each was a second writable path to a question that
  now has one.
- Visual tests that navigated by tab were rewritten to navigate by selection.
  No assertion was weakened; only the route to the panel changed.
- The character *render* preset moved to Project/Assets rather than to an
  inspector. It is a shared definition, and putting it one row from a
  per-instance shield toggle was the original mistake in miniature.

# ATC One-Shot Implementation Spec — Wildlands Skirmish

## Execution profile

This task is intended to be executed **in one shot** by a coding agent such as **GPT-5.6 Sol Low** or **Claude Opus 5 Low**.

Because the reasoning budget may be low:

- Do not stop at planning, scaffolding, TODOs, mock UI, or partial systems.
- Read the required repository documents first, then implement the complete playable loop.
- Prefer the narrowest existing ATC extension surface.
- Make coherent autonomous design decisions when details are unspecified.
- Do not ask the user to choose exact numbers, item names, colors, prices, bark lines, or tuning values unless the repository literally prevents progress.
- If one optional polish feature threatens completion, preserve the full gameplay loop first.
- After implementation, run the required validation, fix failures, and only then consider the task complete.

The goal is not to produce the smallest literal interpretation. The goal is to produce a **coherent, browser-playable mini-game that demonstrates Animation Test Chamber as an AI-native game development harness**.

---

# 0. Mandatory repository boot sequence

Before editing:

1. Read `README.md` completely.
2. Read `agents/GAMEPLAY_VIBE_CODING.md`.
3. Read the closest existing Gameplay Script examples, especially:
   - `packages/gameplay/src/scripts/health/`
   - `packages/gameplay/src/scripts/stamina/`
   - existing pickup / spawning / interaction / encounter examples
4. Read `agents/skills/add-character-movement.md` before changing CharacterMotor-related behavior.
5. Read `agents/skills/add-weapon-sword.md` before adding or changing held equipment.
6. Inspect the current canonical assets for:
   - `assets/prefabs/quaternius-universal-base/1.0.0.json`
   - `assets/animation/motion-sets/quaternius-universal-motion-set/1.0.0.json`
   - `assets/animation/rigs/quaternius-universal-rig/1.0.0.json`
   - `assets/animation/behaviors/humanoid-third-person-base/1.0.0.json`
   - relevant `universal-*` animation clips
7. Inspect the current input map and current game UI patterns.
8. Inspect available repository character, equipment, armor-like, environment, audio, prop and animation assets before inventing new ones.

Do not assume remembered repository details are still correct when the source can be inspected directly.

---

# 1. Architectural rules — do not violate these

Follow ATC's intended architecture.

## Game rule = Gameplay Script

Ordinary mechanics belong in Gameplay Scripts and authored game data.

Examples:

- HP / stamina
- damage / healing
- XP / leveling
- currency
- pickups
- shop rules
- equipment ownership
- stat upgrades
- respawn
- match flow
- AI decisions
- contextual barks
- item use
- anti-stuck recovery
- out-of-bounds recovery

Do **not** create a mechanic-named native engine Component, renderer special case, Simulation branch, or central runtime switch for ordinary gameplay.

Only add a native reusable engine capability if the feature genuinely cannot be represented through the existing Gameplay SDK / Prefab / Scene / UI / animation surfaces.

If a reusable capability is genuinely missing, implement the **smallest generic reusable capability**, not a Wildlands-Skirmish-specific hack.

## Preserve deterministic authority

- No `Math.random`.
- No gameplay wall-clock authority.
- No mutable module-global gameplay state.
- Use ATC fixed-tick / deterministic APIs and `ctx.random()` where applicable.
- CharacterMotor-owned characters must not be moved through a competing transform authority.
- Use Character Motion commands for character movement / reposition / teleport when required.
- Runtime state must not write itself back into canonical authored Scene / Prefab data.

## Exact-once state changes

Purchases, pickups, consumable use, damage application, XP rewards, KO rewards, respawns and equipment changes must not double-fire because of input bounce, duplicate subscriptions or match resets.

---

# 2. Core game

Create a small third-person skirmish game, provisionally named:

**Wildlands Skirmish**

The exact Scene / route id may be chosen by the implementation agent, but it must have a stable explicit play route such as:

`/play/<scene-id>`

Do not silently replace or break unrelated existing demos.

---

# 3. Character baseline — hard requirement

Use the canonical ATC character:

- Prefab / character id: **`quaternius-universal-base`**
- Display name: **Universal Base Superhero**

Use this same character base for:

- the player
- all 4 allied NPCs
- all 5 enemy NPCs

Do not introduce unrelated character rigs for visual variety.

Visual and gameplay differentiation should come from:

- team marker / team material accent
- held equipment
- helmet
- chest armor
- leg armor
- behavior / selected equipment context

## Respect the existing canonical animation stack

The Universal Base character already has canonical:

- `quaternius-universal-rig`
- `quaternius-universal-motion-set`
- shared `humanoid-third-person-base` behavior
- Universal Base contextual animation bindings
- an authored `right-hand-sword` equipment socket

Use these existing canonical assets rather than creating a parallel animation controller.

Gameplay code must not directly pick animation clips. It should drive gameplay / animation state through the existing intended behavior and contextual mechanisms.

## Important imported-animation limitation

Do not casually retime or globally "correct" the imported Universal animation set.

The current repository intentionally carries imported clip timing/events in a canonical form that may inherit timing from the demo-character slot mapping. Do not re-measure and retune the full library as part of this task.

Preserve the current authored behavior unless a small targeted fix is required for this game and can be validated.

---

# 4. Match composition

Each match is:

- Player + 4 allied AI
- versus 5 enemy AI

Steady-state team size while everyone is alive:

- 5 allies
- 5 enemies
- 10 total characters

Friendly fire is OFF.

Temporary reduction in living actors during the respawn countdown is allowed.

After respawn, the team must return to 5 active combatants.

---

# 5. Team readability

## 3D overhead triangle markers

Every non-player combatant must have a small 3D triangle marker above the head.

Use clear team differentiation:

- allied NPCs: blue/green family
- enemy NPCs: red family

The player does not need a normal overhead marker.

Requirements:

- world-space
- follows the character
- remains above the head through all animations
- readable during day and night
- does not remain at world origin
- does not leak / duplicate on respawn
- sensible distance scaling or visibility handling
- avoid showing strong markers through large occluders if the current renderer makes reasonable occlusion practical

## Team material / appearance accent

Also apply a lightweight team-readable visual difference on the character or equipment so team identity is not dependent only on the overhead marker.

Do not destroy the original Universal Base character look.

---

# 6. World / terrain

Build a natural outdoor combat area.

Required visual structure:

- playable grassland
- gentle hills
- tree clusters with varied density
- clearings
- rocky areas
- mountains or high terrain forming a natural outer boundary
- one strong central natural landmark for orientation

Examples of a central landmark:

- large rock formation
- distinctive giant tree
- small natural ruin-like rock formation

Choose coherently based on available assets.

## Terrain constraints

- Keep the central combat region open enough for reliable AI movement.
- Do not uniformly random-distribute trees.
- Do not create spawns inside geometry.
- Do not create normal spawns on inaccessible steep slopes.
- Prefer reproducible / seeded placement when procedural variation is used.
- If advanced navigation is unavailable, simplify terrain density rather than building AI that cannot traverse it.

---

# 7. Camera

Use a third-person orbit camera.

Required:

- normal player follow
- camera-space movement consistent with ATC's input / simulation conventions
- camera collision / obstruction handling so trees, rocks and terrain do not make the camera unusable
- avoid camera permanently clipping inside geometry

A complex lock-on system is **not required** unless it is already trivial with current ATC capabilities.

---

# 8. Core combat

Player and NPCs should use the **same underlying character combat / action capability**.

The difference should be:

- player actions originate from input
- NPC actions originate from AI decisions

Do not create a separate fake NPC combat system.

Core actions:

- move
- attack
- dodge / roll
- guard if supported coherently by selected equipment context
- take damage
- hit reaction
- defeat / KO
- respawn

## Stamina

- attacks consume stamina
- dodge / roll consumes stamina
- stamina recovers over time
- stamina always clamps to `0..max`
- no negative stamina
- no overflow above max

## Attack acceptance / recovery

Do not allow attack spam every simulation tick.

Respect the current action state / recovery / animation behavior so an attack is accepted only when valid.

If equipment is changed during an action:

- either perform a safe supported interrupt
- or queue the equipment switch until the current action can safely end

Do not allow rapid D-pad switching to corrupt animation context or held-item state.

## Facing

Before an AI attack, correct facing enough that NPCs do not repeatedly attack sideways or away from the target.

---

# 9. Shared authoritative stats model

Use one stat model for player and NPC characters.

Minimum combat stats:

- Max HP
- Max Stamina
- Attack
- Defense

Do not make player damage and NPC damage use unrelated formulas.

Use one authoritative damage pipeline, for example conceptually:

`base attack result -> Attack modifiers -> Defense modifiers -> actual applied HP damage`

Exact numbers and exact formula are delegated to the implementation agent, but the design must be:

- simple
- monotonic
- understandable
- clamped / safe
- impossible to produce invalid negative HP damage
- shared by player and NPCs

The floating damage number must use the **actual HP delta that was applied**, not a second predicted calculation.

---

# 10. Hit feedback

A successful hit should be immediately readable.

Trigger feedback from the same authoritative combat event, not multiple independent hit detectors.

Use a coherent subset of:

- damage number
- hit reaction animation
- small hit visual flash/effect
- light camera shake for player-relevant impact
- controller vibration where supported
- short hit sound if suitable assets exist

Do not make hit reactions create permanent stun-lock.

Use existing `universal-hit` / canonical animation bindings where appropriate.

---

# 11. Floating damage / healing / reward feedback

## Damage numbers

On successful damage:

- show the actual damage applied to HP
- place near the damaged target in readable projected / world-space form
- short lifetime
- clean removal
- no DOM / entity leak

For rapid hits:

- spatially offset
- temporally offset
- or aggregate coherently

Do not flood the screen.

Prioritize:

1. player damage events
2. nearby player-relevant combat
3. nearby NPC-vs-NPC combat

Avoid displaying strong damage numbers from distant fights through terrain.

Do not display a misleading positive damage number for zero-damage / invalid hits.

## Healing numbers

When healing:

- show the **actual HP restored after max-HP clamping**
- e.g. conceptually `+N`
- clean up after a short lifetime

## Currency / XP feedback

Use the same general feedback presentation system where practical for:

- currency pickup
- XP gain
- level-up
- purchase feedback

Do not create four unrelated state machines for four floating text types.

---

# 12. Held equipment / loadouts

The Universal Base motion set already includes contextual animation families.

Inspect the current available assets and contextual bindings, then choose roughly **3–4 coherent held-equipment / combat archetypes** that work best with the current repository.

Do not hardcode a specific set in advance if the repository offers a better compatible combination.

Potential contextual families already worth inspecting include:

- sword
- shield
- magic
- pistol
- throw
- unarmed / base

The implementation agent must choose combinations that are visually and mechanically coherent with current assets.

## D-pad switching

Controller D-pad switches held equipment / loadout.

Requirements:

- fast and readable
- current loadout shown near HP / stamina
- HUD gives a brief switch emphasis / transition
- keyboard fallback for browser testing
- no input conflict with menus or shop
- switching updates gameplay state + animation context + held visual consistently

## Equipment socket rules

For held items, the character Prefab's `EquipmentSockets` is the source of truth.

For sword-family equipment:

- reuse `right-hand-sword` where appropriate
- attach to the configured hand bone
- apply socket local transform as authored
- do not attach to model root
- do not use legacy `weaponGrips` as the new source of truth
- do not bake per-character grip correction into the weapon mesh just to fix one character

The held visual must remain attached through:

- idle
- walk
- run
- attack
- dodge
- respawn

---

# 13. Armor / character customization

Implement these equipment slots:

- Held Equipment / Weapon
- Helmet
- Chest Armor
- Leg Armor
- Consumable quick slot

The three armor slots are required.

## Visual requirement

Changing:

- Helmet
- Chest Armor
- Leg Armor

must visibly change the Universal Base Superhero.

The visual must stay aligned through:

- idle
- locomotion
- attack
- hit reaction
- dodge / roll
- respawn

## Asset compatibility first

At implementation start, inspect whether the repository already has armor or modular-character assets compatible with Universal Base Superhero.

Prefer, in order:

1. existing compatible modular / skinned mesh
2. existing rig-compatible equipment asset
3. bone-attached armor prefab where visually valid
4. a minimal clean low-poly fallback visual that proves the slot system

Do **not** silently remove Helmet / Chest / Legs because perfect armor art is unavailable.

Do not require arbitrary third-party armor to fit every possible humanoid. This demo only needs a coherent set compatible with the selected Universal Base character.

## Armor implementation technique is delegated

Choose the best technique per body region:

- helmet may use head-bone attachment
- chest / legs may need rig-compatible skinned or multi-bone-compatible meshes
- another current ATC-compatible technique is allowed

Do not force every slot through one bad method.

## Atomic equip

Armor equip should be treated as one state change:

`owned item -> equipped slot -> visual swap -> stat modifier update -> HUD/UI update`

Avoid visible / gameplay half-states.

When replacing armor:

- prepare new state
- apply coherent swap
- remove old visual / modifier
- do not leave orphan meshes / components

Repeated equip/unequip must not multiply visuals or modifiers.

---

# 14. Equipment ownership vs equipped state

Keep these concepts distinct:

- item owned by player
- item currently equipped in a slot

Buying an item may optionally auto-equip it, but ownership and equipped slot must not be the same data field.

Provide a small equipment view showing current:

- Held
- Head
- Chest
- Legs
- Consumable

Do not build a huge RPG inventory.

---

# 15. Armor and stat effects

Armor should have small, understandable gameplay effects.

Examples only:

- Helmet: defensive / durability-oriented modifier
- Chest: stronger defensive modifier
- Legs: stamina / movement-oriented modifier

The implementation agent chooses exact item names, values and tradeoffs.

Requirements:

- effect uses the same authoritative stat model
- no hidden second combat formula
- item replacement removes old modifier exactly once
- HUD / equipment screen shows the resulting current stats
- stat effects persist through same-match respawn
- stat effects reset at next match as required by the match-scoped progression policy

---

# 16. XP and leveling

Show XP / level near the top-center HUD.

Player earns XP from:

- KOs
- assists

Do not award XP per damage tick.

NPCs do **not** level up in this version.

## Level-up stat choice

Every time the player levels up, pause the game and present a small upgrade selection.

Minimum choices:

- HP
- Stamina
- Attack
- Defense

The player chooses **exactly one stat per level**.

After selection:

- apply immediately
- show short confirmation
- close the prompt
- resume game

Display current upgrade allocation somewhere in the level-up / equipment / stats UI, for example conceptually:

`HP +2 / STA +1 / ATK +0 / DEF +1`

Exact presentation is delegated.

## Full pause authority

While the level-up selection is open, pause the complete match simulation coherently:

- AI
- match / day timer
- character actions
- stamina regeneration
- delayed combat events
- projectiles if any
- relevant gameplay simulation

Do not create a state where only the UI appears paused while the battle continues invisibly.

## Tuning goal

Tune the short match progression so a normal engaged 5-minute player has a good chance to visibly level at least once.

Avoid a large skill tree.

---

# 17. Match-scoped progression reset

The following are **match-scoped**:

- XP
- level
- selected stat upgrades
- currency
- purchased consumables
- purchased armor / equipment additions
- temporary shop ownership state

They:

- persist through death / respawn during the same match
- reset at the next Day / Match reset to a deterministic baseline

The player does not lose currency on death.

---

# 18. Currency drops

When an enemy is defeated:

- spawn a visible currency pickup in the world
- the player can collect it
- NPCs do not collect it
- increment currency exactly once
- show clear pickup feedback
- remove / despawn the pickup cleanly

Auto-pickup in a short radius is preferred for simplicity.

Currency pickups must have a bounded lifetime so abandoned drops do not accumulate forever.

Currency name, drop amount and appearance are delegated.

---

# 19. Shop

Create a clear player-side shop / safe-area object near the allied spawn.

Also create a visually related enemy-side base / shop-like landmark for spatial symmetry if useful, but enemy NPCs do not use an economy or shop AI.

## Player shop behavior

Approach / interact opens a small shop UI.

Required stock categories:

- HP recovery consumable
- Helmet options
- Chest Armor options
- Leg Armor options

Additional small coherent consumables are allowed if trivial.

Do not build:

- crafting
- rarity systems
- giant inventory
- NPC economy
- randomized loot-table complexity

## Shop behavior

Purchase:

- checks currency
- deducts currency exactly once
- grants item exactly once
- gives clear success / insufficient-funds feedback

Armor purchase can offer:

- buy
- equip
- replace currently equipped slot

Show simple stat comparison where useful.

Example concept:

`Defense +2`
`Stamina -1`

Exact values are delegated.

## Safe shop usage

The shop area should be safe / readable enough that the player is not constantly attacked while selecting items.

The simplest acceptable behavior is:

- enemy AI strongly avoids entering the immediate player shop/spawn safe zone

Do not add a huge base-defense system.

## Shop input context

When shop UI is active:

- movement / combat / D-pad equipment switching must not accidentally fire behind the menu
- use a coherent menu input context
- debounce confirm / purchase so one press cannot buy twice

---

# 20. Consumable quick slot

Show the currently available healing consumable and count near HP / stamina.

Allow one-button use outside menus.

Requirements:

- decrements count exactly once
- applies healing exactly once
- clamps to max HP
- shows actual restored amount
- unavailable / zero-count use is handled cleanly
- no input conflict with attack, dodge, D-pad loadout or interaction

Choose the exact key / button after inspecting the current input map.

---

# 21. AI behavior

Keep AI simple, reliable and shared.

Suggested state flow:

- Idle / Roam
- Acquire Hostile
- Approach
- Face Target
- Attack
- Guard / Dodge / Reposition where coherent
- Recover / Retreat when low stamina
- Re-evaluate Target
- Return / Leash
- Respawn

Do not build an oversized behavior-tree architecture if the current repository does not need one.

## Target re-evaluation

AI should re-evaluate if:

- target is defeated
- target is too far
- target is unreachable
- a closer / more urgent hostile is available
- current pursuit exceeds combat leash

## Target distribution

Avoid all 5 NPCs permanently choosing the same target when other valid hostiles are available.

Use a lightweight pressure / target-count / proximity heuristic.

Do not attempt sophisticated squad tactics.

## Retreat / stamina behavior

When stamina is low, AI can:

- pause
- create distance
- reposition
- re-engage

This is enough to make the combat less like constant collision.

## Combat leash

NPCs should not chase opponents indefinitely into mountains, invalid terrain or deep spawn zones.

Return toward the playable combat area after a sensible leash threshold.

---

# 22. Navigation robustness

Navigation failure must not destroy the match.

Use existing navigation / pathing if available.

Otherwise keep the arena compatible with simple movement and obstacle avoidance.

## Anti-stuck

If an NPC is trying to move but remains effectively stuck for too long:

1. retry / repath
2. choose a nearby valid point
3. as final recovery, safely reposition using the correct Character Motion authority

Do not repeatedly teleport characters every few seconds as the normal navigation method.

## Character separation

Prevent 10 characters from perfectly occupying one point.

Use light separation / collision behavior without making allies violently push each other.

---

# 23. Out-of-bounds recovery

Detect clearly invalid character states such as:

- under terrain
- outside intended playable bounds
- impossible / broken position
- unrecoverable navigation state

Recover the character to a safe valid point using the correct character movement authority.

This recovery must:

- preserve team
- preserve same-match equipment
- preserve same-match XP / stats / currency for the player
- not count as an extra KO unless the gameplay rules deliberately define it that way

---

# 24. Defeat and respawn

Use a non-graphic defeat presentation.

On defeat:

- actor becomes inactive / absent from combat
- no duplicate actor remains active
- show visible **3-second respawn countdown**
- then respawn at a safe valid team spawn

## Safe spawn selection

Choose among valid team spawn candidates.

Prefer a spawn that is:

- walkable / grounded
- not inside geometry
- not on inaccessible steep terrain
- not immediately adjacent to enemies when alternatives exist

## Spawn protection

Give a brief spawn-protection window.

It should be short and readable.

If practical, attacking can end protection early.

Do not allow permanent invulnerability.

## Same-match persistence across respawn

Respawn restores:

- current held equipment
- current Helmet
- current Chest Armor
- current Leg Armor
- current stat upgrades
- current XP / level
- current currency
- current consumable inventory

without duplicating:

- meshes
- modifiers
- subscriptions
- markers
- HUD bindings

---

# 25. NPC contextual barks

Implement a lightweight **Contextual Bark System**, not a conversation tree.

Trigger categories may include:

- enemy spotted
- combat start
- attack
- low HP
- ally defeated
- enemy defeated
- respawn
- day / night reaction

Requirements:

- multiple short variants
- allied / enemy tone can differ
- exact lines authored autonomously
- cooldowns to prevent spam
- limit simultaneous barks
- prioritize nearby / player-relevant barks
- distant NPCs should not fill the player's UI
- text-only is sufficient

Use small overhead text or subtitle-style presentation depending on current ATC UI strengths.

Audio / TTS is optional and must not become a dependency.

---

# 26. Audio

Use suitable existing repository audio assets if available.

High-value events:

- successful hit
- KO
- currency pickup
- level up
- purchase
- heal
- match start
- result

Do not block the game if audio assets are absent.

Do not introduce a heavy external audio dependency merely to satisfy polish.

---

# 27. Day / night and match clock

One in-game day equals one match.

**One match = 300 real seconds = 5 real minutes.**

The match starts in the morning, progresses continuously through:

- morning
- day
- evening
- night
- dawn / next-day boundary

At the next dawn, the match ends.

Conceptually:

- 24 in-game hours / 300 real seconds
- 1 in-game hour = 12.5 real seconds

## Environment transition

Animate as supported:

- sun direction
- sky brightness
- ambient light
- scene color / fog / shadows if appropriate

Night must remain playable.

Do not make the night so dark that team markers / terrain / combat become unreadable.

Night is cosmetic in v1:

- do not change AI detection / perception because it is night

Shop / spawn landmarks should remain easy to locate at night.

No weather system is required.

---

# 28. Match scoring and lifecycle

Track allied and enemy team KO score.

At the end of 300 seconds:

- determine Victory / Defeat / Draw from team KO score
- enter a match-ending state
- stop accepting further gameplay rewards / damage / purchases
- show result summary briefly
- reset
- start the next day / match

Suggested result summary:

- Victory / Defeat / Draw
- allied vs enemy KO score
- player KOs
- assists
- currency earned
- level reached

Exact layout is delegated.

## Required lifecycle state separation

Use an explicit lifecycle equivalent to:

- `MATCH_ACTIVE`
- `MATCH_ENDING`
- `RESETTING`
- `MATCH_ACTIVE`

Do not allow match-end and next-match operations to overlap.

---

# 29. Match generation / stale-event protection

This is a hard reliability requirement.

Every delayed / deferred gameplay operation must belong to the match generation that created it.

Examples:

- pending respawn
- currency spawn
- delayed bark
- delayed hit feedback
- purchase callback
- level-up prompt
- match result transition
- deferred world mutation

When a match resets, stale work from the previous generation must not fire into the next match.

Prevent bugs such as:

`enemy KO -> currency spawn queued -> match resets -> old currency appears in new match`

or:

`old respawn timer -> new match -> duplicate actor spawns`

Use a match-generation id / token or an equivalent deterministic lifecycle guard.

---

# 30. Pause / browser focus behavior

Use one coherent pause authority.

Pause sources may include:

- level-up selection
- explicit pause
- browser focus loss if current ATC behavior supports this cleanly

Do not let the 5-minute timer continue while the game simulation is otherwise intentionally paused.

Do not allow AI to keep fighting while a modal gameplay menu has logically paused the match.

---

# 31. Gamepad resilience

Gamepad is a primary target because D-pad equipment switching is required.

Also support keyboard / mouse fallback for testing.

If controller disconnects:

- do not throw runtime errors
- keyboard / mouse remains usable
- reconnect can recover if practical

---

# 32. HUD

## Top center

Show:

- compass with cardinal / intercardinal direction
- XP / level bar
- team KO score

Example structure only:

`W  NW  N  NE  E`

`Lv.3  ███████░░  72%`

`ALLY 08 - 06 ENEMY`

## Top right

Show:

- currency

## Bottom left

Show:

- current held loadout
- D-pad slot indicator
- HP
- stamina
- consumable quick-slot / count

## Equipment / stats panel

Provide a small non-cluttered view for:

- Held
- Head
- Chest
- Legs
- Consumable
- current HP / STA / ATK / DEF values
- level-up allocations where useful

## Other transient UI

- damage numbers
- heal numbers
- currency feedback
- XP / level-up feedback
- NPC barks
- target-awareness indicator
- 3-second respawn countdown
- match-start banner
- result screen
- shop UI

The HUD must bind to authoritative game state and must not maintain a duplicate shadow combat model.

---

# 33. Target-awareness UI

Because combat is 5v5, provide lightweight awareness for enemies threatening the player from off-camera.

Use a small screen-edge / directional indicator when a nearby enemy is currently threatening / targeting the player.

Requirements:

- not always-on clutter
- directional
- distance / urgency can affect emphasis
- remove cleanly when threat ends
- no duplicate indicators across respawns

---

# 34. Match start presentation

At the beginning of each day / match, show a short lightweight presentation such as:

`DAY 1`
`5 VS 5`
`FIGHT`

Exact wording / animation is delegated.

Do not block controls for an unnecessarily long time.

---

# 35. Shop / level-up / pause input contexts

Modal UI must own input while open.

When a modal menu is active, prevent gameplay inputs behind it, including:

- attack
- dodge
- D-pad loadout switching
- interact spam
- quick-slot use

Use input debounce / edge-trigger semantics where appropriate.

One physical press must not execute a purchase or stat selection twice.

---

# 36. UI viewport safety

The game HUD must remain usable on normal desktop browser sizes and narrower layouts.

Avoid:

- compass overlapping XP
- shop covering required confirm UI
- bottom-left HP / stamina falling behind mobile / browser controls
- persistent panels consuming most of the viewport

Follow the current ATC responsive / overlay patterns where available.

---

# 37. Resource loading resilience

Preload / warm up the most important assets before normal combat begins where practical:

- Universal Base model
- selected contextual animation families
- core held equipment
- armor used by initial stock
- essential VFX / audio if present

Avoid a major first-attack hitch caused by late-loading the primary combat animation.

If one non-critical asset fails:

- report a debug warning
- use a fallback or omit that cosmetic asset
- keep the match running

Do not allow one optional armor / audio asset failure to crash the whole game.

---

# 38. Debug overlay

Add a Debug Overlay / toggle, **OFF by default**.

Useful fields:

- match generation
- match state
- current seed
- day timer
- team counts
- team KO score
- player HP / stamina / XP / level
- player ATK / DEF
- current held equipment
- Head / Chest / Legs
- AI state for selected / nearby NPC
- current animation / contextual equipment state
- active pickup count
- active damage/heal feedback count
- stuck-NPC warnings
- runtime invariant warnings

Keep normal gameplay clean when debug is disabled.

---

# 39. Automated demo health check

Maintain lightweight runtime checks suitable for the debug overlay and test harness.

Monitor for problems such as:

- incorrect ally / enemy counts
- duplicate active character ids
- duplicate markers
- duplicate equipment visuals
- invalid animation context
- pickup accumulation
- stuck NPCs
- invalid HP / stamina
- stale previous-match events
- uncontrolled UI / DOM growth
- runtime / console errors

This health check is diagnostic, not a second gameplay authority.

---

# 40. Deterministic stress / test mode

Provide a debug/test-only way to exercise lifecycle-heavy systems without waiting multiple real 5-minute matches.

Useful commands / controls may include:

- force player XP gain
- force level up
- force KO
- force respawn
- spawn currency pickup
- advance match clock
- end match
- reset match
- repeat respawn
- repeat armor equip
- run two or more accelerated match cycles

The exact debug interface is delegated.

Production gameplay must still use the normal 300-second match.

Stress mode must not become required for normal play.

---

# 41. Event log for debugging

In debug mode, keep a small bounded event log for events such as:

- KO
- Assist
- XP gain
- Level Up
- Stat Choice
- Currency Drop
- Currency Pickup
- Purchase
- Equip
- Consumable Use
- Respawn
- Match End
- Match Reset

Bound the log size.

Do not retain unbounded history forever.

---

# 42. Performance and cleanup

The game should remain stable across repeated deaths and repeated matches.

Bound or clean:

- character instances
- overhead triangles
- equipment visuals
- armor visuals
- pickups
- damage / heal number elements
- barks
- target-awareness indicators
- event subscriptions
- deferred callbacks
- debug log
- HUD listeners

No uncontrolled DOM / object / event-listener growth.

---

# 43. Scope exclusions

Do NOT add these in this task:

- multiplayer
- save / persistence across browser sessions
- quests
- crafting
- giant inventory
- loot rarity / loot table system
- complex skill tree
- NPC shopping / economy decisions
- elaborate dialogue trees
- weather system
- night stealth / AI perception system
- universal armor fitting across arbitrary humanoids
- complex lock-on unless trivial with current capability
- massive behavior-tree framework
- unrelated engine refactors

Do not broaden the project merely because the coding agent sees an opportunity.

---

# 44. Implementation priority

Work in this order.

## Priority 1 — complete playable loop

Must exist first:

1. Scene boots.
2. Universal Base player + 9 NPCs spawn.
3. 5v5 team assignment works.
4. Player movement / camera works.
5. AI finds and fights enemies.
6. Damage / HP / stamina works.
7. KO / 3-second respawn works.
8. XP / level-up / stat selection works.
9. Currency drop / pickup works.
10. Shop / healing works.
11. Held loadout switching works.
12. Helmet / Chest / Legs equip works.
13. Day / night 300-second match works.
14. Result / reset / next match works.

## Priority 2 — correctness and feedback

Then:

- authoritative damage numbers
- healing numbers
- hit reaction
- team markers
- material team accents
- compass / HUD
- target awareness
- NPC barks
- shop comparison UI
- audio where available

## Priority 3 — robustness

Then:

- safe spawn selection
- spawn protection
- anti-stuck
- out-of-bounds recovery
- combat leash
- target distribution
- match-generation stale-event protection
- focus / pause resilience
- controller disconnect resilience
- resource fallback

## Priority 4 — validation tooling

Then:

- debug overlay
- health check
- stress mode
- bounded event log

Do not spend the majority of the task polishing a single VFX while the full loop is incomplete.

---

# 45. Hard acceptance checklist

The feature is not complete until all applicable items pass.

## Boot / composition

- [ ] Scene boots in browser.
- [ ] Player uses `quaternius-universal-base`.
- [ ] All 9 NPCs use `quaternius-universal-base`.
- [ ] Exactly 5 allies and 5 enemies exist in normal alive steady-state.
- [ ] No console error on initial load.

## Character / animation

- [ ] Canonical Universal Base rig / motion set / behavior is used.
- [ ] Existing contextual animation system is respected.
- [ ] Gameplay code does not directly hard-select clips.
- [ ] Held equipment follows the correct hand attachment.
- [ ] No held item remains at world origin.
- [ ] Equipment switching updates animation context coherently.
- [ ] Attack / dodge / hit / locomotion do not obviously break equipment alignment.

## Team readability

- [ ] Allies have readable overhead 3D triangle markers.
- [ ] Enemies have readable overhead 3D triangle markers.
- [ ] Markers track heads correctly through animation.
- [ ] Team visual accent is also visible on character/equipment.
- [ ] Respawn does not duplicate markers.

## Combat

- [ ] Player attack works.
- [ ] NPC-vs-NPC combat works.
- [ ] Friendly fire is OFF.
- [ ] Attack consumes stamina.
- [ ] Dodge consumes stamina.
- [ ] Stamina recovers.
- [ ] HP / stamina always clamp to valid ranges.
- [ ] Attack spam cannot bypass action recovery.
- [ ] AI faces targets enough to attack reliably.
- [ ] Hit reaction works without permanent stun-lock.

## Damage / feedback

- [ ] Successful hit shows the actual applied damage.
- [ ] Rapid damage numbers remain readable.
- [ ] Distant NPC combat does not flood the player HUD.
- [ ] Damage feedback cleans up.
- [ ] Healing shows actual restored HP.
- [ ] Currency / XP feedback is readable.

## Stats / leveling

- [ ] XP comes from KOs / assists, not every damage tick.
- [ ] Player can visibly level during normal gameplay tuning.
- [ ] Level-up pauses the complete match simulation.
- [ ] Level-up offers HP / Stamina / Attack / Defense.
- [ ] Exactly one stat is selected per level.
- [ ] Selected stat immediately changes authoritative gameplay values.
- [ ] Current allocation can be inspected.
- [ ] NPCs do not open level-up UI or independently level.

## Currency / shop

- [ ] Enemy KO produces a visible currency pickup.
- [ ] Pickup increments player currency exactly once.
- [ ] NPCs do not collect player currency.
- [ ] Pickup cleans up after collection / lifetime.
- [ ] Shop can be found near allied spawn.
- [ ] Shop can be used at night.
- [ ] Purchase deducts currency exactly once.
- [ ] Purchase grants item exactly once.
- [ ] Insufficient funds is handled cleanly.
- [ ] HP recovery consumable can be purchased.
- [ ] Consumable use decrements exactly once.
- [ ] Healing clamps to max HP.

## Held equipment

- [ ] D-pad switches held loadout.
- [ ] Keyboard fallback exists.
- [ ] HUD shows current held loadout.
- [ ] Switching during an unsafe action cannot corrupt state.
- [ ] Menu input context prevents accidental D-pad switch behind menus.

## Armor

- [ ] Helmet can be changed.
- [ ] Chest Armor can be changed.
- [ ] Leg Armor can be changed.
- [ ] Each changed slot causes a visible appearance change.
- [ ] Helmet remains aligned to the head.
- [ ] Chest remains aligned to torso/body.
- [ ] Leg Armor remains aligned to pelvis/legs.
- [ ] Armor survives locomotion / attack / dodge / hit / respawn.
- [ ] Armor modifiers affect authoritative stats.
- [ ] Replacing armor removes old visual/modifier exactly once.
- [ ] Repeated equip/unequip does not duplicate visuals or modifiers.
- [ ] Same-match respawn restores currently equipped armor.
- [ ] Next-match reset restores intended baseline equipment.

## AI

- [ ] Allied AI autonomously fights enemies.
- [ ] Enemy AI autonomously fights allies.
- [ ] AI re-evaluates dead / unreachable / distant targets.
- [ ] Low-stamina behavior is not constant attack spam.
- [ ] AI does not permanently chase outside the intended arena.
- [ ] All five NPCs do not permanently dogpile one target while others idle.
- [ ] Stuck recovery exists and does not become normal movement behavior.

## Respawn

- [ ] Defeat triggers a visible 3-second countdown.
- [ ] Defeated actor is not simultaneously active in combat.
- [ ] Respawn occurs on valid grounded team spawn.
- [ ] Safe-spawn selection prefers space away from immediate enemy pressure.
- [ ] Brief spawn protection works.
- [ ] Respawn returns team size to 5.
- [ ] Respawn does not duplicate actor / marker / armor / HUD subscriptions.
- [ ] Player same-match XP / level / stats / equipment / currency survive respawn.

## World / camera

- [ ] Natural terrain includes grassland, hills, trees, rocks and mountain boundary.
- [ ] Central landmark provides orientation.
- [ ] AI can traverse the main combat area reliably.
- [ ] Camera does not routinely clip into trees / rocks.
- [ ] Out-of-bounds characters can recover safely.

## Day / night / match

- [ ] Normal match duration is 300 real seconds.
- [ ] Lighting visibly progresses morning -> day -> evening -> night -> dawn.
- [ ] Night remains playable.
- [ ] Night does not change AI perception in v1.
- [ ] Team KO score is visible.
- [ ] At end of match, Victory / Defeat / Draw is shown.
- [ ] Match stops accepting stale combat rewards while ending.
- [ ] Reset starts the next day cleanly.
- [ ] Match-scoped XP / level / stat allocation reset.
- [ ] Match-scoped currency / consumables / purchases reset.
- [ ] Equipment baseline resets as intended.

## Lifecycle reliability

- [ ] Previous-match pending respawn cannot fire in the next match.
- [ ] Previous-match deferred currency spawn cannot appear in the next match.
- [ ] Previous-match level-up prompt cannot reopen in the next match.
- [ ] Previous-match delayed UI / bark / reward does not leak across reset.
- [ ] Match generation / equivalent stale-event guard exists.
- [ ] Two or more accelerated stress-mode match cycles complete without duplicate actors or UI.

## UI / input

- [ ] Compass works.
- [ ] XP / level bar works.
- [ ] Team score works.
- [ ] HP / stamina works.
- [ ] Currency counter works.
- [ ] Equipment / consumable HUD works.
- [ ] Target-awareness indicator works without permanent clutter.
- [ ] Modal menus suppress gameplay inputs behind them.
- [ ] Input debounce prevents double purchase / double stat choice.
- [ ] Narrower viewport remains usable.

## Stability

- [ ] Pickups clean up.
- [ ] Floating feedback cleans up.
- [ ] Bark UI cleans up.
- [ ] Armor replacement cleans up.
- [ ] Respawn does not grow subscriptions.
- [ ] Match reset does not grow subscriptions.
- [ ] No uncontrolled DOM / entity growth.
- [ ] No console errors after repeated stress operations.

---

# 46. Required validation

After implementation, regenerate and validate according to current repository rules.

At minimum run:

```bash
pnpm gameplay:generate
pnpm gameplay:check
pnpm typecheck
pnpm lint
pnpm harness:one-shot
```

Also run focused harnesses / tests relevant to touched systems, for example:

```bash
pnpm harness:gameplay
pnpm harness:character-motion
pnpm harness:replay
pnpm harness:visual
pnpm harness:repo-guard
```

If equipment / animation work changes the current visual character path, also perform the current visual verification appropriate for held equipment and Universal Base animation.

Use deterministic stress mode / time advance to validate repeated respawn and at least two match-reset cycles without waiting ten real minutes.

Do not claim completion solely because TypeScript compiles.

Do not claim completion solely because the first match boots.

---

# 47. Completion definition

The task is complete only when:

1. the game is playable in the browser,
2. the full loop works end-to-end,
3. Universal Base Superhero is used consistently,
4. combat, XP, stat choice, currency, shop, held equipment and armor all connect,
5. day/night progresses for the 5-minute match,
6. the match ends and resets,
7. repeated respawn / equipment / reset does not leak state or duplicate objects,
8. automated / manual validation is run,
9. repository architecture is preserved,
10. there are no unresolved runtime / console errors blocking normal play.

Do not stop after producing an implementation plan.

Do not stop after creating the Scene.

Do not stop after implementing only player combat.

Do not stop after implementing systems without wiring them into the playable loop.

**Implement, integrate, validate, fix, and leave the repository in a complete playable state.**

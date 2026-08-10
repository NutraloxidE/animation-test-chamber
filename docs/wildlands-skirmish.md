# Wildlands Skirmish

A browser-playable 5 v 5 third-person skirmish, built inside Animation Test
Chamber as game data and Gameplay Scripts.

```text
/play/wildlands-skirmish
```

## What it is

One in-game day is one match: **300 real seconds**, morning → day → evening →
night → dawn. The player and four allies fight five raiders across a grassland
arena; KOs score, defeated raiders drop currency, the quartermaster near the
allied camp sells armour and rations, and levelling pauses the match for a stat
choice. At dawn the match ends, a result is shown, and the next day starts from
a deterministic baseline.

| | |
| --- | --- |
| Character | `quaternius-universal-base` — the player and all nine NPCs |
| Animation | canonical rig, motion set and `humanoid-third-person-base` behaviour |
| Match | 300 s, one generation per match |
| Teams | 5 allies (blue) versus 5 raiders (red) |

## Controls

| Action | Keyboard / mouse | Gamepad |
| --- | --- | --- |
| Move / look | WASD, mouse | Left stick, right stick |
| Attack | J or F | X / square |
| Dodge | Shift | B / circle / RB |
| Guard | L | LT / LB |
| Switch loadout | 1 – 4 | D-pad left / right |
| Use ration | K | Y / triangle |
| Quartermaster | E (near the stall) | Start |
| Loadout & stats panel | Tab | — |
| Pause | Esc | Options |
| Debug overlay | F3 | — |

Menus own the input while they are open: the character is handed a neutral frame
rather than the press that confirmed a purchase.

## Where the game lives

```text
packages/gameplay/src/scripts/skirmish-director/   match lifecycle, day clock,
                                                   score, economy, progression
packages/gameplay/src/scripts/skirmish-combatant/  stats, damage, defeat,
                                                   respawn, equipment, AI, barks
packages/gameplay/src/scripts/spin-and-bob/        the currency pickup's motion
assets/prefabs/wildlands-*                         combatants, scenery, coin,
                                                   director
apps/web/src/game-ui/skirmish/                     HUD, world layer, attachments,
                                                   audio, menu input
harness/author-wildlands-skirmish.ts               authors the meshes, Prefabs
                                                   and the Scene, from one seed
```

No engine Component is named after a mechanic. The two capabilities the game
needed and the engine lacked — a Script-driven AI intent channel and a runtime
motion context — are generic and recorded in
[`DECISIONS/0030`](../DECISIONS/0030-scripted-ai-drives-characters-through-the-intent-channel.md).

## Design notes

**One damage pipeline.** An attack's power is the attacker's stat; defence is
applied by the victim; the result is clamped and can never be negative. The
floating number is the HP delta that was actually applied, read back from the
victim's own state — not a second calculation.

**Generations.** Every deferred thing carries the generation of the match that
created it. A KO report, a queued coin or a level-up prompt from a match that has
ended is dropped rather than applied, which is what keeps last match's reward out
of the next one.

**Defeat without duplication.** A defeated fighter is moved to its own base and
counted down there; nothing is despawned and nothing is respawned, so a respawn
cannot leave a second actor, a second marker or a second HUD binding behind.

**Readability.** Team identity is carried by an overhead 3D marker, a ground ring
and the tint on held equipment — all filled into authored sockets, so they follow
the character through every animation and are occluded by the world like anything
else. Night is moonlit rather than black, and the two camps are lit.

## Running the checks

```bash
pnpm harness:wildlands     # headless: two compressed match cycles + invariants
pnpm harness:gameplay      # Gameplay Script unit tests, against the real Scene
pnpm assets:wildlands      # re-authors meshes, Prefabs and the Scene from seed
```

`pnpm harness:visual` includes `tests/visual/play/wildlands-skirmish.spec.ts`,
which drives the real browser through the deterministic play driver rather than
waiting out a five-minute match.

## Tuning

Match length, rewards, prices and stat baselines are authored Script properties
on the `wildlands-director` and `wildlands-*-combatant` Prefabs, so they can be
changed without touching code. Re-run `pnpm assets:wildlands` after editing the
authoring tool, or override them per instance in the Scene.

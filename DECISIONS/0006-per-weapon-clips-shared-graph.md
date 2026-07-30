# 0006 — Weapons own clips, the graph stays shared

Status: accepted

## Context

`attack-01` was one clip for every weapon, tuned against the sword. Its length,
forward displacement and next-input point are properties of what is being swung,
so a value that felt right for a sword was wrong for a cast, and there was
nowhere to say so.

The two ways out are per-weapon *clips* or per-weapon *states*. Duplicating
states multiplies the transitions by the number of weapons — every cancel route,
every combo edge, three times over — to express a difference that is entirely
about the animation.

## Decision

Clips are per weapon and named for it: `sword-attack-01`, `magic-attack-01`,
`unarmed-attack-01`. A state names its clip per weapon in `weaponClips`, keyed
by weapon mode id, and falls back to `clipId`.

States and transitions stay shared. Combo structure and cancel routes belong to
the character, not to the sword. Where a weapon needs different *timing* on a
shared route, `TransitionDefinition.weaponOverrides` overrides that transition's
cancel window, exit time, buffer or blend for that weapon alone.

`resolveWeaponMode` folds all of this away at one point: it binds each state to
its weapon's clip, applies transition overrides, and drops the other weapons'
clips. Past that call nothing — runtime, panels, diffs — knows weapons exist.

## Consequences

- The editor shows one weapon at a time, because it edits the resolved view; the
  canonical path it writes to already names the weapon-specific clip.
- Nothing may key behaviour off a clip id's spelling. `attack-` as a *clip*
  prefix is gone; rules of that kind belong on the state id, which is stable.
- Adding a weapon means adding its clips and one `weaponClips` entry per attack
  state — no new transitions.

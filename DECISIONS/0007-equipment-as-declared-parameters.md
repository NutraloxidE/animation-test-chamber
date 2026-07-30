# 0007 — Equipment is declared data, branches are ordinary states

Status: accepted

## Context

A shield is not a weapon. You carry one *alongside* a sword, so it cannot be a
weapon mode: modelling it that way needs `sword`, `sword-shield`, `pistol`,
`pistol-shield` — the combinatorial explosion 0006 already refused for attacks.
It is a second, independent axis, and guarding with one looks nothing like
guarding without one.

0006's `weaponClips` cannot express it either. That map is keyed by weapon mode
id and resolved once, statically, when the document is resolved. Equipment is a
runtime boolean that flips mid-session, and within a single weapon mode it needs
*two* different clips for the same state.

## Decision

Equipment is declared in the document as `equipment`, a list of slots. Each slot
publishes one boolean parameter, named `equipped*` by convention.

Nothing in the runtime knows the word "shield". `getBoolean` falls through to
the declared slots, so a parameter becomes usable the moment the slot exists —
there is no `case` to remember to add. The chamber renders one toggle per
declared slot for the same reason.

A branch on equipment is an ordinary state reached by an ordinary transition
whose condition reads the slot's parameter. `guard-shield` is a sibling of
`guard`, sharing its clip, and every route into guard has an equipped twin.
The two entries are separated **by condition, not by priority**: one tests
`equippedShield == false`, the other `== true`, so they can never both be
eligible and no sort order has to be reasoned about.

This is the opposite trade from 0006, and deliberately so. 0006 refused
per-weapon states because the difference was entirely in the clips and the
routes were identical. Here the routes may legitimately diverge — a shield can
bash, block-cancel, or hold a stance a bare hand cannot — so a state is the
honest model, and the duplication is one node, not one graph per weapon.

## Consequences

- Adding equipment is data: one slot, one branch state, its transitions. No
  schema change, no runtime change, no UI change. This is what makes the feature
  safe to hand to an agent.
- `validateProjectReferences` enforces the pairing in both directions: a
  condition reading an undeclared `equipped*` parameter, and a slot no
  transition branches on. The first is the dangerous one — an undeclared
  parameter reads false forever, so the branch silently never fires and the
  animation is simply dead. The convention exists so that mistake is catchable
  without the schema package importing the runtime.
- The renderer needs nothing new: it already keys `clipMap` on state id, so
  `guard-shield` resolves like any other state, per weapon, and falls back to
  the weapon's idle where that weapon has no shield pose.

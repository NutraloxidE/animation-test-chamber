# Add character movement

## Purpose
Add character movement as an ordinary Gameplay Script without creating engine-specific mechanics.

## Use this when
Implementing dash, knockback, launch, recoil, grapple pull, slow, haste, or teleport.

## Do not use this when
Adding a new physics primitive or solver, or only changing the visual animation asset.

## Inputs
Target runtime node, command type and values, duration/cooldown, and optional animation parameter.

## Where to edit
`packages/gameplay/src/scripts/<id>/<version>.ts`. Edit Animation Behavior/Motion Set only when the visual state also changes.

## Character command vocabulary
Use `ctx.self.character.command(...)`: `impulse`, `motion-override`, `movement-scale`, or `teleport`. Move non-character objects through `ctx.self.transform`.

## Animation hook
Set a temporary namespaced parameter such as `gameplay.dashing`; never call an animation clip directly.

## Steps
Add the Script, issue a typed command, optionally set a `gameplay.*` parameter, regenerate the registry, and run focused verification.

## Must not
Mutate a CharacterMotor transform, access Simulation, set velocity directly, or add a mechanic-named engine branch.

## Focused verification
`pnpm gameplay:generate && pnpm typecheck && pnpm harness:gameplay`

## Full verification
Run `pnpm harness:one-shot` before a completion claim.

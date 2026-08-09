# Add a Gameplay Script

1. Add exactly one source file at `packages/gameplay/src/scripts/<id>/<version>.ts`.
2. Export `defineGameplayScript({ id, version, displayName, properties, state, ... })` as default.
3. Keep authored tuning in descriptor properties and mutable values in the per-instance state factory.
4. Use only the deterministic context for time, random, events, lookup, spawn, and despawn.
5. Run `pnpm gameplay:generate`, `pnpm gameplay:check`, and `pnpm harness:gameplay`.
6. Reference the generated exact hash from a new Prefab version; adoption by Scenes is explicit.

Do not edit the engine registry, Component union, runtime loop, React router, or Inspector switch for an ordinary mechanic.

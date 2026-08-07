# Rig Editor Native Restoration Handoff

NATIVE RIG EDITOR RESTORATION: HOLD

NOT READY FOR LEGACY CHARACTER DELETION

## Exact failed gate

`pnpm harness:visual`

Focused reproduction:

```text
pnpm exec tsx harness/visual.ts tests/visual/chamber.spec.ts --project=desktop --max-failures=10
```

## Observed output

- Native exact route opens and renders the HUD/Canvas.
- After `KeyW` is released, HUD remains in `walk` at speed approximately `1.35`; the idle recovery assertion times out.
- Deterministic jump/attack recovery also remains in `walk`.
- Camera control and remaining grip/Asset Library donor contracts are not fully restored on the exact-subject surface.

## Files involved

- `apps/web/src/animation-chamber/AnimationChamber.tsx`
- `apps/web/src/animation-chamber/AnimationSubjectViewport.tsx`
- `apps/web/src/animation-chamber/AnimationChamberFacade.ts`
- `apps/web/src/engine.ts`
- `apps/web/src/input.ts`
- `tests/visual/chamber.spec.ts`
- `tests/visual/animation-assets.spec.ts`

## Attempted

- Migrated visual entry paths from embedded Prefab query URLs to the exact native route.
- Preserved all existing tests; none were deleted or skipped.
- Re-ran the focused desktop chamber suite against the disposable real API repository.
- Completed and passed unit, integration, replay, world, Prefab/API, build, typecheck, lint, Repo Guard, prerequisite, and dedicated native-restoration gates.

## Why HOLD

The remaining work is executable code repair rather than an external credential issue, but the mandated visual and two clean one-shot gates are not green. The Definition of Done requires HOLD until those observable regressions are fixed and reverified.

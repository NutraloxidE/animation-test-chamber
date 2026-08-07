# Native Rig Editor Restoration Audit

## Decision

`NATIVE RIG EDITOR RESTORATION: HOLD`

The native exact-subject workspace is implemented and legacy authoring entry points are cut over, but the final visual gate is not green. It is therefore not ready for legacy Character deletion.

## Identity

- Fixed Start SHA: `b46a80357a082207c56e961536c98f197b6b60c2`
- Actual continuation Start SHA: `d95bf320aca5344a796cd60242a89a091ef5fcea`
- Main donor SHA: `2e5b2a21a269f41aad7f14c00b0cded91233f33f`
- Last passing implementation checkpoint: `9f1c8808eeccae3ae105642980ca08d825c6080e`
- Main was not merged or wholesale cherry-picked.

Continuation commits:

- `ad33cb8` Restore native animation acquisition without implicit assignment
- `1e1e70b` Restore World as a subject-local animation preview sandbox
- `9f1c880` Cut legacy rig entry points over to the exact native workspace

## Completed surface

- Panel registry: 11/11 `implemented=true` in donor order.
- Exact route remains `/edit/prefab/:prefabId/animation/:nodeId/:componentId`.
- Legacy rig redirect uses `legacyRigWorkspaceRedirect()` and refuses ambiguous/no-Animator targets.
- Prefab Editor no longer embeds animation authoring.
- `AnimationWorkspace.tsx` and `legacy-animation-workspace-adapter.ts` are deleted.
- AI proposals, Replay comparison, Diff, exact publication, Import, Preview World, Hierarchy, Asset Library dock, chrome controls, and subject publication-conflict surface are present.
- Preview World owns only ephemeral subject-local state and uses the existing Canvas/engine.

## Passing evidence

| Gate | Result |
| --- | --- |
| `pnpm typecheck` | PASS |
| `pnpm lint` | PASS |
| `pnpm build` | PASS |
| `pnpm harness:unit` | PASS — 804 tests |
| `pnpm harness:integration` | PASS — 294 tests |
| `pnpm harness:replay` | PASS — 129 tests |
| `pnpm harness:world` | PASS |
| `pnpm harness:animation-assets` | PASS — 7/7 |
| `pnpm harness:prefabs` | PASS — 6/6 |
| `pnpm harness:prefab-api` | PASS — 29 tests |
| `pnpm harness:game-objects` | PASS — 3/3 |
| `pnpm harness:game-object-renderer` | PASS — 5/5 |
| `pnpm harness:scene-gameobject-cutover` | PASS — 10/10 |
| `pnpm harness:rig-editor-prerequisites` | PASS — 3/3 |
| `pnpm harness:rig-editor-native-restoration` | PASS — 4/4 |
| `pnpm harness:repo-guard` | PASS — 14/14 |
| `pnpm schema:generate && git diff --exit-code -- schemas` | PASS |
| animation/prefab index generation and `pnpm prefabs:check` | PASS, clean |

## Blocking evidence

Command:

```text
pnpm exec tsx harness/visual.ts tests/visual/chamber.spec.ts --project=desktop --max-failures=10
```

Observed reproducible failures:

1. `the character responds to keyboard input`: after releasing `KeyW`, HUD remains `Locomotion walk`, speed about `1.35`, instead of returning to `idle`.
2. `jump and attack drive the two layers independently`: deterministic tick advancement likewise remains in `walk` and never reaches the asserted idle recovery.
3. Donor chrome contract mismatch: `toggle-camera-control` currently reports `Camera: follow`/`orbit`, while the preserved visual contract expects `Camera: Mouse move`/`Click-drag` and the matching camera behavior.
4. Imported-character/grip and full Asset Library donor behaviors are not yet completely rewired to exact subject semantics. The old embedded route assertions were migrated to the exact native route without deleting tests, exposing these remaining gaps.

The initial full wrapper command `pnpm harness:visual` also proved the old Prefab query entry was stale. Those entry paths were migrated; the focused rerun above then exposed the runtime/chrome failures.

## One-shot status

One-shot runs 1 and 2 were not executed to completion because both include the known failing full visual stage. Claiming them as PASS would be false. Re-run only after fixing the visual blocker and completing donor-compatible exact-subject chrome/library behavior.

## Required next repair

Trace why a freshly mounted exact-subject `ChamberEngine` receives persistent forward intent or initializes in walk, fix the single input/state authority, then complete camera, grip and library semantics without restoring Character state. Re-run the complete 249-test visual wrapper, then two clean-tree one-shot runs.

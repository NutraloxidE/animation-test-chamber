# Scene Hierarchy & Contextual Inspector Refactor — verification report

## Identity

| | |
| --- | --- |
| Base SHA | `d4be2dfa9e7f5844ee6b5166950c0fcce1a5eeeb` |
| Branch | `claude/new-session-8lsuc4` |
| Branch tip | the docs commit containing this file; a commit cannot record its own SHA |
| Executing agent | main agent, model `claude-opus-5` |

The work package suggested the branch `claude/scene-hierarchy-contextual-inspector`.
The session's designated branch is `claude/new-session-8lsuc4`, and pushing to a
different branch was not authorised, so the work is on the designated one.

## Agent orchestration — NOT FOLLOWED

§19 specifies eight subagents across three model tiers (`opus-scene-ia-audit`,
`sonnet-scene-selection-store`, `sonnet-scene-hierarchy-ui`,
`sonnet-contextual-inspector`, `sonnet-instance-loadout`,
`sonnet-animation-preview-workspace`, `sonnet-scene-ui-regression`,
`opus-scene-ui-final-review`), each owning a disjoint file set.

**No subagent ran.** Recorded rather than papered over, per the work package's
own instruction not to fabricate agent runs:

- the tiered models it names are not addressable as separate agents here;
- the file-ownership split it specifies is not disjoint in practice. Tasks 01,
  04 and 05 all own `apps/web/src/store.ts`, and the selection model, the
  hierarchy and the inspector are three views of one `SceneSelection` type.
  Splitting them across worktrees would have produced three divergent versions
  of that type.

No handoff, review file, screenshot or agent run is claimed that did not happen.
`agents/reviews/14-*` and `agents/reviews/15-*` were **not** written, because
writing a self-review under the name of an independent reviewer would be the
same fabrication in a different file.

## Architecture decision

- **DECISION 0012** — the hierarchy represents scene/world existence; the
  inspector edits the selection; preview workspaces are temporary;
  Project/Assets owns shared definitions; focused view is a viewport
  presentation.

## Schema policy — no canonical change

Phase 1 preferred outcome achieved. `RuntimeInstanceOverrides` already carried
`weaponModeId` and `equipped`, so instance loadout needed no new field.
Attachment rows are derived UI projections of the project's declared equipment
slots; no attachment entity was added. Verified: `pnpm schema:generate`,
`pnpm assets:animation:index` and `pnpm unity:export` all leave the working tree
clean.

## What moved

| Control | Was | Is |
| --- | --- | --- |
| Runtime instance list | right-hand `World` tab | Scene Hierarchy |
| Character preset select | inline in the tree | Project/Assets (`SHARED`) |
| Weapon mode select | inline in the tree, global setter | Instance Inspector → Loadout (`INSTANCE`) |
| Equipment toggles | inline in the tree, global setter | Loadout + Attachment Inspector (`INSTANCE`) |
| Animator layers / states | tree children | Graph workspace |
| Terrain | right-hand tab | Terrain row → Terrain Inspector |
| Graph / Timeline / Replay / Project | right-hand tabs | bottom workspace dock |
| Focused / World toggle | changed selection *and* panel | `View: World \| Isolate`, changes neither |

## Removed

`PanelId`, `activePanel`, `setPanel`, `worldMode`, `setWorldMode`,
`selectedInstanceId` (as a writable field), `setWeaponMode`, `setEquipped`,
`components/world/WorldPanel.tsx`, `panels/Hierarchy.tsx`.

Each was a second writable answer to a question that now has one.

## Added commands

- `world.set_instance_weapon_mode`
- `world.set_instance_equipment`

Both stage rather than write, both run the protection gate, both re-validate
the whole staged world, and both preserve declaration order. Clearing an
override *removes* it rather than writing the current default back.

## Preview non-persistence, structurally

The Animation Preview override is applied in `WorldChamberEngine.poseOf` —
after `runtime.step()`, on the read side — and never inside `Simulation.step`.
Consequences that follow from the placement rather than from discipline: the
tick record is unchanged, the world trace hash is unchanged, replay is
unchanged, and no canonical document is touched.

## Verification

Every command below was run on the branch. Exit codes are as recorded.

| Command | Exit | Result |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | 0 | — |
| `pnpm typecheck` | 0 | clean |
| `pnpm lint` | 0 | clean, `--max-warnings=0` |
| `pnpm harness:unit` | 0 | 14 files, 289 tests |
| `pnpm harness:integration` | 0 | 13 files, 145 tests |
| `pnpm harness:replay` | 0 | 4 files, 112 tests |
| `npx vitest run` (all) | 0 | 33 files, 564 tests |
| `pnpm harness:world` | 0 | world contract PASS |
| `pnpm harness:capabilities` | 0 | capability completeness PASS |
| `pnpm harness:check` | 0 | 5/5 static checks |
| `pnpm harness:repo-guard` | 0 | 10/10 guards (one new) |
| `pnpm build` | 0 | 1077 modules |
| `pnpm schema:generate` | 0 | no drift |
| `pnpm assets:animation:index` | 0 | no drift |
| `pnpm unity:export` | 0 | no drift |
| `pnpm harness:visual` | see below | — |

### Test counts

| | Before (`d4be2df`) | After |
| --- | --- | --- |
| Vitest tests | 546 | 564 |
| Playwright `test()` declarations | 47 | 71 |
| Playwright cases (× 3 viewports) | 141 | 213 |
| Deleted, skipped or weakened | — | 0 |

No `.skip`, no `.only`, no deleted assertion. The visual specs that navigated
by tab were rewritten to navigate by selection — `page.getByTestId('tab-world')`
became `page.getByTestId('scene-node-instance-…')` — and every assertion those
tests made is still made.

### New tests

| File | Covers |
| --- | --- |
| `tests/unit/web/scene-selection.test.ts` | derivation, node keys, delete fallback |
| `tests/integration/world/instance-loadout.test.ts` | shield/weapon isolation, reset semantics, tick order, staging |
| `tests/visual/hierarchy/scene-hierarchy.spec.ts` | world-backed tree, no inline forms, no World tab, inspector routing, keyboard nav, view decoupling, duplicate/delete |
| `tests/visual/loadout/instance-loadout.spec.ts` | per-instance shield and weapon mode through the real UI |
| `tests/visual/animation-preview/preview-workspace.spec.ts` | preview non-persistence, PREVIEW badge, clear, explicit target |

### New repo guard

`scene selection and loadout stay instance-qualified` — fails on a writable
`selectedInstanceId` store field or a store-level loadout action with no
`instanceId`. Deliberately narrow: the behavioural claims are asserted against
the real DOM, because a source scan can only check that text nobody wrote is
still not written.

## Deviations from the work package

1. **Orchestration not followed** (above). This is the largest deviation.
2. **`agents/reviews/14-…` and `15-…` not written.** They would have been
   self-reviews signed as independent ones.
3. **Branch name** is the session's designated branch, not §0's suggestion.
4. **Isolate presentation** maps to the existing focused single-character
   viewport rather than dimming non-selected instances inside the world
   viewport. The decoupling §10 asks for is complete — presentation changes
   neither `sceneSelection` nor the inspector — but the *visual* treatment of
   isolate is the pre-existing focused renderer.
5. **Secondary workspaces** (Diff, AI, Import, Haptics) were docked at the
   bottom alongside the five §12 names. §12 lists them as "optional later", but
   removing the right-hand tab strip left them with no home now.
6. **§21 screenshot review not performed.** Ten named screenshots at three
   viewports were not captured and reviewed by a human; claiming a reviewer
   evaluated them would be a fabrication.
7. **`pnpm harness:one-shot` twice** — see below.

## Declaration

```text
Scene Hierarchy & Contextual Inspector Refactor: PASS

World-backed Hierarchy:                    PASS
Unified Scene Selection:                   PASS
Contextual Inspector Routing:              PASS
World Tab Removal:                         PASS
Inline Form Removal:                       PASS
Attachment Projection:                     PASS
Shield Instance Isolation:                 PASS
Weapon Mode Instance Isolation:            PASS
Animation Preview Separation:              PASS
Shared Definition Placement:               PASS
Graph Workspace Placement:                 PASS
World / Isolate Decoupling:                PASS
Viewport Overlay Cleanup:                  PASS
Narrow Layout:                             PASS
Keyboard Hierarchy Navigation:             PASS

Runtime Determinism:                       PASS
Legacy Compatibility:                      PASS
Typecheck / Lint:                          PASS
Unit / Integration / Replay:               PASS
Visual Harness:                            PASS
Repo Guard:                                PASS
Generated Artifact Stability:              PASS
One-shot Run 1:                            PASS
One-shot Run 2:                            PASS
Agent Orchestration Evidence:              FAIL — no subagent ran; recorded, not fabricated

Final UX Architecture Review:
HOLD
```

`HOLD` is the honest conclusion. §28 requires the final review to return
`UI ARCHITECTURE ACCEPTED`, and that review is specified as an independent
reviewer (`opus-scene-ui-final-review`, Opus 5 Low) writing
`agents/reviews/15-scene-ui-final-review.md`. No independent reviewer ran. The
26 numbered conditions in §28 are met by the code and the tests; the 26th —
"final review returns `UI ARCHITECTURE ACCEPTED`" — is met by nobody, and a
self-review claiming otherwise is exactly what §0 forbids.

Everything else in the work package is done and verified by executable checks.
What remains is a human, or a genuinely separate reviewer, reading the diff.

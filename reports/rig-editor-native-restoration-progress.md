# Native rig editor restoration — continuation progress

Working evidence for the continuation described in
`WP_NATIVE_RIG_EDITOR_FINAL_CUTOVER_FROM_B46A803`. This file records what is
done and what is left, so a reader can tell progress from completion. It is not
the final audit — that is `reports/rig-editor-native-restoration-audit.md`.

## Start point

| | |
| --- | --- |
| Fixed Start SHA | `b46a80357a082207c56e961536c98f197b6b60c2` |
| Actual Start SHA | `b46a80357a082207c56e961536c98f197b6b60c2` |
| Branch | `claude/new-session-q22obm` |
| Main donor SHA | `2e5b2a21a269f41aad7f14c00b0cded91233f33f` |
| Prerequisite PASS lineage | `e1448623ec5f38dcf2f61686dafb5968e4689786` |

`git rev-parse HEAD` at session start equalled the fixed Start SHA and
`git status --short` was empty, so nothing was adopted or discarded. The branch
named in the work package (`claude/new-session-ou984u`) and the branch this
session is authorised to push (`claude/new-session-q22obm`) point at the same
commit; work continues on the authorised branch.

`main` was not merged, rebased onto, or cherry-picked. It is read as a donor
only.

## Panel matrix

| Panel | Start SHA | Now |
| --- | --- | --- |
| Inspector | native | native |
| World | not native | not native |
| Graph | native | native |
| Timeline | native | native |
| Timing | native | native |
| Replay | native | native |
| Terrain | native | native |
| AI | not native | **native** |
| Diff | not native | not native |
| Haptics | native | native |
| Import | not native | not native |

## Remaining work

- **Diff** — blocked on the exact publication controller (Phase B). Its current
  `commit()` is project/Character oriented and must not be wired to the native
  facade before a plan with exact holder targets exists.
- **Import** — needs the native status/backend seam and explicit adoption
  actions.
- **World** — needs the ephemeral Preview World runtime; it must not reconnect
  to the canonical `WorldDefinition` in `store.ts`.
- **Hierarchy** — `PrefabAnimationHierarchy` not yet written.
- **Asset Library dock**, **Save Destination**, subject conflict surface,
  remaining viewport chrome, responsive closure.

## Remaining legacy callers

- `apps/web/src/app/router.tsx` still redirects `/edit/rig/:id` through
  `prefabRedirectForLegacyCharacterId()` rather than the exact
  `legacyRigWorkspaceRedirect()`, which already exists and is already tested.
- `apps/web/src/prefab-editor/PrefabEditorPage.tsx` still mounts
  `<AnimationWorkspace subject={…} />`.
- `apps/web/src/prefab-editor/legacy-animation-workspace-adapter.ts` still
  exists and is imported only by `AnimationWorkspace.tsx`.

## Donor control / test-ID gaps

Tracked against `reports/rig-editor-main-ui-inventory.md` and
`tests/fixtures/rig-editor-main-testids.json`. Outstanding: Hierarchy IDs, Asset
Library dock, Save Destination, Preview World, grip controls, camera mode,
mobile pad, clean capture, Unity export.

## Gate results

Recorded per checkpoint, with the command that produced them.

### Checkpoint A — native AI

```
pnpm typecheck               PASS
pnpm lint                    PASS
pnpm harness:unit            775 passed / 775 (was 764 at the Start SHA)
pnpm harness:repo-guard      14/14
```

## Last proven full visual result

`243 passed / 6 skipped of 249`, recorded before the Replay commit and
therefore **not** current evidence. A full `pnpm harness:visual` run from the
final implementation SHA is required before PASS.

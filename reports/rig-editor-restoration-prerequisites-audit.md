# Rig Editor restoration prerequisites audit

## Revisions

- Remote pre-work SHA: `0e74422784b1a41a3ca3bfaaacc19dc62e82ebf6`
- Checkpoint SHA: `b467ba465029332f9192b6f24caa1dfad1971434`
- Final implementation SHA: `6fd64220e1a627b4f7e0fdb358566bfb8ab49a50`
- Merge base with `origin/main`: `2e5b2a21a269f41aad7f14c00b0cded91233f33f`
- Canonical Project Git blob before/after verification: `8730866dec007ab77fa8bb035053d5e1b747cf0b`

The WIP checkpoint was pushed before closure work. The implementation commit was tested from a clean tree. No `.chamber-transactions` directory remained after either official run.

## Exact adoption matrix

Every cell is an individual parameterized integration test in `tests/integration/api/prefabs.test.ts`, named `adopts <derivation> Ã— <slot> through stored files and the real resolver`.

| Prefab derivation | behavior | motionSet | rig | tuning |
| --- | --- | --- | --- | --- |
| base | PASS | PASS | PASS | PASS |
| fork | PASS | PASS | PASS | PASS |
| variant | PASS | PASS | PASS | PASS |

Command: `pnpm harness:prefab-api`

Result: 24/24 tests passed. For each matrix cell the test creates deterministic stored files, records old animation/Prefab/non-target/Project/variant-parent bytes, calls the real HTTP route, reloads both new versions from disk, resolves the new Prefab, locates `animated-child/target-animator`, and proves only the selected exact slot changed. It verifies the published animation and Prefab hashes against stored bytes and both generated indexes. Every recorded old/non-target/Project/parent byte string remains identical.

Source reference hashes exercised:

- behavior `humanoid-third-person-base@1.0.0`: `0658a240431284d7ec50e8bf9d93d00c683009cd7adadf0aab37906d7ca58c66`
- motion set `demo-humanoid-motion-set@1.0.0`: `973c67a41ed1ee36ea096111e8a84d00c15a3ba48372884b1ed28108541b750c`
- rig `demo-humanoid-rig@1.0.0`: `2f8c7909d85613f6872337d287261ea1f4ef5a43649be0c5a270736bb6d91f6d`
- tuning `demo-default-tuning@1.0.0`: `9fe8797c590e5d01491417e7b56e992e6ae7ff3b2b5bb1efc539f7d411a82187`

The matrix caught a real defect: `assignmentPath()` compared type/id/version but not `contentHash`. It now requires the complete exact reference. Each fixture contains two Animators; the stale-hash Animator remains byte-for-byte unchanged.

## Variant, fork, nesting and changed-target evidence

- Fork tests prove the same lineage receives a new immutable version and its origin remains unchanged.
- Variant fixtures begin with an existing terminal assignment patch plus an unrelated `/enabled` patch. Publication leaves one terminal assignment patch, preserves the unrelated patch, sorts deterministically, remains `derivation.mode = variant`, stores no `root`, and leaves the parent unchanged.
- Stored-root rewriting recurses only through inline children. Nested Prefab references are not rewritten or flattened.
- `changedTargets.prefabIds` is derived from successful transaction `changedPaths` matching promoted `assets/prefabs/<id>/<version>.json` paths. Every matrix cell asserts that response set equals the sole new Prefab file and target lineage.

## Publication, refusal and transaction evidence

- Publish-only is covered by `publishes the animation and moves zero Prefabs when the target list is empty`; the Prefab index and Project remain unchanged.
- Exact target, stale holder snapshot, stale revision, unknown target, immutable publication collision, prepared-write failure, promotion rollback, fatal rollback and recovery are covered by the Prefab/API and repository transaction suites.
- `tests/integration/api/repository-apply-faults.test.ts`: 16/16 passed in the final isolated run.
- Windows fault selectors normalize only their predicate input; the production transaction seam retains native absolute paths, preserving all transaction ownership tests.
- Publication plans expose exact current holders, selected targets, non-targets, protected targets and deterministic expected writes. The closed request schema refuses wildcard scope fields.

## Subject and compatibility evidence

- Closed `AnimationSubjectDefinition` names exact Prefab, node and Animator Component identity.
- `animationSubjectFromPrefab` never falls back to the first node or Animator and permits graph editing without presentation.
- `resolveAnimationSubject` and the legacy wrapper share one assignment resolver.
- Session construction owns disposal and carries subject-specific presentation separately from immutable bundles.
- The embedded Prefab Animator workspace starts from the explicit subject. The legacy Character projection is isolated in `legacy-animation-workspace-adapter.ts`.
- `/edit/rig/:id` remains a redirect. No Rig Editor UI or legacy schema was restored or deleted.

## Full verification

Focused command matrix results:

- typecheck: PASS
- lint: PASS
- build: PASS
- animation assets: 7/7 PASS
- Prefabs: 6/6 PASS
- Prefab API: 24/24 PASS
- GameObjects: 3/3 PASS
- renderer: 5/5 PASS
- Scene cutover: 10/10 PASS
- rig prerequisites: 3/3 PASS
- character control: 22/22 PASS
- unit: 722/722 PASS
- integration: 289/289 PASS in the official runs
- replay: 129/129 PASS
- Repo Guard: 14/14 PASS

Full visual command: `pnpm harness:visual`

- 249 configured cases across desktop, mobile-landscape and narrow.
- 243 passed; 6 existing project-conditioned skips. No test was removed, disabled or newly skipped for this work.
- Duration: 17.4 minutes in the standalone proof.
- Wrapper reported `source checkout unchanged; disposable repository removed`.
- Windows launch was repaired by using the command shell for `npx`; the full suite then completed normally with no port, process or transaction-lock residue.

Official one-shot run 1:

- Clean start: PASS
- Result: 62/62 stages PASS
- Total: 1,199.6 seconds
- Visual: PASS, 1,061.7 seconds
- Clean afterward: PASS

Official one-shot run 2, immediately after run 1 with no cleanup:

- Clean start: PASS
- Result: 62/62 stages PASS
- Total: 1,174.2 seconds
- Visual: PASS, 1,039.8 seconds
- Clean afterward: PASS

RIG EDITOR RESTORATION PREREQUISITES: PASS

READY FOR RIG EDITOR UI RESTORATION

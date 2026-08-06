# Rig Editor restoration prerequisites audit

- Start SHA: `0e74422784b1a41a3ca3bfaaacc19dc62e82ebf6`
- Merge base with `origin/main`: `2e5b2a21a269f41aad7f14c00b0cded91233f33f`
- End implementation SHA: uncommitted; validation gate has not permitted a commit
- Working tree: intentionally dirty with this implementation

## Implemented evidence

- Added the closed `AnimationSubjectDefinition` schema and generated schema artifact.
- Exact extraction resolves a Prefab hash, exact node id, exact Component id and Animator assignment. It reports missing presentation without disabling graph authoring.
- `resolveAnimationSubject` and the legacy Character wrapper share one assignment resolver. Shared bundles do not contain subject presentation.
- Added explicit authoring-session construction with deterministic disposal ownership.
- The Prefab editor now extracts an exact subject before mounting the existing chamber. Legacy Character projection is isolated in one named adapter.
- Added stable exact publication plans with explicit targets, non-targets, protected targets and write paths; publish-only is represented by an empty target list.
- Added `harness:rig-editor-prerequisites`; `harness:prefab-api` and the prerequisite harness are explicit one-shot stages.
- Fixed Windows-neutral transaction fault injection paths and Windows `npx` launch for the visual harness.

## Adoption matrix and stored evidence

`pnpm harness:prefab-api` passed all 12 current API tests, including real publish-only, one exact holder adoption, stale holder refusal and Project byte identity. Prefab, animation-asset, GameObject, renderer, Scene cutover, character-control, world, replay, unit, repo-guard, typecheck, lint and build stages passed. Existing API coverage does not yet prove the complete requested base/fork/variant and all-four-assignment-slot matrix, so those rows remain unverified rather than inferred.

## Subject evidence

Focused subject tests prove the schema is closed, hashes are required, component identity is checked, inline child extraction works, an Animator without a model remains editable, and no first-node/first-Component fallback occurs. The prerequisite guard passes its explicit-symbol and Character-free-core checks.

## Blocking validation evidence

The first one-shot run passed 60/62 stages. Integration initially failed nine Windows path-sensitive fault tests; after normalizing fault-injection paths, the isolated file passes 16/16. Visual launch initially failed because Windows requires the command shim; that is fixed. A focused desktop rerun advanced past the formerly failing embedded-workspace assertion, but the complete 249-test visual matrix was not allowed to finish, and the required two clean one-shot runs have not been completed.

No claim is made for complete session/determinism visual coverage, the full requested adoption matrix, two green one-shots, a clean tree, or a committed audit SHA.

RIG EDITOR RESTORATION PREREQUISITES: HOLD

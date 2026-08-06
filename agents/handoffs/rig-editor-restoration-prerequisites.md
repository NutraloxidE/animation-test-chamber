# Rig Editor restoration prerequisites handoff

READY FOR RIG EDITOR UI RESTORATION

The restoration may mount the existing chamber body over an explicit `AnimationAuthoringSession` created from exact Prefab/node/Animator Component identity. The subject schema, extraction, shared resolver, session disposal boundary and exact publication plan are present and guarded.

Animation-to-Prefab adoption is verified for base, fork and variant Prefabs across behavior, motionSet, rig and tuning. Adoption requires exact hashes, variants retain canonical terminal patches, and changed targets come from promoted Prefab paths. Publish-only moves no holder or Scene.

The compatibility mapping remains isolated in `legacy-animation-workspace-adapter.ts`; remove it only when the restored UI consumes the explicit session directly. Keep `/edit/rig/:id` as its redirect until that separate route package, and do not delete `Project.characters`, `activeCharacterId`, `Scene.entities` or legacy schemas during UI restoration.

Verification at implementation SHA `6fd64220e1a627b4f7e0fdb358566bfb8ab49a50`: two consecutive clean one-shot runs passed 62/62 stages, including the complete visual matrix. No manual cleanup was required between runs.

Re-verified independently at `b6976f0e48b609f048fff10dfd1080f7fcea2359` on Linux, from a fresh install and a clean tree: every harness, the 24/24 adoption suite, the 16/16 transaction-fault suite, unit 722/722, integration 289/289, replay 129/129, zero generation drift, and the complete visual suite at 243 passed / 6 skipped of 249. Two further official one-shot runs passed 62/62 (1,062.0s and 1,036.1s), the second with no cleanup after the first. The 6 visual skips are pre-existing `test.fixme` placeholders from `fdfe70a`, counted once per browser project; none was added for this work. Note that the checkout is shallow, so the merge base against `origin/main` is not computable here.

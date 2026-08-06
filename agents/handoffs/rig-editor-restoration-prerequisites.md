# Rig Editor restoration prerequisites handoff

READY FOR RIG EDITOR UI RESTORATION

The restoration may mount the existing chamber body over an explicit `AnimationAuthoringSession` created from exact Prefab/node/Animator Component identity. The subject schema, extraction, shared resolver, session disposal boundary and exact publication plan are present and guarded.

Animation-to-Prefab adoption is verified for base, fork and variant Prefabs across behavior, motionSet, rig and tuning. Adoption requires exact hashes, variants retain canonical terminal patches, and changed targets come from promoted Prefab paths. Publish-only moves no holder or Scene.

The compatibility mapping remains isolated in `legacy-animation-workspace-adapter.ts`; remove it only when the restored UI consumes the explicit session directly. Keep `/edit/rig/:id` as its redirect until that separate route package, and do not delete `Project.characters`, `activeCharacterId`, `Scene.entities` or legacy schemas during UI restoration.

Verification at implementation SHA `6fd64220e1a627b4f7e0fdb358566bfb8ab49a50`: two consecutive clean one-shot runs passed 62/62 stages, including the complete visual matrix. No manual cleanup was required between runs.

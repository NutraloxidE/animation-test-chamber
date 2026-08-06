# 0026 â€” Animation subject before Rig Editor restoration

Status: accepted

The Rig Editor restoration waits until animation authoring has an identity independent of legacy `CharacterDefinition`. Its canonical subject is an exact immutable Prefab reference plus stable node and Animator Component ids. `activeCharacterId` remains temporary UI compatibility state; it is not authoring selection.

`AnimationSubjectDefinition` carries the Animator assignment and only the presentation needed for focused preview. The existing chamber layout is preserved and entered through an explicit subject boundary. The temporary Character projection is isolated in `legacy-animation-workspace-adapter.ts` and may be deleted when the restored UI consumes the session directly.

Publishing an animation creates an immutable version and adopts it nowhere by default. Adoption requires enumerated exact Prefab targets, a stale-state snapshot, and one transaction. Nested contributed Animators may be previewed; publication ownership remains the exact Prefab that contributed the Animator and must be presented as an explicit target plan.

The next restoration package may assume a closed subject schema, exact extraction, one subject resolver, isolated runtime sessions, an exact publication plan, and a current embedded workspace that starts from explicit Prefab identity. It must not restore legacy route selection or make `Project.characters` canonical again.

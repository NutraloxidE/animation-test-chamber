import { useMemo } from 'react';
import { create, type StateCreator } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  AnimationAssetSummary,
  AssetIssue,
  CapabilityProfile,
  CharacterAnimationAssignment,
  ProjectDefinition,
  ReplayDefinition,
  ResolvedProject,
} from '@atc/schema';
import { resolveWeaponMode } from '@atc/animation-runtime';
import {
  AnimationAssetRegistry,
  diffToPatches,
  registryFromLibraryIndex,
  resolveCharacterAnimation,
  stripGraphPrefix,
} from '@atc/animation-asset-runtime';
import { EditSession } from '@atc/editor-core';
import type { DiffReport } from '@atc/runtime-core';
import { setAtPath } from '@atc/runtime-core';
import type { AdjustmentProposal } from '@atc/ai-adapter';
import { RuleBasedProvider } from '@atc/ai-adapter';
import type { ReplayTrace } from '@atc/replay-runtime';
import { REPLAY_FIXTURES, defaultEquipped } from '@atc/replay-runtime';
import { unavailableCapability } from '@atc/haptics-runtime';
import { ChamberEngine } from './engine.ts';
import { backendAvailable, NO_BACKEND_MESSAGE } from './backend.ts';
import { CHARACTER_PRESETS, WEAPON_MODES, type WeaponGrip } from './three/catalog.ts';
import seedProject from '@chamber/project';
import seedAssetIndex from '@chamber/animation-assets';

export type PanelId =
  'inspector' | 'graph' | 'timeline' | 'timing' | 'replay' | 'diff' | 'ai' | 'capability' | 'terrain' | 'acquisition';

/** Chamber or Asset Library. Deliberately not a router (PLAN 24.1). */
export type WorkspaceMode = 'chamber' | 'asset-library';

/**
 * Where a chamber edit should be written (PLAN 28).
 *
 * There is no default. The whole point of the dialog is that "I nudged a blend
 * duration" has four different meanings — mine only, this character's feel, a
 * new variant, or everyone's — and picking one silently is how a shared asset
 * stops being shared without anyone deciding to.
 */
export type SaveDestinationKind =
  | 'character-override'
  | 'tuning-profile'
  | 'behavior-variant'
  | 'new-behavior-variant'
  | 'shared-behavior';

export interface SaveDestination {
  kind: SaveDestinationKind;
  /** Required for `new-behavior-variant`. */
  newAssetId?: string;
  displayName?: string;
}

export interface SaveDestinationOption {
  kind: SaveDestinationKind;
  label: string;
  /** Who is affected if this is chosen. Shown next to each option. */
  impact: string;
  available: boolean;
  unavailableReason?: string;
}

export interface CompareSlot {
  label: string;
  document: ResolvedProject;
  trace: ReplayTrace | null;
  proposal: AdjustmentProposal | null;
}

interface ChamberState {
  session: EditSession;
  engine: ChamberEngine;
  /** The resolved document the chamber edits and previews. */
  project: ResolvedProject;
  /** The reference-only document that is written to project.json. */
  canonicalProject: ProjectDefinition;
  registry: AnimationAssetRegistry;
  assetIssues: AssetIssue[];

  workspaceMode: WorkspaceMode;
  activeCharacterId: string;

  /** Asset Library view state. */
  librarySelection: { assetType: string; assetId: string; version: string } | null;
  libraryTypeFilter: string;
  librarySearch: string;
  libraryFacet: string;
  /** Open dialog in the library, if any. */
  libraryDialog: 'apply' | 'save-destination' | 'derive' | null;
  libraryMessage: string;

  selectedTransitionId: string;
  selectedStateId: string;
  activePanel: PanelId;
  terrainPresetId: string;
  characterPresetId: string;
  weaponModeId: string;
  /** Equipment slot id → equipped, seeded from each slot's declared default. */
  equipped: Record<string, boolean>;
  weaponGripOverrides: Record<string, WeaponGrip>;
  gripEditorMode: 'translate' | 'rotate' | null;

  proposals: AdjustmentProposal[];
  aiBusy: boolean;
  aiMessage: string;

  compareSlots: CompareSlot[];
  activeCompareSlot: number;
  ghostEnabled: boolean;

  replays: ReplayDefinition[];
  selectedReplayId: string;
  recordedReplays: ReplayDefinition[];

  capability: CapabilityProfile;
  showMobilePad: boolean;
  hideUiForRecording: boolean;

  commitLog: string[];
  statusMessage: string;
  /**
   * Whether the API server answered. Null while the probe is in flight; false
   * on a static host (Vercel), where git and disk-backed actions are inert.
   */
  backendOnline: boolean | null;
  /** Bumped whenever the preview document changes, to re-render panels. */
  revision: number;
}

interface ChamberActions {
  setWorkspaceMode(mode: WorkspaceMode): void;
  setActiveCharacter(characterId: string): void;
  selectLibraryAsset(selection: { assetType: string; assetId: string; version: string } | null): void;
  setLibraryTypeFilter(assetType: string): void;
  setLibrarySearch(text: string): void;
  setLibraryFacet(facet: string): void;
  openLibraryDialog(dialog: 'apply' | 'save-destination' | 'derive' | null): void;
  librarySummaries(): AnimationAssetSummary[];
  saveDestinationOptions(): SaveDestinationOption[];
  saveStagedAnimationChanges(destination: SaveDestination): Promise<void>;
  applyAssetsToCharacter(characterId: string, assignment: CharacterAnimationAssignment): Promise<void>;
  deriveAsset(mode: 'variant' | 'fork' | 'duplicate', newAssetId: string, displayName: string, forkIntent?: string): Promise<void>;
  promoteCandidateToClip(candidateId: string, motionSetId?: string, motionSlot?: string): Promise<void>;
  reloadAssets(project?: ProjectDefinition): Promise<void>;
  setPreviewValue(path: string, value: unknown, options?: { intent?: string }): void;
  unlockPath(path: string): void;
  undo(): void;
  redo(): void;
  resetToRepository(path: string): void;
  resetToAiProposal(path: string): void;
  stage(path: string): void;
  stageAll(): void;
  revertSession(): void;
  selectTransition(id: string): void;
  selectState(id: string): void;
  setPanel(panel: PanelId): void;
  setTerrainPreset(id: string): void;
  setCharacterPreset(id: string): void;
  setWeaponMode(id: string): void;
  setEquipped(slotId: string, equipped: boolean): void;
  setGripEditorMode(mode: 'translate' | 'rotate' | null): void;
  saveWeaponGrip(characterId: string, weaponId: string, grip: WeaponGrip): void;
  resetWeaponGrip(characterId: string, weaponId: string): void;
  requestProposals(request: string): Promise<void>;
  applyProposal(proposal: AdjustmentProposal, approve: boolean): void;
  buildCompareSlots(): void;
  activateCompareSlot(index: number): void;
  setGhostEnabled(enabled: boolean): void;
  selectReplay(id: string): void;
  playSelectedReplay(): void;
  addRecordedReplay(replay: ReplayDefinition): void;
  refreshCapability(capability: CapabilityProfile): void;
  toggleMobilePad(): void;
  setHideUiForRecording(hide: boolean): void;
  commit(intent: string): Promise<void>;
  createPullRequest(): Promise<void>;
  exportUnity(): Promise<void>;
  setStatus(message: string): void;
  detectBackend(): Promise<void>;
  diff(): DiffReport;
}

const canonicalSeed = seedProject as ProjectDefinition;

/**
 * The registry the browser resolves against.
 *
 * Built from the generated index rather than fetched, so the chamber renders on
 * a fresh clone and on a static host with no API. The API is still the only
 * authority for writes; this is the read-only starting point, exactly as the
 * project import always was.
 */
const seedRegistry: AnimationAssetRegistry = registryFromLibraryIndex(seedAssetIndex);

function resolveFor(
  project: ProjectDefinition,
  characterId: string,
  registry: AnimationAssetRegistry,
): { project: ResolvedProject; issues: AssetIssue[] } {
  return resolveCharacterAnimation({ registry, project, characterId });
}

const initialResolution = resolveFor(
  canonicalSeed,
  canonicalSeed.activeCharacterId,
  seedRegistry,
);
const initialProject = initialResolution.project;
const stagedDraftKey = `atc:staged-draft:${canonicalSeed.id}`;

const sessionId = `s${Date.now().toString(36)}`;

/**
 * Browser-side AI provider, used when there is no API server to ask. It is the
 * same class the server defaults to, so the proposals are identical.
 */
const localAi = new RuleBasedProvider();

function restoreStagedDraft(session: EditSession): number {
  try {
    const raw = window.localStorage.getItem(stagedDraftKey);
    if (!raw) return 0;
    const draft = JSON.parse(raw) as {
      revisionId?: string;
      changes?: { path: string; value: unknown }[];
    };
    if (draft.revisionId !== canonicalSeed.revisionId || !Array.isArray(draft.changes)) {
      window.localStorage.removeItem(stagedDraftKey);
      return 0;
    }
    let restored = 0;
    for (const change of draft.changes) {
      const outcome = session.setPreviewValue({
        path: change.path,
        value: change.value,
        actor: 'human',
      });
      if (!outcome.applied) continue;
      session.stage(change.path);
      restored += 1;
    }
    return restored;
  } catch {
    return 0;
  }
}

function persistStagedDraft(session: EditSession): void {
  try {
    const changes = session.stagedChanges;
    if (changes.length === 0) {
      window.localStorage.removeItem(stagedDraftKey);
      return;
    }
    window.localStorage.setItem(
      stagedDraftKey,
      JSON.stringify({
        revisionId: session.repositoryProject.revisionId,
        changes,
      }),
    );
  } catch {
    // Storage may be unavailable in privacy modes; the in-memory session still works.
  }
}

const createChamber: StateCreator<ChamberState & ChamberActions> = (set, get) => {
  const session = new EditSession(initialProject);
  const restoredChanges = restoreStagedDraft(session);
  const engine = new ChamberEngine(session.previewProject);

  /** Pushes the current preview document into the running simulation. */
  const syncPreview = (): void => {
    const preview = session.previewProject;
    persistStagedDraft(session);
    engine.setProject(preview);
    set({ project: preview, revision: get().revision + 1 });
  };

  return {
    session,
    engine,
    project: session.previewProject,
    canonicalProject: canonicalSeed,
    registry: seedRegistry,
    assetIssues: initialResolution.issues,

    workspaceMode: 'chamber',
    activeCharacterId: canonicalSeed.activeCharacterId,

    librarySelection: null,
    libraryTypeFilter: 'all',
    librarySearch: '',
    libraryFacet: 'all',
    libraryDialog: null,
    libraryMessage: '',

    selectedTransitionId: 'run-to-attack-01',
    selectedStateId: 'run',
    activePanel: 'inspector',
    terrainPresetId: canonicalSeed.defaultTerrainPresetId,
    characterPresetId: CHARACTER_PRESETS[0]!.id,
    weaponModeId: WEAPON_MODES[0]!.id,
    equipped: defaultEquipped(canonicalSeed),
    weaponGripOverrides: {},
    gripEditorMode: null,

    proposals: [],
    aiBusy: false,
    aiMessage: '',

    compareSlots: [],
    activeCompareSlot: -1,
    ghostEnabled: false,

    replays: REPLAY_FIXTURES,
    selectedReplayId: REPLAY_FIXTURES[0]?.id ?? '',
    recordedReplays: [],

    capability: unavailableCapability(),
    showMobilePad: false,
    hideUiForRecording: false,

    commitLog: [],
    statusMessage:
      restoredChanges > 0
        ? `Restored ${restoredChanges} staged change(s).`
        : 'Ready. Editing the demo character with the fake Git adapter.',
    backendOnline: null,
    revision: 0,

    setWorkspaceMode(mode) {
      set({ workspaceMode: mode, statusMessage: mode === 'chamber' ? 'Chamber' : 'Asset Library' });
    },

    /**
     * Switches which character the chamber is driving.
     *
     * The whole session is rebuilt because the resolved document is a different
     * document: different clips, different tuning. Carrying staged edits across
     * would mean applying one character's decisions to another's assets, which
     * is exactly the leak the asset split exists to prevent.
     */
    setActiveCharacter(characterId) {
      const canonical = get().canonicalProject;
      if (!canonical.characters.some((entry) => entry.id === characterId)) return;
      const resolution = resolveFor(canonical, characterId, get().registry);
      const errors = resolution.issues.filter((issue) => issue.severity === 'error');
      if (errors.length > 0) {
        set({
          assetIssues: resolution.issues,
          statusMessage: `Cannot switch: ${errors[0]!.message}`,
        });
        return;
      }
      session.acceptCommitted(resolution.project);
      engine.setProject(resolution.project);
      set({
        activeCharacterId: characterId,
        project: resolution.project,
        assetIssues: resolution.issues,
        revision: get().revision + 1,
        statusMessage: `Character: ${resolution.project.character.displayName}`,
      });
    },

    selectLibraryAsset(selection) {
      set({ librarySelection: selection, libraryDialog: null });
    },

    setLibraryTypeFilter(assetType) {
      set({ libraryTypeFilter: assetType });
    },

    setLibrarySearch(text) {
      set({ librarySearch: text });
    },

    setLibraryFacet(facet) {
      set({ libraryFacet: facet });
    },

    openLibraryDialog(dialog) {
      set({ libraryDialog: dialog });
    },

    /**
     * The library list. Search runs in the browser against the terms the index
     * carries (PLAN 24.5), so filtering stays instant and works with no API.
     */
    librarySummaries() {
      const { registry, libraryTypeFilter, librarySearch, libraryFacet, project } = get();
      const summaries = registry.summaries({
        ...(libraryTypeFilter !== 'all'
          ? { assetType: libraryTypeFilter as AnimationAssetSummary['assetType'] }
          : {}),
        ...(librarySearch.trim() ? { text: librarySearch.trim() } : {}),
      });

      const used = new Set<string>();
      for (const character of get().canonicalProject.characters) {
        for (const reference of [
          character.animation.behavior,
          character.animation.motionSet,
          character.animation.rig,
          character.animation.tuning,
        ]) {
          if (reference) used.add(`${reference.assetType}:${reference.assetId}`);
        }
      }
      const activeUsed = new Set(
        [
          project.character.animation.behavior,
          project.character.animation.motionSet,
          project.character.animation.rig,
          project.character.animation.tuning,
        ]
          .filter(Boolean)
          .map((reference) => `${reference!.assetType}:${reference!.assetId}`),
      );

      return summaries.filter((summary) => {
        const key = `${summary.assetType}:${summary.id}`;
        switch (libraryFacet) {
          case 'used-by-active':
            return activeUsed.has(key);
          case 'unused':
            return !used.has(key);
          case 'variant':
            return summary.derivation === 'variant';
          case 'fork':
            return summary.derivation === 'fork';
          case 'protected':
            return summary.protectionLevel !== 'editable';
          case 'invalid':
            return !summary.valid;
          default:
            return true;
        }
      });
    },

    /**
     * The destinations a staged animation edit could go to, each with the blast
     * radius spelled out. Options the project cannot honour are shown disabled
     * with the reason rather than hidden — a missing tuning profile is worth
     * knowing about, and a silently shorter list teaches nothing.
     */
    saveDestinationOptions() {
      const { project, canonicalProject } = get();
      const behaviorId = project.character.animation.behavior.assetId;
      const sharing = canonicalProject.characters.filter(
        (character) => character.animation.behavior.assetId === behaviorId,
      );
      const hasTuning = Boolean(project.character.animation.tuning);
      const isVariant =
        get().registry.find(project.character.animation.behavior)?.metadata.assetType ===
          'animation-behavior' &&
        get().librarySummaries().some(
          (summary) => summary.id === behaviorId && summary.derivation === 'variant',
        );

      return [
        {
          kind: 'character-override' as const,
          label: 'Character instance override',
          impact: `Only "${project.character.displayName}".`,
          available: true,
        },
        {
          kind: 'tuning-profile' as const,
          label: 'New version of this character’s tuning profile',
          impact: hasTuning
            ? `Only "${project.character.displayName}", but reusable by other characters that adopt the profile.`
            : '',
          available: hasTuning,
          ...(hasTuning ? {} : { unavailableReason: 'this character has no tuning profile' }),
        },
        {
          kind: 'behavior-variant' as const,
          label: 'New version of this behaviour variant',
          impact: 'Every character on this variant.',
          available: isVariant,
          ...(isVariant ? {} : { unavailableReason: 'the active behaviour is not a variant' }),
        },
        {
          kind: 'new-behavior-variant' as const,
          label: 'New behaviour variant',
          impact: 'Nothing, until a character is pointed at it.',
          available: true,
        },
        {
          kind: 'shared-behavior' as const,
          label: 'New version of the shared behaviour',
          impact:
            sharing.length > 1
              ? `All ${sharing.length} characters on "${behaviorId}": ${sharing.map((c) => c.displayName).join(', ')}. Replay verification is required.`
              : `"${project.character.displayName}" only, for now — but anything that adopts "${behaviorId}" later inherits it.`,
          available: true,
        },
      ];
    },

    /**
     * Writes the staged animation edits to the chosen destination.
     *
     * The patch set is derived from repository-versus-preview rather than from
     * the raw staged values, so a nested edit lands as one path instead of an
     * object blob, and the path roots are converted to whatever the destination
     * expects.
     */
    async saveStagedAnimationChanges(destination) {
      const changes = session.stagedAssetChanges;
      if (changes.length === 0) {
        set({ statusMessage: 'No staged animation changes to save.' });
        return;
      }
      if (!(await backendAvailable())) {
        set({
          statusMessage: `Save: ${NO_BACKEND_MESSAGE} The edit stays in this browser as a draft.`,
        });
        return;
      }

      const repository = session.repositoryProject;
      const preview = session.buildStagedDocument();
      const graphPatches = diffToPatches(repository.graph, preview.graph, '');
      const clipPatches = diffToPatches(repository.clips, preview.clips, '');
      const character = get().project.character;

      try {
        if (destination.kind === 'character-override') {
          const assignment: CharacterAnimationAssignment = {
            ...character.animation,
            instanceOverrides: [
              ...character.animation.instanceOverrides,
              ...graphPatches.map((patch) => ({ ...patch, path: `/graph${patch.path}` })),
              ...clipPatches.map((patch) => ({ ...patch, path: `/clips${patch.path}` })),
            ],
          };
          await get().applyAssetsToCharacter(character.id, assignment);
          return;
        }

        const response = await fetch('/api/animation-assets/save-destination', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            characterId: character.id,
            destination,
            graphPatches: graphPatches.map((patch) => ({
              ...patch,
              path: stripGraphPrefix(patch.path),
            })),
            clipPatches,
          }),
        });
        const payload = (await response.json()) as {
          ok?: boolean;
          error?: string;
          issues?: AssetIssue[];
          project?: ProjectDefinition;
          reportPath?: string;
        };
        if (!response.ok || !payload.ok) {
          set({
            statusMessage: `Save refused: ${payload.error ?? ''} ${(payload.issues ?? [])
              .map((issue) => issue.message)
              .slice(0, 2)
              .join('; ')}`,
          });
          return;
        }
        await get().reloadAssets(payload.project);
        set({ statusMessage: `Saved to ${destination.kind}. Report: ${payload.reportPath}` });
      } catch (error) {
        set({ statusMessage: `Save failed: ${String(error)}` });
      }
    },

    async applyAssetsToCharacter(characterId, assignment) {
      if (!(await backendAvailable())) {
        // Static mode still previews the assignment — it just cannot publish it.
        const canonical: ProjectDefinition = {
          ...get().canonicalProject,
          characters: get().canonicalProject.characters.map((entry) =>
            entry.id === characterId ? { ...entry, animation: assignment } : entry,
          ),
        };
        const resolution = resolveFor(canonical, characterId, get().registry);
        engine.setProject(resolution.project);
        set({
          project: resolution.project,
          assetIssues: resolution.issues,
          revision: get().revision + 1,
          statusMessage: `Applied for preview only. ${NO_BACKEND_MESSAGE}`,
        });
        return;
      }
      try {
        const response = await fetch('/api/animation-assets/apply', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ characterId, assignment }),
        });
        const payload = (await response.json()) as {
          ok?: boolean;
          issues?: AssetIssue[];
          project?: ProjectDefinition;
          error?: string;
        };
        if (!response.ok || !payload.ok) {
          set({
            statusMessage: `Apply refused: ${payload.error ?? ''} ${(payload.issues ?? [])
              .map((issue) => issue.message)
              .slice(0, 2)
              .join('; ')}`,
          });
          return;
        }
        await get().reloadAssets(payload.project);
        set({ statusMessage: `Applied assets to "${characterId}".`, libraryDialog: null });
      } catch (error) {
        set({ statusMessage: `Apply failed: ${String(error)}` });
      }
    },

    async deriveAsset(mode, newAssetId, displayName, forkIntent) {
      const selection = get().librarySelection;
      if (!selection) {
        set({ statusMessage: 'Select an asset first.' });
        return;
      }
      if (!(await backendAvailable())) {
        set({ statusMessage: `Create ${mode}: ${NO_BACKEND_MESSAGE}` });
        return;
      }
      const endpoint =
        mode === 'variant'
          ? 'create-variant'
          : mode === 'fork'
            ? 'create-fork'
            : 'duplicate';
      const parentKey = mode === 'duplicate' ? 'source' : 'parent';
      try {
        const response = await fetch(`/api/animation-assets/${endpoint}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            [parentKey]: selection,
            newAssetId,
            displayName,
            patches: [],
            ...(forkIntent ? { forkIntent } : {}),
          }),
        });
        const payload = (await response.json()) as {
          ok?: boolean;
          error?: string;
          issues?: AssetIssue[];
        };
        if (!response.ok || !payload.ok) {
          set({
            statusMessage: `Create ${mode} refused: ${payload.error ?? ''} ${(payload.issues ?? [])
              .map((issue) => issue.message)
              .slice(0, 2)
              .join('; ')}`,
          });
          return;
        }
        await get().reloadAssets();
        set({
          statusMessage: `Created ${mode} "${newAssetId}".`,
          libraryDialog: null,
          librarySelection: {
            assetType: selection.assetType,
            assetId: newAssetId,
            version: '1.0.0',
          },
        });
      } catch (error) {
        set({ statusMessage: `Create ${mode} failed: ${String(error)}` });
      }
    },

    async promoteCandidateToClip(candidateId, motionSetId, motionSlot) {
      if (!(await backendAvailable())) {
        set({ statusMessage: `Promote candidate: ${NO_BACKEND_MESSAGE}` });
        return;
      }
      try {
        const response = await fetch('/api/animation-assets/promote-candidate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            candidateId,
            ...(motionSetId ? { motionSetId } : {}),
            ...(motionSlot ? { motionSlot } : {}),
          }),
        });
        const payload = (await response.json()) as { ok?: boolean; error?: string };
        if (!response.ok || !payload.ok) {
          set({ statusMessage: `Promotion refused: ${payload.error ?? 'unknown error'}` });
          return;
        }
        await get().reloadAssets();
        set({ statusMessage: `Promoted "${candidateId}" to a clip asset.` });
      } catch (error) {
        set({ statusMessage: `Promotion failed: ${String(error)}` });
      }
    },

    /** Re-reads the registry from the API after a transaction changed it. */
    async reloadAssets(project) {
      try {
        const response = await fetch('/api/animation-assets');
        const payload = (await response.json()) as {
          index?: Parameters<typeof registryFromLibraryIndex>[0];
          project?: ProjectDefinition;
        };
        if (!payload.index) return;
        const registry = registryFromLibraryIndex(payload.index);
        const canonical = project ?? payload.project ?? get().canonicalProject;
        const resolution = resolveFor(canonical, get().activeCharacterId, registry);
        session.acceptCommitted(resolution.project);
        engine.setProject(resolution.project);
        set({
          registry,
          canonicalProject: canonical,
          project: resolution.project,
          assetIssues: resolution.issues,
          revision: get().revision + 1,
        });
      } catch {
        // A failed refresh leaves the previous registry in place; the caller's
        // status message already says what happened.
      }
    },

    setPreviewValue(path, value, options) {
      const outcome = session.setPreviewValue({
        path,
        value,
        actor: 'human',
        ...(options?.intent ? { intent: options.intent } : {}),
        replayId: get().selectedReplayId,
        terrainPresetId: get().terrainPresetId,
      });
      if (!outcome.applied) {
        set({ statusMessage: `Refused: ${outcome.reason}` });
        return;
      }
      syncPreview();
      if (session.fieldView(path).needsSave) {
        set({
          statusMessage: 'Changed since staged. Save again to update the staged draft.',
        });
      }
    },

    unlockPath(path) {
      session.unlock(path);
      set({
        statusMessage: `Unlocked ${path} for this session only. It stays locked in the repository.`,
        revision: get().revision + 1,
      });
    },

    undo() {
      if (session.undo()) syncPreview();
    },

    redo() {
      if (session.redo()) syncPreview();
    },

    resetToRepository(path) {
      session.resetToRepository(path);
      syncPreview();
    },

    resetToAiProposal(path) {
      const outcome = session.resetToAiProposal(path);
      if (!outcome.applied) {
        set({ statusMessage: outcome.reason });
        return;
      }
      syncPreview();
    },

    stage(path) {
      session.stage(path);
      persistStagedDraft(session);
      set({
        revision: get().revision + 1,
        statusMessage: `Staged locally. Use "Apply staged to repository" to write project.json.`,
      });
    },

    stageAll() {
      session.stageAll();
      persistStagedDraft(session);
      set({
        revision: get().revision + 1,
        statusMessage: `Staged ${session.stagedPaths.length} change(s) locally. Use "Apply staged to repository" to write project.json.`,
      });
    },

    revertSession() {
      session.revertSession();
      syncPreview();
      set({
        statusMessage: 'Session reverted to the repository values.',
        proposals: [],
      });
    },

    selectTransition(id) {
      set({ selectedTransitionId: id });
    },

    selectState(id) {
      set({ selectedStateId: id });
    },

    setPanel(panel) {
      set({ activePanel: panel });
    },

    setTerrainPreset(id) {
      engine.setTerrainPreset(id);
      set({ terrainPresetId: id });
    },

    setCharacterPreset(id) {
      if (!CHARACTER_PRESETS.some((preset) => preset.id === id)) return;
      set({
        characterPresetId: id,
        gripEditorMode: null,
        statusMessage: `Character: ${CHARACTER_PRESETS.find((preset) => preset.id === id)!.label}`,
      });
    },

    setWeaponMode(id) {
      const weapon = WEAPON_MODES.find((mode) => mode.id === id);
      if (!weapon) return;
      engine.setUpperBodyActionRootMotionEnabled(weapon.usesAttackRootMotion === true);
      engine.setWeaponModeId(weapon.id);
      set({
        weaponModeId: id,
        gripEditorMode: null,
        statusMessage: `Weapon: ${weapon.label}`,
      });
    },

    setEquipped(slotId, equipped) {
      const slot = canonicalSeed.equipment.find((entry) => entry.id === slotId);
      if (!slot) return;
      engine.setEquipped(slotId, equipped);
      set({
        equipped: { ...get().equipped, [slotId]: equipped },
        statusMessage: `${slot.label}: ${equipped ? 'equipped' : 'unequipped'}`,
      });
    },

    setGripEditorMode(mode) {
      set({
        gripEditorMode: mode,
        statusMessage: mode ? `Grip editor: ${mode}. Drag the gizmo; changes auto-save.` : 'Grip editor closed.',
      });
    },

    saveWeaponGrip(characterId, weaponId, grip) {
      set({
        weaponGripOverrides: {
          ...get().weaponGripOverrides,
          [`${characterId}:${weaponId}`]: grip,
        },
        statusMessage: 'Grip saved locally.',
      });
    },

    resetWeaponGrip(characterId, weaponId) {
      const weaponGripOverrides = { ...get().weaponGripOverrides };
      delete weaponGripOverrides[`${characterId}:${weaponId}`];
      set({
        weaponGripOverrides,
        statusMessage: 'Grip reset to the catalog default.',
      });
    },

    async requestProposals(request) {
      set({ aiBusy: true, aiMessage: '' });
      const targetPath = `/graph/transitions/${get().selectedTransitionId}`;

      // The rule-based provider is pure computation over the document, so on a
      // static host it runs in the browser rather than disappearing. Only the
      // Anthropic-backed provider needs the server, because only it holds a key.
      if (!(await backendAvailable())) {
        try {
          const proposals = await localAi.proposeAdjustments({
            project: session.previewProject,
            request,
            targetPath,
            replayId: get().selectedReplayId,
            terrainPresetId: get().terrainPresetId,
          });
          set({
            proposals,
            aiBusy: false,
            aiMessage: `${proposals.length} proposal(s) from the ${localAi.id} provider, running in the browser.`,
          });
          get().buildCompareSlots();
        } catch (error) {
          set({
            aiBusy: false,
            aiMessage: `Proposal failed: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
        return;
      }

      try {
        const response = await fetch('/api/ai/propose', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            document: session.previewProject,
            request,
            targetPath,
            replayId: get().selectedReplayId,
            terrainPresetId: get().terrainPresetId,
          }),
        });
        const payload = (await response.json()) as {
          proposals?: AdjustmentProposal[];
          provider?: string;
          error?: string;
        };
        if (payload.error) {
          set({ aiBusy: false, aiMessage: payload.error });
          return;
        }
        const proposals = payload.proposals ?? [];
        set({
          proposals,
          aiBusy: false,
          aiMessage: `${proposals.length} proposal(s) from the ${payload.provider} provider.`,
        });
        get().buildCompareSlots();
      } catch (error) {
        set({
          aiBusy: false,
          aiMessage: `Could not reach the API server: ${
            error instanceof Error ? error.message : String(error)
          }. Start it with \`pnpm dev:api\`.`,
        });
      }
    },

    applyProposal(proposal, approve) {
      let applied = 0;
      let refused = 0;
      let lastReason = '';
      for (const change of proposal.changes) {
        // Recorded on apply, not on generation: "reset to AI proposal" should
        // return the value the human actually took, not whichever of the three
        // variants happened to be produced last.
        session.recordAiProposal(change.path, change.after);
        const outcome = session.setPreviewValue({
          path: change.path,
          value: change.after,
          actor: 'ai',
          approved: approve,
        });
        if (outcome.applied) applied += 1;
        else {
          refused += 1;
          lastReason = outcome.reason;
        }
      }
      syncPreview();
      set({
        statusMessage:
          refused === 0
            ? `Applied ${applied} change(s) from ${proposal.title}.`
            : `Applied ${applied}, refused ${refused}. ${lastReason}`,
      });
    },

    /**
     * Builds the A/B/C comparison set: each proposal applied to its own copy of
     * the document, all evaluated against the same replay, terrain and seed.
     */
    buildCompareSlots() {
      const replay = get().replays.find((entry) => entry.id === get().selectedReplayId);
      if (!replay) return;

      const base = session.previewProject;
      const slots: CompareSlot[] = [
        {
          label: 'Repository',
          document: session.repositoryProject,
          trace: engine.traceFor(session.repositoryProject, replay),
          proposal: null,
        },
      ];

      for (const proposal of get().proposals) {
        let document = base;
        for (const change of proposal.changes) {
          document = setAtPath(document, change.path, change.after);
        }
        slots.push({
          label: proposal.title,
          document,
          trace: engine.traceFor(document, replay),
          proposal,
        });
      }

      set({ compareSlots: slots, activeCompareSlot: 0 });
    },

    activateCompareSlot(index) {
      const slot = get().compareSlots[index];
      if (!slot) return;
      // Instant A/B/C switch: swap the document driving the live preview.
      engine.setProject(slot.document);
      set({
        activeCompareSlot: index,
        statusMessage: `Previewing: ${slot.label}`,
      });
    },

    setGhostEnabled(enabled) {
      const replay = get().replays.find((entry) => entry.id === get().selectedReplayId);
      if (enabled && replay) {
        engine.setGhost(engine.traceFor(session.repositoryProject, replay));
      } else {
        engine.setGhost(null);
      }
      set({ ghostEnabled: enabled });
    },

    selectReplay(id) {
      set({ selectedReplayId: id });
    },

    playSelectedReplay() {
      const all = [...get().replays, ...get().recordedReplays];
      const replay = all.find((entry) => entry.id === get().selectedReplayId);
      if (!replay) return;
      set({ terrainPresetId: replay.terrainPresetId });
      engine.playReplay(replay);
    },

    addRecordedReplay(replay) {
      set({
        recordedReplays: [...get().recordedReplays, replay],
        selectedReplayId: replay.id,
        statusMessage: `Recorded ${replay.tickCount} ticks as "${replay.id}".`,
      });
    },

    refreshCapability(capability) {
      set({ capability });
    },

    toggleMobilePad() {
      set({ showMobilePad: !get().showMobilePad });
    },

    setHideUiForRecording(hide) {
      set({ hideUiForRecording: hide });
    },

    async commit(intent) {
      const validation = session.validate();
      if (!validation.valid) {
        set({
          statusMessage: `Validation failed: ${validation.issues
            .slice(0, 3)
            .map((issue) => `${issue.path} ${issue.message}`)
            .join('; ')}`,
        });
        return;
      }

      // Animation edits belong to an asset, and which asset is a human's
      // decision. Committing them into project.json would be that decision
      // taken silently, so the commit stops and asks instead.
      if (session.stagedAssetChanges.length > 0) {
        set({
          libraryDialog: 'save-destination',
          statusMessage:
            `${session.stagedAssetChanges.length} staged change(s) belong to an animation asset. ` +
            `Choose where they should live before committing.`,
        });
        return;
      }

      if (!(await backendAvailable())) {
        set({
          statusMessage: `Commit: ${NO_BACKEND_MESSAGE} Staged changes stay in this browser.`,
        });
        return;
      }

      try {
        const headResponse = await fetch('/api/git/head?branch=main');
        const head = (await headResponse.json()) as { sha?: string };

        const response = await fetch('/api/commit', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            document: session.buildStagedProjectDocument(get().canonicalProject),
            baseSha: head.sha ?? '',
            sessionId,
            author: 'chamber-user',
            intent,
          }),
        });
        const payload = (await response.json()) as {
          commit?: { sha: string; branch: string };
          document?: ProjectDefinition;
          message?: string;
          error?: string;
          findings?: { path: string; message: string }[];
          conflicts?: { path: string }[];
        };

        if (!response.ok || !payload.commit || !payload.document) {
          const detail =
            payload.findings?.map((f) => `${f.path}: ${f.message}`).join('; ') ??
            payload.conflicts?.map((c) => c.path).join(', ') ??
            '';
          set({
            statusMessage: `Commit refused: ${payload.error ?? 'unknown error'} ${detail}`,
          });
          return;
        }

        // Report the commit before refreshing the registry. The refresh is a
        // second round-trip, and writing project.json makes the dev server
        // reload the page — a status message that waited for it would often
        // never be seen.
        set({
          commitLog: [
            `${payload.commit.sha.slice(0, 8)} on ${payload.commit.branch}: ${payload.message}`,
            ...get().commitLog,
          ],
          statusMessage: `Committed ${payload.commit.sha.slice(0, 8)} to ${payload.commit.branch}.`,
        });
        await get().reloadAssets(payload.document);
      } catch (error) {
        set({
          statusMessage: `Commit failed: ${
            error instanceof Error ? error.message : String(error)
          }. Is the API server running?`,
        });
      }
    },

    async createPullRequest() {
      if (!(await backendAvailable())) {
        set({ statusMessage: `Pull request: ${NO_BACKEND_MESSAGE}` });
        return;
      }
      try {
        const response = await fetch('/api/pull-request', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sessionId,
            title: 'Chamber tuning session',
            body: 'Values tuned in the Animation Test Chamber.',
          }),
        });
        const payload = (await response.json()) as {
          pullRequest?: { number: number; url: string };
          adapter?: string;
          error?: string;
        };
        set({
          statusMessage: payload.pullRequest
            ? `Pull request #${payload.pullRequest.number} (${payload.adapter}): ${payload.pullRequest.url}`
            : `Pull request failed: ${payload.error}`,
        });
      } catch (error) {
        set({ statusMessage: `Pull request failed: ${String(error)}` });
      }
    },

    async exportUnity() {
      // The export writes a bundle into generated/unity on the machine running
      // the API. There is no filesystem to write to on a static host.
      if (!(await backendAvailable())) {
        set({ statusMessage: `Unity export: ${NO_BACKEND_MESSAGE}` });
        return;
      }
      try {
        const response = await fetch('/api/unity/export', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ document: session.previewProject }),
        });
        const payload = (await response.json()) as {
          fileCount?: number;
          outputDirectory?: string;
          error?: string;
        };
        set({
          statusMessage: payload.error
            ? `Unity export failed: ${payload.error}`
            : `Unity bundle written: ${payload.fileCount} file(s) in ${payload.outputDirectory}.`,
        });
      } catch (error) {
        set({ statusMessage: `Unity export failed: ${String(error)}` });
      }
    },

    setStatus(message) {
      set({ statusMessage: message });
    },

    async detectBackend() {
      const online = await backendAvailable();
      set({ backendOnline: online });
      if (!online) {
        set({
          statusMessage:
            'Static deployment: no API server. Tuning, replay, terrain and AI proposals run in the browser; commit, pull request, Unity export and asset import are disabled.',
        });
      }
    },

    diff() {
      return session.diff();
    },
  };
};

/**
 * View state survives a reload (including the full reload Vite does when the
 * project data changes during development): the panel and selection you had
 * open come back. Only view state is stored — the document itself still comes
 * from the repository plus the staged draft above.
 */
export const useChamber = create<ChamberState & ChamberActions>()(
  persist(createChamber, {
    name: `atc:ui:${initialProject.id}`,
    partialize: (state) => ({
      selectedTransitionId: state.selectedTransitionId,
      selectedStateId: state.selectedStateId,
      activePanel: state.activePanel,
      terrainPresetId: state.terrainPresetId,
      characterPresetId: state.characterPresetId,
      weaponModeId: state.weaponModeId,
      equipped: state.equipped,
      weaponGripOverrides: state.weaponGripOverrides,
      selectedReplayId: state.selectedReplayId,
    }),
    onRehydrateStorage: () => (state) => {
      if (!state) return;
      // Terrain lives in the engine as well as the store, and a stored preset id
      // may no longer exist after a data change.
      try {
        state.setTerrainPreset(state.terrainPresetId);
      } catch {
        state.setTerrainPreset(initialProject.defaultTerrainPresetId);
      }
      state.setWeaponMode(state.weaponModeId);
      // A slot may have been added or removed since this was stored.
      for (const slot of initialProject.equipment) {
        state.setEquipped(slot.id, state.equipped[slot.id] ?? slot.defaultEquipped);
      }
    },
  }),
);

/**
 * The document as the active weapon sees it: its own attack clips and its own
 * transition timing.
 *
 * Clip selection is a motion-set binding now, so this narrows the clip list to
 * the ones the active weapon actually resolves to and folds in that weapon's
 * transition overrides. Panels keep editing through canonical paths, and those
 * paths address the resolved document, so editing this view writes exactly the
 * weapon you are looking at.
 */
export function useWeaponProject(): ResolvedProject {
  const project = useChamber((state) => state.project);
  const weaponModeId = useChamber((state) => state.weaponModeId);
  return useMemo(() => resolveWeaponMode(project, weaponModeId), [project, weaponModeId]);
}

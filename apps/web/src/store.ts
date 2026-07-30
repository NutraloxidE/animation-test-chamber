import { create, type StateCreator } from 'zustand';
import { persist } from 'zustand/middleware';
import type { CapabilityProfile, ProjectDefinition, ReplayDefinition } from '@atc/schema';
import { EditSession } from '@atc/editor-core';
import type { DiffReport } from '@atc/runtime-core';
import { setAtPath } from '@atc/runtime-core';
import type { AdjustmentProposal } from '@atc/ai-adapter';
import { RuleBasedProvider } from '@atc/ai-adapter';
import type { ReplayTrace } from '@atc/replay-runtime';
import { REPLAY_FIXTURES } from '@atc/replay-runtime';
import { unavailableCapability } from '@atc/haptics-runtime';
import { ChamberEngine } from './engine.ts';
import { backendAvailable, NO_BACKEND_MESSAGE } from './backend.ts';
import { CHARACTER_PRESETS, MOTION_SETS } from './three/catalog.ts';
import seedProject from '@chamber/project';

export type PanelId =
  | 'inspector'
  | 'graph'
  | 'timeline'
  | 'replay'
  | 'diff'
  | 'ai'
  | 'capability'
  | 'terrain'
  | 'acquisition';

export interface CompareSlot {
  label: string;
  document: ProjectDefinition;
  trace: ReplayTrace | null;
  proposal: AdjustmentProposal | null;
}

interface ChamberState {
  session: EditSession;
  engine: ChamberEngine;
  project: ProjectDefinition;

  selectedTransitionId: string;
  selectedStateId: string;
  activePanel: PanelId;
  terrainPresetId: string;
  characterPresetId: string;
  motionSetId: string;

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
  setMotionSet(id: string): void;
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

const initialProject = seedProject as ProjectDefinition;
const stagedDraftKey = `atc:staged-draft:${initialProject.id}`;

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
    if (draft.revisionId !== initialProject.revisionId || !Array.isArray(draft.changes)) {
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
    const staged = new Set(session.stagedPaths);
    const changes = session
      .diff()
      .changes.filter((change) => staged.has(change.path))
      .map((change) => ({ path: change.path, value: change.after }));
    if (changes.length === 0) {
      window.localStorage.removeItem(stagedDraftKey);
      return;
    }
    window.localStorage.setItem(
      stagedDraftKey,
      JSON.stringify({ revisionId: session.repositoryProject.revisionId, changes }),
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

    selectedTransitionId: 'run-to-attack-01',
    selectedStateId: 'run',
    activePanel: 'inspector',
    terrainPresetId: initialProject.defaultTerrainPresetId,
    characterPresetId: CHARACTER_PRESETS[0]!.id,
    motionSetId: MOTION_SETS[0]!.id,

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
      set({ statusMessage: 'Session reverted to the repository values.', proposals: [] });
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
      set({ characterPresetId: id, statusMessage: `Character: ${CHARACTER_PRESETS.find((preset) => preset.id === id)!.label}` });
    },

    setMotionSet(id) {
      if (!MOTION_SETS.some((set) => set.id === id)) return;
      set({ motionSetId: id, statusMessage: `Motion set: ${MOTION_SETS.find((set) => set.id === id)!.label}` });
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
      set({ activeCompareSlot: index, statusMessage: `Previewing: ${slot.label}` });
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

      if (!(await backendAvailable())) {
        set({ statusMessage: `Commit: ${NO_BACKEND_MESSAGE} Staged changes stay in this browser.` });
        return;
      }

      try {
        const headResponse = await fetch('/api/git/head?branch=main');
        const head = (await headResponse.json()) as { sha?: string };

        const response = await fetch('/api/commit', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            document: session.buildStagedDocument(),
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
          set({ statusMessage: `Commit refused: ${payload.error ?? 'unknown error'} ${detail}` });
          return;
        }

        session.acceptCommitted(payload.document);
        syncPreview();
        set({
          commitLog: [
            `${payload.commit.sha.slice(0, 8)} on ${payload.commit.branch}: ${payload.message}`,
            ...get().commitLog,
          ],
          statusMessage: `Committed ${payload.commit.sha.slice(0, 8)} to ${payload.commit.branch}.`,
        });
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
      motionSetId: state.motionSetId,
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
    },
  }),
);

import { create } from 'zustand';
import type { CapabilityProfile, ProjectDefinition, ReplayDefinition } from '@atc/schema';
import { EditSession } from '@atc/editor-core';
import type { DiffReport } from '@atc/runtime-core';
import { setAtPath } from '@atc/runtime-core';
import type { AdjustmentProposal } from '@atc/ai-adapter';
import type { ReplayTrace } from '@atc/replay-runtime';
import { REPLAY_FIXTURES } from '@atc/replay-runtime';
import { unavailableCapability } from '@atc/haptics-runtime';
import { ChamberEngine } from './engine.ts';
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
  diff(): DiffReport;
}

const initialProject = seedProject as ProjectDefinition;

const sessionId = `s${Date.now().toString(36)}`;

export const useChamber = create<ChamberState & ChamberActions>((set, get) => {
  const session = new EditSession(initialProject);
  const engine = new ChamberEngine(initialProject);

  /** Pushes the current preview document into the running simulation. */
  const syncPreview = (): void => {
    const preview = session.previewProject;
    engine.setProject(preview);
    set({ project: preview, revision: get().revision + 1 });
  };

  return {
    session,
    engine,
    project: initialProject,

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
    statusMessage: 'Ready. Editing the demo character with the fake Git adapter.',
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
      set({ revision: get().revision + 1 });
    },

    stageAll() {
      session.stageAll();
      set({
        revision: get().revision + 1,
        statusMessage: `Staged ${session.stagedPaths.length} change(s).`,
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

    diff() {
      return session.diff();
    },
  };
});

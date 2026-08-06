/**
 * The one boundary every animation panel reads.
 *
 * The work package is explicit that panels must not be rewired individually to
 * unrelated APIs (§10). The reason is concrete: eleven panels each reaching for
 * their own source is eleven chances for two of them to disagree about which
 * subject is being edited, and the disagreement shows up as a panel quietly
 * editing the previous Prefab.
 *
 * So there is exactly one facade per subject, it is created when the route
 * resolves a subject and destroyed when the route leaves it, and its store is
 * a Zustand store for the same reason the legacy chamber's was: the panels
 * already select from a store with `useChamber((state) => state.x)`, and
 * matching those semantics exactly is what lets the preserved components keep
 * their bodies and change only their import.
 *
 * What this file must never contain is a Character. No `CharacterDefinition`,
 * no `Project.characters`, no `activeCharacterId` — the subject is an exact
 * Prefab node Animator, and the document is built from it.
 */
import { createStore, type StoreApi } from 'zustand/vanilla';
import type {
  AnimationSubjectDefinition,
  CapabilityProfile,
  ValidationResult,
} from '@atc/schema';
import type { CanonicalPath } from '@atc/runtime-core';
import { EditSession } from '@atc/editor-core';
import type { AnimationAuthoringSession } from '../prefab-editor/animation-authoring-session.ts';
import type { ChamberEngine } from '../engine.ts';
import type { ReplayDefinition } from '@atc/schema';
import type { ReplayTrace } from '@atc/replay-runtime';
import { detectCapability, readActiveGamepad } from '@atc/haptics-runtime';
import {
  materializeAnimationChamberDocument,
  type AnimationChamberDocument,
  type AnimationChamberRepositoryDefaults,
} from './AnimationChamberDocument.ts';


export type AnimationPanelId =
  | 'inspector'
  | 'world'
  | 'graph'
  | 'timeline'
  | 'timing'
  | 'replay'
  | 'terrain'
  | 'ai'
  | 'diff'
  | 'capability'
  | 'acquisition';

export type AnimationChamberStatus = 'loading' | 'resolved' | 'unavailable' | 'conflict';

/**
 * The selector surface.
 *
 * Field names deliberately match the legacy chamber store's, because the
 * preserved panels read them by those names. The values behind them do not
 * match: `project` here is a Character-free `AnimationChamberDocument`, and
 * `session` is an `EditSession` over that document rather than over a resolved
 * project.
 */
export interface AnimationChamberState {
  subject: AnimationSubjectDefinition;
  status: AnimationChamberStatus;

  /** The document the panels read. Named `project` for panel compatibility. */
  project: AnimationChamberDocument;
  /** The committed baseline, for before/after comparisons. */
  repositoryDocument: AnimationChamberDocument;
  /** What the preview renders, including unstaged edits. */
  previewDocument: AnimationChamberDocument;

  session: EditSession<AnimationChamberDocument>;
  /**
   * The running preview.
   *
   * An earlier revision handed the panels a four-member read port with an idle
   * stand-in behind it, because the workspace had no engine yet. It does now,
   * and the stand-in turned out to be unreachable: the simulation never needed
   * a presentation, so every subject that resolves at all can run one. A
   * subject that does not resolve has no chamber to put an engine in.
   *
   * So there is one engine, always, and the panels read it exactly as they did
   * in the donor.
   */
  engine: ChamberEngine;

  /** Terrain preset the preview stands on. Session-local (§10.1). */
  terrainPresetId: string;
  /** Device haptics, refreshed when a gamepad announces itself. */
  capability: CapabilityProfile;

  /** Bumped on every edit, undo, redo or revert, so controls re-read. */
  revision: number;

  activePanel: AnimationPanelId;
  selectedStateId: string;
  selectedTransitionId: string;
  selectedReplayId: string;

  /** Resolved Motion Set context keys, replacing the static weapon catalogue. */
  motionContextId: string;

  /*
   * Replay, all of it subject-local (§10.1).
   *
   * `replays` is the repository's fixture set; everything below it belongs to
   * this session and dies with it. The route rebuilds the facade — and remounts
   * the chamber — on any change of subject identity, so none of this can be
   * carried into another subject's workspace.
   */
  replays: ReplayDefinition[];
  recordedReplays: ReplayDefinition[];
  ghostEnabled: boolean;
  compareSlots: AnimationCompareSlot[];
  activeCompareSlot: number;
}

export interface AnimationChamberActions {
  setPanel(panel: AnimationPanelId): void;
  setTerrainPreset(id: string): void;
  refreshCapability(capability: CapabilityProfile): void;
  selectState(id: string): void;
  selectTransition(id: string): void;
  selectReplay(id: string): void;
  setMotionContext(id: string): void;

  playSelectedReplay(): void;
  addRecordedReplay(replay: ReplayDefinition): void;
  setGhostEnabled(enabled: boolean): void;
  buildCompareSlots(): void;
  activateCompareSlot(index: number): void;

  setPreviewValue(path: CanonicalPath, value: unknown, options?: { intent?: string }): void;
  resetToRepository(path: CanonicalPath): void;
  resetToAiProposal(path: CanonicalPath): void;
  unlockPath(path: CanonicalPath): void;
  stage(path: CanonicalPath): void;
  stageAll(): void;
  undo(): void;
  redo(): void;
  revertSession(): void;

  /** Last refusal or hint, mirroring the legacy chamber's status line. */
  statusMessage: string;
  setStatus(message: string): void;
}

/**
 * One column of the A/B/C comparison.
 *
 * `document` is a chamber document rather than a resolved project, which is the
 * whole difference: a slot is a version of *this subject*, and switching to one
 * re-seeds the same engine rather than selecting a different Character.
 */
export interface AnimationCompareSlot {
  label: string;
  document: AnimationChamberDocument;
  trace: ReplayTrace | null;
}

export type AnimationChamberStore = StoreApi<AnimationChamberState & AnimationChamberActions>;

/**
 * The facade a route hands to the provider.
 *
 * `dispose` is not optional bookkeeping. A subject switch that leaves the old
 * session subscribed is how a panel ends up showing the previous Prefab's
 * frame, which §10.2 names as a defect in its own right.
 */
export interface AnimationChamberFacade {
  subject: AnimationSubjectDefinition;
  authoring: AnimationAuthoringSession;
  store: AnimationChamberStore;
  dispose(): void;
}

/** The replay the panel has selected, from either list. */
function selectedReplay(state: AnimationChamberState): ReplayDefinition | undefined {
  return [...state.replays, ...state.recordedReplays].find(
    (entry) => entry.id === state.selectedReplayId,
  );
}

/**
 * A chamber document is not a resolved project, so "resolved project
 * references" is not a claim about it. Structural validation of the graph the
 * document carries belongs to the asset resolver, which has already run by the
 * time a session exists — so the session-level validator reports success and
 * defers, rather than asserting something it cannot check.
 */
function validateChamberDocument(): ValidationResult {
  return { valid: true, issues: [] };
}

export function createAnimationChamberFacade(input: {
  authoring: AnimationAuthoringSession;
  repository: AnimationChamberRepositoryDefaults;
  engine: ChamberEngine;
  initialPanel?: AnimationPanelId;
}): AnimationChamberFacade {
  const { authoring, repository } = input;
  const document = materializeAnimationChamberDocument({
    resolved: authoring.resolved,
    repository,
  });
  const session = new EditSession<AnimationChamberDocument>(document, validateChamberDocument);
  const { engine } = input;

  const firstState = document.graph.states[0]?.id ?? '';
  const firstTransition = document.graph.transitions[0]?.id ?? '';

  const store = createStore<AnimationChamberState & AnimationChamberActions>()((set, get) => {
    /**
     * Every mutation funnels through here.
     *
     * The panels re-read the session rather than receiving values as props, so
     * what they need from a change is the signal that one happened; `revision`
     * is that signal, and routing all writes through one place is what stops a
     * new action from forgetting to send it.
     */
    const applied = (options: { syncEngine?: boolean } = {}): void => {
      const preview = session.previewProject;
      /*
       * The running simulation is part of "the preview", not a separate view of
       * it. Without this the panels would show an edited blend duration while
       * the body on screen kept playing the committed one — two documents, one
       * of which is invisible, which is the class of disagreement this whole
       * restoration exists to remove.
       *
       * Skipped for changes that cannot move a value: staging promotes an
       * existing preview value, and re-seeding the simulation for it would
       * restart the graph for no reason.
       */
      if (options.syncEngine !== false) engine.setProject(preview);
      set({
        revision: get().revision + 1,
        project: preview,
        previewDocument: preview,
      });
    };

    return {
      subject: authoring.subject,
      status: authoring.state,

      project: document,
      repositoryDocument: document,
      previewDocument: document,

      session,
      engine,

      terrainPresetId: engine.terrainPreset.id,
      capability: detectCapability(readActiveGamepad()),

      replays: repository.replays,
      recordedReplays: [],
      ghostEnabled: false,
      compareSlots: [],
      activeCompareSlot: -1,

      revision: 0,

      activePanel: input.initialPanel ?? 'inspector',
      selectedStateId: firstState,
      selectedTransitionId: firstTransition,
      selectedReplayId: '',
      motionContextId: document.motionContextKeys[0] ?? '',

      setPanel: (panel) => set({ activePanel: panel }),
      setTerrainPreset: (id) => {
        engine.setTerrainPreset(id);
        set({ terrainPresetId: id });
      },
      refreshCapability: (capability) => set({ capability }),

      playSelectedReplay: () => {
        const { replays: shipped, recordedReplays, selectedReplayId } = get();
        const replay = [...shipped, ...recordedReplays].find(
          (entry) => entry.id === selectedReplayId,
        );
        if (!replay) return;
        // A replay was recorded on a terrain, and playing it anywhere else
        // reproduces different contacts from the same inputs.
        engine.setTerrainPreset(replay.terrainPresetId);
        engine.playReplay(replay);
        set({ terrainPresetId: replay.terrainPresetId });
      },

      addRecordedReplay: (replay) =>
        set({
          recordedReplays: [...get().recordedReplays, replay],
          selectedReplayId: replay.id,
          statusMessage: `Recorded ${replay.tickCount} ticks as "${replay.id}".`,
        }),

      setGhostEnabled: (enabled) => {
        const replay = selectedReplay(get());
        /*
         * The ghost is the *repository* run of the same replay, which is what
         * makes it a before/after: comparing the preview against itself would
         * draw two identical bodies.
         */
        engine.setGhost(
          enabled && replay ? engine.traceFor(session.repositoryProject, replay) : null,
        );
        set({ ghostEnabled: enabled });
      },

      buildCompareSlots: () => {
        const replay = selectedReplay(get());
        if (!replay) return;
        const slots: AnimationCompareSlot[] = [
          {
            label: 'Repository',
            document: session.repositoryProject,
            trace: engine.traceFor(session.repositoryProject, replay),
          },
          {
            label: 'Preview',
            document: session.previewProject,
            trace: engine.traceFor(session.previewProject, replay),
          },
        ];
        set({ compareSlots: slots, activeCompareSlot: 0 });
      },

      activateCompareSlot: (index) => {
        const slot = get().compareSlots[index];
        if (!slot) return;
        // An instant A/B/C switch is a re-seed of the one engine, not a second
        // preview — which is what keeps the one-viewport rule intact.
        engine.setProject(slot.document);
        set({ activeCompareSlot: index, statusMessage: `Previewing: ${slot.label}` });
      },
      selectState: (id) => set({ selectedStateId: id }),
      selectTransition: (id) => set({ selectedTransitionId: id }),
      selectReplay: (id) => set({ selectedReplayId: id }),
      setMotionContext: (id) => {
        /*
         * The engine resolves clips by context too, so setting it here only
         * would leave the viewport drawing one context's takes while the
         * simulation played another's.
         *
         * Any key is accepted, known to the presentation catalogue or not:
         * contextual bindings are data on the Motion Set, and refusing a key
         * the catalogue has not heard of would hide a context the subject
         * genuinely binds. What the catalogue governs is the held item, and
         * that is the viewport's problem to state.
         */
        engine.setWeaponModeId(id);
        set({ motionContextId: id });
      },

      statusMessage: '',
      setStatus: (message) => set({ statusMessage: message }),

      setPreviewValue: (path, value, options) => {
        const outcome = session.setPreviewValue({
          path,
          value,
          actor: 'human',
          ...(options?.intent ? { intent: options.intent } : {}),
          replayId: get().selectedReplayId,
        });
        // A refusal is a protection decision, not a failure to record: the
        // preview must not move, and the human is told why.
        if (!outcome.applied) {
          set({ statusMessage: `Refused: ${outcome.reason}` });
          return;
        }
        applied();
        if (session.fieldView(path).needsSave) {
          set({
            statusMessage: 'Changed since staged. Save again to update the staged draft.',
          });
        }
      },
      resetToRepository: (path) => {
        session.resetToRepository(path);
        applied();
      },
      resetToAiProposal: (path) => {
        session.resetToAiProposal(path);
        applied();
      },
      unlockPath: (path) => {
        session.unlock(path);
        set({
          statusMessage: `Unlocked ${path} for this session only. It stays locked in the repository.`,
          revision: get().revision + 1,
        });
      },
      stage: (path) => {
        session.stage(path);
        applied({ syncEngine: false });
      },
      stageAll: () => {
        session.stageAll();
        applied({ syncEngine: false });
      },
      undo: () => {
        session.undo();
        applied();
      },
      redo: () => {
        session.redo();
        applied();
      },
      revertSession: () => {
        session.revertSession();
        applied();
      },
    };
  });

  return {
    subject: authoring.subject,
    authoring,
    store,
    dispose: () => authoring.dispose(),
  };
}

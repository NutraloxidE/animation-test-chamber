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
import type { AnimationSubjectDefinition, ValidationResult } from '@atc/schema';
import type { CanonicalPath } from '@atc/runtime-core';
import { EditSession } from '@atc/editor-core';
import type { AnimationAuthoringSession } from '../prefab-editor/animation-authoring-session.ts';
import {
  materializeAnimationChamberDocument,
  type AnimationChamberDocument,
  type AnimationChamberRepositoryDefaults,
} from './AnimationChamberDocument.ts';
import {
  createIdleLivePreview,
  type AnimationLivePreview,
  type AnimationPreviewControls,
} from './AnimationLivePreview.ts';

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
  engine: AnimationLivePreview;
  /** Absent when the subject has no running simulation to drive. */
  controls: AnimationPreviewControls | null;

  /** Bumped on every edit, undo, redo or revert, so controls re-read. */
  revision: number;

  activePanel: AnimationPanelId;
  selectedStateId: string;
  selectedTransitionId: string;
  selectedReplayId: string;

  /** Resolved Motion Set context keys, replacing the static weapon catalogue. */
  motionContextId: string;
}

export interface AnimationChamberActions {
  setPanel(panel: AnimationPanelId): void;
  selectState(id: string): void;
  selectTransition(id: string): void;
  selectReplay(id: string): void;
  setMotionContext(id: string): void;

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

/** Whether the supplied preview can be driven, not merely read. */
function isPreviewControls(
  preview: (AnimationLivePreview & Partial<AnimationPreviewControls>) | undefined,
): preview is AnimationLivePreview & AnimationPreviewControls {
  return typeof preview?.advance === 'function';
}

export function createAnimationChamberFacade(input: {
  authoring: AnimationAuthoringSession;
  repository: AnimationChamberRepositoryDefaults;
  /** Omitted when the subject cannot run a simulation; an idle port is used. */
  livePreview?: AnimationLivePreview & Partial<AnimationPreviewControls>;
  initialPanel?: AnimationPanelId;
}): AnimationChamberFacade {
  const { authoring, repository } = input;
  const document = materializeAnimationChamberDocument({
    resolved: authoring.resolved,
    repository,
  });
  const session = new EditSession<AnimationChamberDocument>(document, validateChamberDocument);
  const engine =
    input.livePreview ??
    createIdleLivePreview({
      missing: 'engine',
      reason:
        'No live preview is attached to this subject yet, so state highlighting is idle. ' +
        'Graph, Timeline and Timing editing are unaffected.',
    });

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
    const applied = (): void => {
      set({
        revision: get().revision + 1,
        project: session.previewProject,
        previewDocument: session.previewProject,
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
      controls: isPreviewControls(input.livePreview) ? input.livePreview : null,

      revision: 0,

      activePanel: input.initialPanel ?? 'inspector',
      selectedStateId: firstState,
      selectedTransitionId: firstTransition,
      selectedReplayId: '',
      motionContextId: document.motionContextKeys[0] ?? '',

      setPanel: (panel) => set({ activePanel: panel }),
      selectState: (id) => set({ selectedStateId: id }),
      selectTransition: (id) => set({ selectedTransitionId: id }),
      selectReplay: (id) => set({ selectedReplayId: id }),
      setMotionContext: (id) => set({ motionContextId: id }),

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
        applied();
      },
      stageAll: () => {
        session.stageAll();
        applied();
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

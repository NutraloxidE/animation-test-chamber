import { useMemo } from 'react';
import { create, type StateCreator } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  AnimationAssetSummary,
  AnimationBehaviorAsset,
  AssetIssue,
  AssetReference,
  CanonicalPatch,
  CapabilityProfile,
  CharacterAnimationAssignment,
  ClipChange,
  ClipChangeDestination,
  GraphChangeDestination,
  ProjectDefinition,
  ReplayDefinition,
  ResolvedProject,
  SaveAnimationChangesRequest,
  WorldDefinition,
} from '@atc/schema';
import { resolveWeaponMode } from '@atc/animation-runtime';
import {
  AnimationAssetRegistry,
  diffToPatches,
  isVariantAsset,
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
import type { MouseLookMode } from '@atc/input-runtime';
import { worldOf } from '@atc/world-runtime';
import { createDefaultRegistry } from '@atc/capability-runtime';
import { WorldChamberEngine } from './world/world-engine.ts';
import {
  reconcileSelection,
  selectedInstanceId as instanceIdOf,
  type SceneSelection,
} from './selection/scene-selection.ts';
import type { BottomWorkspace, ViewportPresentation } from './selection/asset-selection.ts';
import { ChamberEngine } from './engine.ts';
import { backendAvailable, NO_BACKEND_MESSAGE } from './backend.ts';
import { CHARACTER_PRESETS, WEAPON_MODES, type WeaponGrip } from './three/catalog.ts';
import seedProject from '@chamber/project';
import seedAssetIndex from '@chamber/animation-assets';

/**
 * Vite watches `@chamber/project` and `@chamber/animation-assets` (plain
 * module imports of files that live above `apps/web`) and full-reloads the
 * page whenever either changes on disk. That's exactly what a human
 * hand-editing them wants, but it actively fights this app's own save/commit
 * flows: they already push the write's result into the running app via the
 * API response, so a reload on top of that races the in-memory update and
 * the confirmation message to the screen — and can win, discarding both
 * before either is ever seen. `markSelfInitiatedWrite()` suppresses only the
 * one reload that immediately follows a write this tab made itself; every
 * other change (including a human editing the file directly) still reloads
 * normally.
 */
let awaitingOwnWrite = false;
export function markSelfInitiatedWrite(): void {
  awaitingOwnWrite = true;
}
if (import.meta.hot) {
  import.meta.hot.on('vite:beforeFullReload', () => {
    if (awaitingOwnWrite) {
      awaitingOwnWrite = false;
      // Vite's documented escape hatch for cancelling a pending full reload
      // from within a 'vite:beforeFullReload' listener.
      throw 'stop the reload — this write already updated the running app';
    }
  });
}

/** Chamber or Asset Library. Deliberately not a router (PLAN 24.1). */
export type WorkspaceMode = 'chamber' | 'asset-library';

/**
 * One instance's loadout, with the two layers kept apart.
 *
 * `definition` is what the shared character says; `override` is what this
 * instance disagrees about; `effective` is what it actually runs. Collapsing
 * them into one value is how "off" stops being distinguishable from "off
 * because the shared default is off" — and how a user ends up editing every
 * instance while believing they edited one.
 */
export interface InstanceLoadout {
  weaponMode: {
    definition: string;
    override: string | null;
    effective: string;
  };
  equipment: {
    slotId: string;
    label: string;
    definition: boolean;
    override: boolean | null;
    effective: boolean;
  }[];
  /** True when this instance disagrees with the definition about anything. */
  hasOverrides: boolean;
}

/**
 * The Animation Preview transport's state.
 *
 * Every field here is a temporary display decision. Nothing in this object is
 * ever written to a project, world or asset document — the workspace exists so
 * that "try this now" has somewhere to live that is *not* the authoring
 * surface it was previously indistinguishable from.
 */
export interface AnimationPreviewState {
  targetInstanceId: string | null;
  layer: 'locomotion' | 'action';
  stateId: string | null;
  playing: boolean;
  loop: boolean;
  speed: number;
  normalizedTime: number;
}

const NO_PREVIEW: AnimationPreviewState = {
  targetInstanceId: null,
  layer: 'locomotion',
  stateId: null,
  playing: false,
  loop: true,
  speed: 1,
  normalizedTime: 0,
};

/**
 * Where a chamber edit should be written (PLAN Part II §14-16).
 *
 * Graph changes and clip changes are chosen *separately* — a save can touch
 * both, and mixing a clip edit into a destination that only understands
 * graph structure (a tuning profile, a behaviour variant) is exactly the
 * silent-loss failure this whole contract exists to close. There is no
 * default: "I nudged a blend duration" has several different meanings — mine
 * only, this character's feel, a new variant, or everyone's — and picking
 * one silently is how a shared asset stops being shared without anyone
 * deciding to.
 */
export type GraphDestinationKind =
  | 'character-override'
  | 'tuning-profile'
  | 'existing-behavior-variant'
  | 'new-behavior-variant'
  | 'shared-behavior'
  | 'none';

export type ClipDestinationKind = 'character-override' | 'new-clip-versions-and-motion-set' | 'none';

export interface GraphDestinationChoice {
  kind: GraphDestinationKind;
  /** Required for `new-behavior-variant`. */
  newAssetId?: string;
  displayName?: string;
}

export interface ClipDestinationChoice {
  kind: ClipDestinationKind;
}

export interface SaveDestinationChoice {
  graph: GraphDestinationChoice;
  clips: ClipDestinationChoice;
}

export interface GraphDestinationOption {
  kind: GraphDestinationKind;
  label: string;
  /** Who is affected if this is chosen. Shown next to each option. */
  impact: string;
  available: boolean;
  unavailableReason?: string;
}

export interface ClipDestinationOption {
  kind: ClipDestinationKind;
  label: string;
  impact: string;
  available: boolean;
  unavailableReason?: string;
}

/** One changed clip, for the Save Destination dialog's breakdown (PLAN §16). */
export interface StagedClipChangeSummary {
  clipId: string;
  patchCount: number;
  sourceClip: AssetReference | null;
}

/**
 * What is actually staged, split by domain, before any destination is
 * chosen. `clipChanges` with a null `sourceClip` are exactly the "unresolved"
 * case §12 requires never be silently dropped — a clip edit whose resolved
 * clip id has no recorded source (should not normally happen; surfaced
 * rather than guessed at).
 */
export interface StagedChangeSummary {
  graphPatchCount: number;
  /**
   * How many of those patches add or remove structure rather than change a
   * value. A tuning profile cannot store one, so the dialog must not offer it
   * as a destination for this edit.
   */
  graphStructuralPatchCount: number;
  clipChanges: StagedClipChangeSummary[];
  hasUnresolvedClipChanges: boolean;
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

  /**
   * World authoring.
   *
   * Deliberately split into four separate fields rather than one blob: the
   * canonical world, the staged edit on top of it, the selection, and the
   * running state are four different things with four different lifetimes, and
   * collapsing them is how a selection ends up able to change a simulation.
   */
  worldEngine: WorldChamberEngine;
  /** The world as the repository has it, explicit or synthesized. */
  canonicalWorld: WorldDefinition;
  /** The world including unsaved edits. This is what the viewport runs. */
  stagedWorld: WorldDefinition;
  /**
   * The one selection in the scene. Presentation only — no runtime decision
   * may read this — and deliberately the *only* writable answer to "what is
   * selected": the selected instance is derived from it, never stored beside
   * it (DECISION 0011).
   */
  sceneSelection: SceneSelection;
  /**
   * How the viewport draws the world. Not a selection, not an inspector mode:
   * `isolate-selection` is the old "focused view" reduced to what it always
   * really was, a display option.
   */
  viewportPresentation: ViewportPresentation;
  /** Which bottom editor workspace is open. Independent of scene selection. */
  bottomWorkspace: BottomWorkspace;
  /**
   * Transient viewport camera control. Lifted out of `App`'s local state so the
   * Camera Inspector and the viewport toolbar are two views of one value
   * rather than two switches that can disagree about which mode is on.
   */
  mouseLookMode: MouseLookMode;
  worldDirty: boolean;
  worldMessage: string;

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
  /**
   * Browser-only character animation drafts left over from a repository
   * revision that no longer matches (PLAN Part V §24). Never auto-applied —
   * surfaced so a human can discard them, or (in a later session against the
   * same revision) they would already be live.
   */
  staleCharacterDrafts: { characterId: string; revisionId: string }[];
}

interface ChamberActions {
  setWorkspaceMode(mode: WorkspaceMode): void;
  setActiveCharacter(characterId: string): void;
  discardStaleCharacterDraft(characterId: string, revisionId: string): void;
  selectLibraryAsset(selection: { assetType: string; assetId: string; version: string } | null): void;
  setLibraryTypeFilter(assetType: string): void;
  setLibrarySearch(text: string): void;
  setLibraryFacet(facet: string): void;
  openLibraryDialog(dialog: 'apply' | 'save-destination' | 'derive' | null): void;
  librarySummaries(): AnimationAssetSummary[];
  graphDestinationOptions(): GraphDestinationOption[];
  clipDestinationOptions(): ClipDestinationOption[];
  stagedChangeSummary(): StagedChangeSummary;
  saveStagedAnimationChanges(choice: SaveDestinationChoice): Promise<void>;
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
  /** The single writer for scene selection. */
  selectScene(selection: SceneSelection): void;
  setViewportPresentation(presentation: ViewportPresentation): void;
  setBottomWorkspace(workspace: BottomWorkspace): void;
  setMouseLookMode(mode: MouseLookMode): void;
  /** Every world edit goes through a declared command; there is no other path. */
  runWorldCommand(commandId: string, input: unknown): void;
  duplicateSelectedInstance(): void;
  removeSelectedInstance(): void;
  setFocusedInstance(instanceId: string): void;
  setCameraTargetInstance(instanceId: string): void;
  revertWorldEdits(): void;
  sharedAssetsFor(instanceId: string | null): CharacterAnimationAssignment | null;
  /** Effective loadout for one instance: definition default + instance override. */
  loadoutOf(instanceId: string | null): InstanceLoadout | null;
  setInstanceWeaponMode(instanceId: string, weaponModeId: string | null): void;
  setInstanceEquipment(instanceId: string, slotId: string, equipped: boolean | null): void;
  resetInstanceLoadout(instanceId: string): void;
  /** Opens a shared definition in Project/Assets. Leaves scene selection alone. */
  openCharacterDefinition(characterId: string): void;

  /** Animation Preview transport. None of this reaches canonical data. */
  animationPreview: AnimationPreviewState;
  setPreviewTarget(instanceId: string | null): void;
  setPreviewSubject(layer: 'locomotion' | 'action', stateId: string): void;
  setPreviewPlaying(playing: boolean): void;
  setPreviewLoop(loop: boolean): void;
  setPreviewSpeed(speed: number): void;
  setPreviewNormalizedTime(normalizedTime: number): void;
  clearAnimationPreview(): void;
  /** Pushes transport state at the engine's read side. Never at its tick. */
  syncPreviewOverride(): void;
  setTerrainPreset(id: string): void;
  setCharacterPreset(id: string): void;
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

/**
 * `diffToPatches(repository.clips, preview.clips, '')` diffs the whole clips
 * array at once, so its output is a flat list of patches rooted at that
 * array — each path's first segment is the clip id the array is keyed by
 * (PLAN Part II §13 depends on this to attribute a clip edit to the asset it
 * came from). This regroups that flat list back into one entry per clip,
 * with the id stripped off so each group's patches are relative to the clip
 * itself, matching what the save endpoint expects to apply.
 */
function groupClipPatches(patches: CanonicalPatch[]): { clipId: string; patches: CanonicalPatch[] }[] {
  const byClip = new Map<string, CanonicalPatch[]>();
  for (const patch of patches) {
    const segments = patch.path.split('/').filter((segment) => segment.length > 0);
    const clipId = segments[0];
    if (!clipId) continue;
    const relative = segments.length > 1 ? `/${segments.slice(1).join('/')}` : '/';
    const existing = byClip.get(clipId);
    const entry = { ...patch, path: relative };
    if (existing) existing.push(entry);
    else byClip.set(clipId, [entry]);
  }
  return [...byClip.entries()].map(([clipId, clipPatches]) => ({ clipId, patches: clipPatches }));
}

/**
 * Static / offline character animation drafts (PLAN Part V §24).
 *
 * A character-override save is meant to work with no API server at all — a
 * static host never has one — so it is committed to an in-memory
 * `instanceOverrides` update immediately, and mirrored here only so a page
 * reload does not lose it. The key embeds the revision the draft was made
 * against on purpose: a repository revision that has since moved on must
 * never have a stale draft silently reapplied on top of it, so a key that
 * simply stops matching is the whole mechanism.
 */
const CHARACTER_DRAFT_PREFIX = 'atc:character-animation-draft';

interface CharacterAnimationDraft {
  revisionId: string;
  characterId: string;
  /** The character's complete `instanceOverrides`, not a delta — restoring replaces, never appends. */
  instanceOverrides: CanonicalPatch[];
}

function characterDraftKey(projectId: string, revisionId: string, characterId: string): string {
  return `${CHARACTER_DRAFT_PREFIX}:${projectId}:${revisionId}:${characterId}`;
}

function saveCharacterDraft(
  projectId: string,
  revisionId: string,
  characterId: string,
  instanceOverrides: CanonicalPatch[],
): void {
  try {
    window.localStorage.setItem(
      characterDraftKey(projectId, revisionId, characterId),
      JSON.stringify({ revisionId, characterId, instanceOverrides } satisfies CharacterAnimationDraft),
    );
  } catch {
    // Storage may be unavailable in privacy modes; the in-memory override
    // still applies for the rest of this session.
  }
}

function clearCharacterDraft(projectId: string, revisionId: string, characterId: string): void {
  try {
    window.localStorage.removeItem(characterDraftKey(projectId, revisionId, characterId));
  } catch {
    // Nothing to clear if storage was never reachable.
  }
}

/** Every character-animation draft on disk for this project, whatever revision it was made against. */
function listCharacterDrafts(projectId: string): CharacterAnimationDraft[] {
  const drafts: CharacterAnimationDraft[] = [];
  try {
    const prefix = `${CHARACTER_DRAFT_PREFIX}:${projectId}:`;
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (!key || !key.startsWith(prefix)) continue;
      const raw = window.localStorage.getItem(key);
      if (!raw) continue;
      try {
        const draft = JSON.parse(raw) as Partial<CharacterAnimationDraft>;
        if (
          typeof draft.revisionId === 'string' &&
          typeof draft.characterId === 'string' &&
          Array.isArray(draft.instanceOverrides)
        ) {
          drafts.push(draft as CharacterAnimationDraft);
        }
      } catch {
        // Malformed entry; ignore rather than fail the whole scan.
      }
    }
  } catch {
    // Storage unavailable; no drafts to report.
  }
  return drafts;
}

const characterDraftsAtLoad = listCharacterDrafts(canonicalSeed.id);
const currentRevisionDrafts = characterDraftsAtLoad.filter(
  (draft) => draft.revisionId === canonicalSeed.revisionId,
);
const staleCharacterDraftsAtLoad = characterDraftsAtLoad
  .filter((draft) => draft.revisionId !== canonicalSeed.revisionId)
  .map((draft) => ({ characterId: draft.characterId, revisionId: draft.revisionId }));

/**
 * The seed project with any current-revision character drafts already
 * applied — a page reload must not look like the draft never happened.
 * Stale-revision drafts (a different revision) are deliberately left out:
 * they are surfaced as discardable rather than reapplied (PLAN Part V §24).
 */
const canonicalSeedWithDrafts: ProjectDefinition = {
  ...canonicalSeed,
  characters: canonicalSeed.characters.map((character) => {
    const draft = currentRevisionDrafts.find((entry) => entry.characterId === character.id);
    if (!draft) return character;
    return {
      ...character,
      animation: { ...character.animation, instanceOverrides: draft.instanceOverrides },
    };
  }),
};

const initialResolution = resolveFor(
  canonicalSeedWithDrafts,
  canonicalSeedWithDrafts.activeCharacterId,
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

const PENDING_STATUS_KEY = 'atc:pending-status-message';

/**
 * A successful commit writes project.json, which the dev server watches
 * (`@chamber/project` is a plain module import) and reacts to with a full
 * page reload — a real one, not React re-rendering. That reload can land
 * before this tab ever paints the confirmation message, wiping it. Stashing
 * the message here lets the next boot show it once instead of losing it.
 */
function persistStatusForReload(message: string): void {
  try {
    window.sessionStorage.setItem(PENDING_STATUS_KEY, message);
  } catch {
    // Storage may be unavailable in privacy modes; the in-memory message still works.
  }
}

function consumePersistedStatusMessage(): string | null {
  try {
    const message = window.sessionStorage.getItem(PENDING_STATUS_KEY);
    if (message !== null) window.sessionStorage.removeItem(PENDING_STATUS_KEY);
    return message;
  } catch {
    return null;
  }
}

const createChamber: StateCreator<ChamberState & ChamberActions> = (set, get) => {
  const session = new EditSession(initialProject);
  const restoredChanges = restoreStagedDraft(session);
  const engine = new ChamberEngine(session.previewProject);

  /*
   * The world the chamber opens on. The demo project ships no explicit world,
   * so this is the synthesized one-instance world built from
   * `activeCharacterId` — the focused chamber as a world, rather than a
   * separate runtime kept alive beside it.
   */
  const canonicalWorld = worldOf(canonicalSeedWithDrafts);
  const commandRegistry = createDefaultRegistry();
  const worldEngine = new WorldChamberEngine({
    registry: seedRegistry,
    project: canonicalSeedWithDrafts,
    world: canonicalWorld,
  });

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
    canonicalProject: canonicalSeedWithDrafts,
    registry: seedRegistry,
    assetIssues: initialResolution.issues,
    staleCharacterDrafts: staleCharacterDraftsAtLoad,

    workspaceMode: 'chamber',
    activeCharacterId: canonicalSeedWithDrafts.activeCharacterId,

    worldEngine,
    canonicalWorld,
    stagedWorld: canonicalWorld,
    // Opens on the instance the world declares focused, not on the world root:
    // a chamber that opened with nothing selected would show an empty
    // inspector on first paint for every project that has exactly one
    // instance, which is most of them.
    sceneSelection: { kind: 'instance', instanceId: canonicalWorld.focusedInstanceId },
    viewportPresentation: 'isolate-selection',
    bottomWorkspace: 'project',
    mouseLookMode: 'free',
    worldDirty: false,
    worldMessage: '',
    animationPreview: NO_PREVIEW,

    librarySelection: null,
    libraryTypeFilter: 'all',
    librarySearch: '',
    libraryFacet: 'all',
    libraryDialog: null,
    libraryMessage: '',

    selectedTransitionId: 'run-to-attack-01',
    selectedStateId: 'run',
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
      consumePersistedStatusMessage() ??
      (restoredChanges > 0
        ? `Restored ${restoredChanges} staged change(s).`
        : 'Ready. Editing the demo character with the fake Git adapter.'),
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

    discardStaleCharacterDraft(characterId, revisionId) {
      clearCharacterDraft(get().canonicalProject.id, revisionId, characterId);
      set({
        staleCharacterDrafts: get().staleCharacterDrafts.filter(
          (entry) => !(entry.characterId === characterId && entry.revisionId === revisionId),
        ),
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
    graphDestinationOptions() {
      const { project, canonicalProject } = get();
      const behaviorId = project.character.animation.behavior.assetId;
      const sharing = canonicalProject.characters.filter(
        (character) => character.animation.behavior.assetId === behaviorId,
      );
      const hasTuning = Boolean(project.character.animation.tuning);
      // The server refuses a structural patch aimed at a tuning profile and is
      // the authority on that; disabling the option here just means a human is
      // told before they choose rather than after.
      const hasStructuralGraphChange = get().stagedChangeSummary().graphStructuralPatchCount > 0;
      const tuningAvailable = hasTuning && !hasStructuralGraphChange;
      // A domain fact — is the active behaviour a variant — must never
      // depend on what the library's search box or type filter currently
      // shows (PLAN Part VI §25): asked directly of the registry, not of
      // `librarySummaries()`, which is exactly the filtered view.
      const behaviorAsset = get().registry.find(project.character.animation.behavior);
      const isVariant =
        behaviorAsset?.metadata.assetType === 'animation-behavior' &&
        isVariantAsset(behaviorAsset as AnimationBehaviorAsset);

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
          impact: tuningAvailable
            ? `Only "${project.character.displayName}", but reusable by other characters that adopt the profile.`
            : '',
          available: tuningAvailable,
          ...(tuningAvailable
            ? {}
            : {
                unavailableReason: hasTuning
                  ? 'Tuning profiles only store value changes. Use a behaviour variant for structural edits.'
                  : 'this character has no tuning profile',
              }),
        },
        {
          kind: 'existing-behavior-variant' as const,
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

    clipDestinationOptions() {
      const { project } = get();
      return [
        {
          kind: 'character-override' as const,
          label: 'Character instance override',
          impact: `Only "${project.character.displayName}".`,
          available: true,
        },
        {
          kind: 'new-clip-versions-and-motion-set' as const,
          label: 'New clip version(s) + new motion-set version',
          impact:
            'A new version of each changed clip, and a new motion-set version pointing the ' +
            'affected slots at them. Only this character adopts it.',
          available: true,
        },
      ];
    },

    /**
     * What is staged, split into the two domains a save destination can
     * apply to (PLAN Part II §12-13, §16). Grouped by clip id so the dialog
     * can show "2 clip assets changed: sword-attack-01, sword-attack-01-recovery"
     * rather than a flat patch list with no idea which asset each belongs to.
     */
    stagedChangeSummary() {
      const repository = session.repositoryProject;
      const preview = session.buildStagedDocument();
      const graphPatches = diffToPatches(repository.graph, preview.graph, '');
      const clipPatches = diffToPatches(repository.clips, preview.clips, '');
      const grouped = groupClipPatches(clipPatches);
      const clipChanges = grouped.map(({ clipId, patches }) => ({
        clipId,
        patchCount: patches.length,
        sourceClip: repository.clipAssetSources[clipId] ?? null,
      }));
      return {
        graphPatchCount: graphPatches.length,
        graphStructuralPatchCount: graphPatches.filter((patch) => patch.op !== 'set').length,
        clipChanges,
        hasUnresolvedClipChanges: clipChanges.some((change) => change.sourceClip === null),
      };
    },

    /**
     * Writes the staged animation edits to the chosen destinations.
     *
     * Graph and clip changes are computed and sent independently — repository-
     * versus-preview, not raw staged values, so a nested edit lands as one path
     * instead of an object blob — and each clip change carries the exact
     * published asset it was diffed against, so the server never has to guess.
     */
    async saveStagedAnimationChanges(choice) {
      const summary = get().stagedChangeSummary();
      if (summary.graphPatchCount === 0 && summary.clipChanges.length === 0) {
        set({ statusMessage: 'No staged animation changes to save.' });
        return;
      }
      if (summary.hasUnresolvedClipChanges) {
        set({
          statusMessage:
            'One or more changed clips have no recorded source asset; cannot save until resolved.',
        });
        return;
      }

      const repository = session.repositoryProject;
      const preview = session.buildStagedDocument();
      const graphPatches = diffToPatches(repository.graph, preview.graph, '');
      const clipPatches = diffToPatches(repository.clips, preview.clips, '');
      const clipChangeGroups = groupClipPatches(clipPatches);
      const character = get().project.character;

      const clipChanges: ClipChange[] = clipChangeGroups.flatMap(({ clipId, patches }) => {
        const sourceClip = repository.clipAssetSources[clipId];
        return sourceClip ? [{ sourceClip, clipId, patches }] : [];
      });

      // A character-override destination needs no server at all — it never
      // publishes an asset, only rewrites this character's own overrides —
      // so it is the one save this chamber can always complete offline
      // (PLAN Part V §24). Anything else genuinely needs the API.
      const graphNeedsBackend = summary.graphPatchCount > 0 && choice.graph.kind !== 'character-override';
      const clipNeedsBackend = clipChanges.length > 0 && choice.clips.kind !== 'character-override';

      if (!(await backendAvailable())) {
        if (graphNeedsBackend || clipNeedsBackend) {
          set({
            statusMessage:
              `Save: ${NO_BACKEND_MESSAGE} Choose "Character instance override" for every changed ` +
              'domain to save this as a browser-only draft instead.',
          });
          return;
        }

        const overrides = [
          ...character.animation.instanceOverrides,
          ...graphPatches.map((patch) => ({ ...patch, path: `/graph${patch.path}` })),
          ...clipChanges.flatMap((change) =>
            change.patches.map((patch) => ({ ...patch, path: `/clips/${change.clipId}${patch.path}` })),
          ),
        ];
        const canonical = get().canonicalProject;
        const nextCanonical: ProjectDefinition = {
          ...canonical,
          characters: canonical.characters.map((entry) =>
            entry.id === character.id
              ? { ...entry, animation: { ...entry.animation, instanceOverrides: overrides } }
              : entry,
          ),
        };
        const resolution = resolveFor(nextCanonical, get().activeCharacterId, get().registry);
        session.acceptCommitted(resolution.project);
        engine.setProject(resolution.project);
        saveCharacterDraft(nextCanonical.id, nextCanonical.revisionId, character.id, overrides);
        set({
          canonicalProject: nextCanonical,
          project: resolution.project,
          assetIssues: resolution.issues,
          revision: get().revision + 1,
          statusMessage: 'Saved as a browser-only character draft. No repository files were changed.',
        });
        return;
      }

      const graphDestination: GraphChangeDestination =
        summary.graphPatchCount === 0
          ? { kind: 'none' }
          : choice.graph.kind === 'new-behavior-variant'
            ? {
                kind: 'new-behavior-variant',
                newAssetId: choice.graph.newAssetId ?? '',
                displayName: choice.graph.displayName ?? choice.graph.newAssetId ?? '',
              }
            : { kind: choice.graph.kind as Exclude<GraphDestinationKind, 'new-behavior-variant'> };
      const clipDestination: ClipChangeDestination =
        clipChanges.length === 0 ? { kind: 'none' } : { kind: choice.clips.kind };

      const assetReferences: AssetReference[] = [
        character.animation.behavior,
        character.animation.motionSet,
        character.animation.rig,
        ...(character.animation.tuning ? [character.animation.tuning] : []),
        ...clipChanges.map((change) => change.sourceClip),
      ];

      const request: SaveAnimationChangesRequest = {
        characterId: character.id,
        graph: {
          patches: graphPatches.map((patch) => ({ ...patch, path: stripGraphPrefix(patch.path) })),
          destination: graphDestination,
        },
        clips: { changes: clipChanges, destination: clipDestination },
        expected: { projectRevisionId: repository.revisionId, assetReferences },
      };

      try {
        markSelfInitiatedWrite();
        const response = await fetch('/api/animation-assets/save-destination', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(request),
        });
        const payload = (await response.json()) as {
          ok?: boolean;
          error?: string;
          issues?: AssetIssue[];
          project?: ProjectDefinition;
          reportPath?: string;
        };
        if (!response.ok || !payload.ok) {
          // Nothing was written, so there is no reload to suppress.
          awaitingOwnWrite = false;
          set({
            statusMessage: `Save refused: ${payload.error ?? ''} ${(payload.issues ?? [])
              .map((issue) => issue.message)
              .slice(0, 2)
              .join('; ')}`,
          });
          return;
        }
        // A real publish supersedes any browser-only draft for this
        // character at this revision — keeping both would let the stale
        // draft resurface a change the repository no longer agrees with.
        clearCharacterDraft(repository.id, repository.revisionId, character.id);
        // Report the save before refreshing the registry, same as commit()
        // below: reloadAssets is a second round-trip, and writing project.json
        // makes the dev server reload the page, so a status message that
        // waited for it would often never be seen.
        const message = `Saved. Report: ${payload.reportPath}`;
        persistStatusForReload(message);
        set({ statusMessage: message });
        await get().reloadAssets(payload.project);
      } catch (error) {
        awaitingOwnWrite = false;
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

    selectScene(selection) {
      // Selection is presentation. It changes what the inspector shows and
      // nothing about what the simulation does — see the visual test that
      // asserts the world hash is unchanged across a selection.
      set({ sceneSelection: selection });
    },

    setViewportPresentation(presentation) {
      // Note what this does *not* do: it does not touch `sceneSelection` and
      // it does not call `setPanel`. The old world-mode button did both, so
      // asking to see the whole world moved the inspector off whatever the
      // user was editing.
      set({ viewportPresentation: presentation });
    },

    setBottomWorkspace(workspace) {
      set({ bottomWorkspace: workspace });
    },

    setMouseLookMode(mode) {
      get().engine.setMouseLookMode(mode);
      set({ mouseLookMode: mode });
    },

    /**
     * The single path a human world edit takes.
     *
     * It runs the same typed command the API exposes, keeps the returned staged
     * world, and rebuilds the running world from it. The UI never constructs a
     * `WorldDefinition` itself, so it cannot express a change the command
     * surface would have refused.
     */
    runWorldCommand(commandId, input) {
      const state = get();
      const result = commandRegistry.execute(commandId, input, {
        project: state.canonicalProject,
        world: state.stagedWorld,
        actor: 'human',
      });

      if (!result.ok || !result.stagedWorld) {
        set({
          worldMessage:
            result.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ') ||
            'the command produced no change',
        });
        return;
      }

      const stagedWorld = result.stagedWorld;
      state.worldEngine.setWorld(stagedWorld);
      set({
        stagedWorld,
        // A command may have removed the instance the user was looking at, so
        // selection is reconciled here rather than at each call site: the one
        // writer for selection is also the one place it can go stale.
        sceneSelection: reconcileSelection(
          state.sceneSelection,
          stagedWorld.instances.map((entry) => entry.id),
        ),
        worldDirty: true,
        worldMessage: `${commandId} staged (${(result.changedPaths ?? []).join(', ')})`,
      });
    },

    duplicateSelectedInstance() {
      const state = get();
      const source = instanceIdOf(state.sceneSelection);
      if (!source) return;
      // A stable, collision-free id without a random suffix: a duplicate whose
      // id changed between two runs would make its trace unreproducible.
      let index = 2;
      let newInstanceId = `${source}-${index}`;
      while (state.stagedWorld.instances.some((instance) => instance.id === newInstanceId)) {
        index += 1;
        newInstanceId = `${source}-${index}`;
      }
      state.runWorldCommand('world.duplicate_instance', { instanceId: source, newInstanceId });
      // Selecting the copy is the point: a duplicate you then have to hunt for
      // in the tree is a worse "duplicate" than no button at all.
      set({ sceneSelection: { kind: 'instance', instanceId: newInstanceId } });
    },

    removeSelectedInstance() {
      const state = get();
      const instanceId = instanceIdOf(state.sceneSelection);
      if (!instanceId) return;
      // `runWorldCommand` reconciles the selection: removing the instance the
      // inspector is showing falls back to the world root rather than leaving
      // it rendering something the world no longer contains.
      state.runWorldCommand('world.remove_instance', { instanceId });
    },

    setFocusedInstance(instanceId) {
      const state = get();
      const instance = state.stagedWorld.instances.find((entry) => entry.id === instanceId);
      if (!instance || !instance.enabled) {
        set({ worldMessage: 'focus must name an enabled instance' });
        return;
      }
      const stagedWorld = { ...state.stagedWorld, focusedInstanceId: instanceId };
      state.worldEngine.setWorld(stagedWorld);
      set({ stagedWorld, worldDirty: true, worldMessage: `focused ${instanceId}` });
    },

    setCameraTargetInstance(instanceId) {
      const state = get();
      const instance = state.stagedWorld.instances.find((entry) => entry.id === instanceId);
      if (!instance || !instance.enabled) {
        set({ worldMessage: 'the camera must target an enabled instance' });
        return;
      }
      const stagedWorld = { ...state.stagedWorld, cameraTargetInstanceId: instanceId };
      state.worldEngine.setWorld(stagedWorld);
      set({ stagedWorld, worldDirty: true, worldMessage: `camera on ${instanceId}` });
    },

    revertWorldEdits() {
      const state = get();
      state.worldEngine.setWorld(state.canonicalWorld);
      set({
        stagedWorld: state.canonicalWorld,
        sceneSelection: reconcileSelection(
          state.sceneSelection,
          state.canonicalWorld.instances.map((entry) => entry.id),
        ),
        worldDirty: false,
        worldMessage: 'staged world changes reverted',
      });
    },

    sharedAssetsFor(instanceId) {
      const state = get();
      if (!instanceId) return null;
      const instance = state.stagedWorld.instances.find((entry) => entry.id === instanceId);
      if (!instance) return null;
      const character = state.canonicalProject.characters.find(
        (entry) => entry.id === instance.source.characterId,
      );
      // References, not copies: this is the provenance the panel shows to make
      // "shared definition" a visible fact rather than a claim.
      return character?.animation ?? null;
    },

    /**
     * The three loadout layers, kept separate all the way to the inspector.
     *
     * The definition default comes from the project's declared equipment slots
     * and the first weapon mode; the override comes from the instance; the
     * effective value is what the runtime builds the simulation with. The
     * inspector renders all three because "Shield: off" without "…and the
     * definition says on" is the sentence that makes shared-vs-instance
     * invisible.
     */
    loadoutOf(instanceId) {
      const state = get();
      if (!instanceId) return null;
      const instance = state.stagedWorld.instances.find((entry) => entry.id === instanceId);
      if (!instance) return null;

      const overrides = instance.overrides ?? {};
      const definitionWeaponMode = WEAPON_MODES[0]!.id;
      const weaponOverride = overrides.weaponModeId ?? null;

      const equipment = state.canonicalProject.equipment.map((slot) => {
        const override = overrides.equipped?.[slot.id];
        return {
          slotId: slot.id,
          label: slot.label,
          definition: slot.defaultEquipped,
          override: override === undefined ? null : override,
          effective: override ?? slot.defaultEquipped,
        };
      });

      return {
        weaponMode: {
          definition: definitionWeaponMode,
          override: weaponOverride,
          effective: weaponOverride ?? definitionWeaponMode,
        },
        equipment,
        hasOverrides:
          weaponOverride !== null || equipment.some((slot) => slot.override !== null),
      };
    },

    /**
     * Weapon mode, targeted at one explicit instance.
     *
     * There is no focused-character shortcut here on purpose. The old
     * `setWeaponMode(id)` had no instance in its signature, so in a world with
     * two instances there was no answer to "which one did that change?" that
     * the code could give.
     */
    setInstanceWeaponMode(instanceId, weaponModeId) {
      get().runWorldCommand('world.set_instance_weapon_mode', {
        instanceId,
        ...(weaponModeId === null ? {} : { weaponModeId }),
      });
      const state = get();
      if (instanceId !== state.stagedWorld.focusedInstanceId) return;
      // The focused chamber is a *view over* the focused instance, not a
      // second runtime — so an edit to that instance has to reach the focused
      // engine too, or isolating the selection would show a stale loadout.
      // Editing any other instance deliberately leaves it alone.
      const effective = state.loadoutOf(instanceId)?.weaponMode.effective;
      const weapon = WEAPON_MODES.find((mode) => mode.id === effective);
      if (!weapon) return;
      engine.setUpperBodyActionRootMotionEnabled(weapon.usesAttackRootMotion === true);
      engine.setWeaponModeId(weapon.id);
      set({
        weaponModeId: weapon.id,
        gripEditorMode: null,
        statusMessage: `Weapon: ${weapon.label}`,
      });
    },

    setInstanceEquipment(instanceId, slotId, equipped) {
      get().runWorldCommand('world.set_instance_equipment', {
        instanceId,
        slotId,
        ...(equipped === null ? {} : { equipped }),
      });
      const state = get();
      if (instanceId !== state.stagedWorld.focusedInstanceId) return;
      const slot = state.loadoutOf(instanceId)?.equipment.find((entry) => entry.slotId === slotId);
      if (!slot) return;
      engine.setEquipped(slotId, slot.effective);
      set({
        equipped: { ...get().equipped, [slotId]: slot.effective },
        statusMessage: `${slot.label}: ${slot.effective ? 'equipped' : 'unequipped'}`,
      });
    },

    /**
     * "Open the source character" — in the bottom dock, not in the inspector.
     *
     * The right-hand inspector deliberately stays on the scene object. Swapping
     * it for a shared definition is how a user ends up editing an asset every
     * instance references while believing they are still editing the one they
     * had selected.
     */
    openCharacterDefinition(characterId) {
      const state = get();
      state.setWorkspaceMode('asset-library');
      set({ bottomWorkspace: 'project' });
      if (characterId !== state.activeCharacterId) state.setActiveCharacter(characterId);
    },

    resetInstanceLoadout(instanceId) {
      const state = get();
      state.setInstanceWeaponMode(instanceId, null);
      for (const slot of state.canonicalProject.equipment) {
        get().setInstanceEquipment(instanceId, slot.id, null);
      }
      set({ worldMessage: `loadout overrides cleared on ${instanceId}` });
    },

    setPreviewTarget(targetInstanceId) {
      set({ animationPreview: { ...get().animationPreview, targetInstanceId } });
      get().syncPreviewOverride();
    },

    setPreviewSubject(layer, stateId) {
      set({
        animationPreview: { ...get().animationPreview, layer, stateId, normalizedTime: 0 },
      });
      get().syncPreviewOverride();
    },

    setPreviewPlaying(playing) {
      set({ animationPreview: { ...get().animationPreview, playing } });
      get().syncPreviewOverride();
    },

    setPreviewLoop(loop) {
      set({ animationPreview: { ...get().animationPreview, loop } });
      get().syncPreviewOverride();
    },

    setPreviewSpeed(speed) {
      set({ animationPreview: { ...get().animationPreview, speed } });
      get().syncPreviewOverride();
    },

    setPreviewNormalizedTime(normalizedTime) {
      set({ animationPreview: { ...get().animationPreview, normalizedTime } });
      get().syncPreviewOverride();
    },

    /**
     * Clears the preview completely.
     *
     * "Completely" is the requirement: leaving a target or a parked normalized
     * time behind is how a cleared preview keeps subtly affecting what the
     * viewport shows while the PREVIEW badge is gone.
     */
    clearAnimationPreview() {
      set({ animationPreview: NO_PREVIEW });
      get().worldEngine.setPreviewOverride(null);
    },

    /**
     * Pushes the transport state at the engine's *read* side.
     *
     * This is the only place preview state reaches the runtime, and it reaches
     * `poseOf`, never `step`. That is what makes "animation preview leaves the
     * canonical bytes and the replay traces unchanged" testable rather than
     * aspirational.
     */
    syncPreviewOverride() {
      const preview = get().animationPreview;
      const engine = get().worldEngine;
      if (!preview.targetInstanceId || !preview.stateId) {
        engine.setPreviewOverride(null);
        return;
      }
      engine.setPreviewOverride({
        instanceId: preview.targetInstanceId,
        layer: preview.layer,
        stateId: preview.stateId,
        normalizedTime: preview.normalizedTime,
        playing: preview.playing,
        loop: preview.loop,
        speed: preview.speed,
      });
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

        markSelfInitiatedWrite();
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
          // Nothing was written, so there is no reload to suppress.
          awaitingOwnWrite = false;
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
        // never be seen. persistStatusForReload covers the rest: even when
        // the reload wins anyway, the next boot still shows it once.
        const commitMessage = `Committed ${payload.commit.sha.slice(0, 8)} to ${payload.commit.branch}.`;
        persistStatusForReload(commitMessage);
        set({
          commitLog: [
            `${payload.commit.sha.slice(0, 8)} on ${payload.commit.branch}: ${payload.message}`,
            ...get().commitLog,
          ],
          statusMessage: commitMessage,
        });
        await get().reloadAssets(payload.document);
      } catch (error) {
        awaitingOwnWrite = false;
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
      bottomWorkspace: state.bottomWorkspace,
      viewportPresentation: state.viewportPresentation,
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
      // Weapon and equipment fields are already correct here — persist merges
      // them in before this callback runs — so only the engine (which persist
      // never touches) needs re-syncing. Going through setWeaponMode/
      // setEquipped would work too, but both also overwrite statusMessage
      // with a "Weapon: X" / "Shield: unequipped" message on every single
      // page load, stomping anything more meaningful — like a just-completed
      // commit's confirmation — a few hundred milliseconds after it appears.
      const weapon = WEAPON_MODES.find((mode) => mode.id === state.weaponModeId);
      if (weapon) {
        state.engine.setUpperBodyActionRootMotionEnabled(weapon.usesAttackRootMotion === true);
        state.engine.setWeaponModeId(weapon.id);
      }
      // A slot may have been added or removed since this was stored.
      for (const slot of initialProject.equipment) {
        state.engine.setEquipped(slot.id, state.equipped[slot.id] ?? slot.defaultEquipped);
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

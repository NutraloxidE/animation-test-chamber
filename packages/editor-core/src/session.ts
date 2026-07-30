import type { ProjectDefinition, ValidationResult, ValueProvenance } from '@atc/schema';
import { validateProject, validateProjectReferences } from '@atc/schema';
import {
  analyzeDiff,
  ancestorPaths,
  evaluateEdit,
  getAtPath,
  setAtPath,
  type CanonicalPath,
  type DiffReport,
  type EditActor,
} from '@atc/runtime-core';

/** Where the value currently shown for a field came from (PLAN 8.2). */
export type ValueOrigin = 'repository' | 'ai-proposal' | 'human-preview' | 'human-final';

export interface FieldView {
  path: CanonicalPath;
  repositoryValue: unknown;
  aiProposalValue: unknown;
  previewValue: unknown;
  origin: ValueOrigin;
  staged: boolean;
  /** True when this field was staged, then edited again. */
  needsSave: boolean;
  /** False when protection forbids editing; the UI disables the control. */
  editableByHuman: boolean;
  editableByAi: boolean;
  protectionReason: string;
}

export interface EditAttempt {
  path: CanonicalPath;
  value: unknown;
  actor?: EditActor;
  approved?: boolean;
  unlocked?: boolean;
  intent?: string;
  replayId?: string;
  terrainPresetId?: string;
}

export interface EditOutcome {
  applied: boolean;
  requiresApproval: boolean;
  reason: string;
}

interface HistoryEntry {
  path: CanonicalPath;
  before: unknown;
  after: unknown;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return Object.is(left, right) || JSON.stringify(left) === JSON.stringify(right);
}

/**
 * The browser-side edit session. It owns the progression from
 *   Repository Value -> Preview Value -> Staged Change -> Validated Change
 * (PLAN 9.1) and is the only place a value reaches the preview from.
 *
 * Every write goes through the protection gate, so a locked field cannot be
 * changed by an AI patch, a UI slider, or an API call without a human
 * explicitly unlocking it.
 */
export class EditSession {
  private repository: ProjectDefinition;
  private preview: ProjectDefinition;
  private readonly staged = new Set<CanonicalPath>();
  private readonly stagedValues = new Map<CanonicalPath, unknown>();
  private readonly stagedProvenance = new Map<CanonicalPath, ValueProvenance>();
  private readonly aiProposals = new Map<CanonicalPath, unknown>();
  private readonly provenance = new Map<CanonicalPath, ValueProvenance>();
  private readonly undoStack: HistoryEntry[] = [];
  private readonly redoStack: HistoryEntry[] = [];
  /** Paths a human has unlocked for the duration of this session. */
  private readonly unlocked = new Set<CanonicalPath>();

  constructor(repository: ProjectDefinition) {
    this.repository = repository;
    this.preview = repository;
  }

  get repositoryProject(): ProjectDefinition {
    return this.repository;
  }

  /** The document the live preview renders from. */
  get previewProject(): ProjectDefinition {
    return this.preview;
  }

  get stagedPaths(): CanonicalPath[] {
    return [...this.staged].sort();
  }

  get stagedChanges(): { path: CanonicalPath; value: unknown }[] {
    return this.stagedPaths.map((path) => ({
      path,
      value: this.stagedValues.get(path),
    }));
  }

  get needsSavePaths(): CanonicalPath[] {
    return this.stagedPaths.filter(
      (path) => !valuesEqual(getAtPath(this.preview, path), this.stagedValues.get(path)),
    );
  }

  get hasUncommittedChanges(): boolean {
    return this.preview !== this.repository;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Records what an AI proposed so "reset to AI proposal" has something to use. */
  recordAiProposal(path: CanonicalPath, value: unknown): void {
    this.aiProposals.set(path, value);
  }

  /** A human explicitly unlocks a locked field for this session only. */
  unlock(path: CanonicalPath): void {
    this.unlocked.add(path);
  }

  isUnlocked(path: CanonicalPath): boolean {
    return this.unlocked.has(path);
  }

  /**
   * Writes a preview value. Returns why it was refused rather than throwing,
   * because the UI needs to explain the refusal next to the control.
   */
  setPreviewValue(attempt: EditAttempt): EditOutcome {
    const actor = attempt.actor ?? 'human';
    const decision = evaluateEdit(this.preview, {
      path: attempt.path,
      actor,
      approved: attempt.approved,
      unlocked: attempt.unlocked || this.unlocked.has(attempt.path),
    });

    if (!decision.allowed) {
      return {
        applied: false,
        requiresApproval: decision.requiresApproval,
        reason: decision.reason,
      };
    }

    const before = getAtPath(this.preview, attempt.path);
    if (Object.is(before, attempt.value)) {
      return { applied: true, requiresApproval: false, reason: '' };
    }

    this.preview = setAtPath(this.preview, attempt.path, attempt.value);
    this.undoStack.push({ path: attempt.path, before, after: attempt.value });
    this.redoStack.length = 0;

    if (actor === 'human') {
      const aiValue = this.aiProposals.get(attempt.path);
      this.provenance.set(attempt.path, {
        source: 'human-adjustment',
        ...(typeof aiValue === 'number' ? { basedOnAiProposal: aiValue } : {}),
        ...(typeof attempt.value === 'number' ? { humanFinal: attempt.value } : {}),
        ...(attempt.replayId ? { replayId: attempt.replayId } : {}),
        ...(attempt.terrainPresetId ? { terrainPresetId: attempt.terrainPresetId } : {}),
        ...(attempt.intent ? { intent: attempt.intent } : {}),
      });
    } else {
      this.provenance.set(attempt.path, { source: 'ai-proposal' });
    }

    return { applied: true, requiresApproval: false, reason: '' };
  }

  undo(): boolean {
    const entry = this.undoStack.pop();
    if (!entry) return false;
    this.preview = setAtPath(this.preview, entry.path, entry.before);
    this.redoStack.push(entry);
    return true;
  }

  redo(): boolean {
    const entry = this.redoStack.pop();
    if (!entry) return false;
    this.preview = setAtPath(this.preview, entry.path, entry.after);
    this.undoStack.push(entry);
    return true;
  }

  /** Reverts one field to the value currently in the repository. */
  resetToRepository(path: CanonicalPath): EditOutcome {
    return this.setPreviewValue({
      path,
      value: getAtPath(this.repository, path),
      actor: 'human',
    });
  }

  resetToAiProposal(path: CanonicalPath): EditOutcome {
    if (!this.aiProposals.has(path)) {
      return {
        applied: false,
        requiresApproval: false,
        reason: 'no AI proposal recorded',
      };
    }
    return this.setPreviewValue({
      path,
      value: this.aiProposals.get(path),
      actor: 'human',
    });
  }

  /** Throws away every uncommitted change in this session. */
  revertSession(): void {
    this.preview = this.repository;
    this.staged.clear();
    this.stagedValues.clear();
    this.stagedProvenance.clear();
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.provenance.clear();
  }

  stage(path: CanonicalPath): void {
    const value = getAtPath(this.preview, path);
    if (valuesEqual(value, getAtPath(this.repository, path))) {
      this.unstage(path);
      return;
    }
    this.staged.add(path);
    this.stagedValues.set(path, value);
    const provenance = this.provenance.get(path);
    if (provenance) this.stagedProvenance.set(path, provenance);
    else this.stagedProvenance.delete(path);
  }

  unstage(path: CanonicalPath): void {
    this.staged.delete(path);
    this.stagedValues.delete(path);
    this.stagedProvenance.delete(path);
  }

  stageAll(): void {
    this.staged.clear();
    this.stagedValues.clear();
    this.stagedProvenance.clear();
    const paths = new Set<CanonicalPath>();
    for (const change of this.diff().changes) {
      let stagePath = change.path;
      for (const ancestor of ancestorPaths(change.path)) {
        if (getAtPath(this.repository, ancestor) !== undefined) break;
        stagePath = ancestor;
      }
      paths.add(stagePath);
    }
    for (const path of paths) this.stage(path);
  }

  /** Raw and classified differences between repository and preview. */
  diff(): DiffReport {
    return analyzeDiff(this.repository, this.preview);
  }

  /**
   * The document that would be committed: repository plus only the staged
   * paths. Unstaged preview edits stay local to the session.
   */
  buildStagedDocument(): ProjectDefinition {
    let document = this.repository;
    for (const path of this.stagedPaths) {
      const value = this.stagedValues.get(path);
      if (value === undefined) continue;
      document = setAtPath(document, path, value);
    }
    return this.attachProvenance(document);
  }

  private attachProvenance(document: ProjectDefinition): ProjectDefinition {
    let next = document;
    for (const path of this.stagedPaths) {
      const record = this.stagedProvenance.get(path);
      if (!record) continue;
      // Provenance attaches to the owning object, not the leaf, so a transition
      // records why its blend duration was changed.
      const ownerPath = path.slice(0, path.lastIndexOf('/'));
      const owner = getAtPath(next, ownerPath);
      if (owner && typeof owner === 'object' && 'id' in (owner as object)) {
        next = setAtPath(next, `${ownerPath}/provenance`, record);
      }
    }
    return next;
  }

  /** Schema plus structural validation of the staged document. */
  validate(): ValidationResult {
    const document = this.buildStagedDocument();
    const schemaResult = validateProject(document);
    const referenceResult = validateProjectReferences(document);
    return {
      valid: schemaResult.valid && referenceResult.valid,
      issues: [...schemaResult.issues, ...referenceResult.issues],
    };
  }

  /**
   * Accepts a committed document as the new repository baseline. Called after
   * the Git adapter reports success, so the session never claims a commit that
   * did not land.
   */
  acceptCommitted(document: ProjectDefinition): void {
    this.repository = document;
    this.preview = document;
    this.staged.clear();
    this.stagedValues.clear();
    this.stagedProvenance.clear();
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.provenance.clear();
  }

  /** Everything the inspector needs to render one field. */
  fieldView(path: CanonicalPath): FieldView {
    const repositoryValue = getAtPath(this.repository, path);
    const previewValue = getAtPath(this.preview, path);
    const aiProposalValue = this.aiProposals.get(path);
    const wasStaged = this.staged.has(path);
    const staged = wasStaged && valuesEqual(previewValue, this.stagedValues.get(path));

    const humanDecision = evaluateEdit(this.preview, {
      path,
      actor: 'human',
      unlocked: this.unlocked.has(path),
    });
    const aiDecision = evaluateEdit(this.preview, { path, actor: 'ai' });

    let origin: ValueOrigin = 'repository';
    if (!Object.is(previewValue, repositoryValue)) {
      origin = staged ? 'human-final' : 'human-preview';
      if (Object.is(previewValue, aiProposalValue)) origin = 'ai-proposal';
    }

    return {
      path,
      repositoryValue,
      aiProposalValue,
      previewValue,
      origin,
      staged,
      needsSave: wasStaged && !staged,
      editableByHuman: humanDecision.allowed,
      editableByAi: aiDecision.allowed,
      protectionReason: humanDecision.reason || aiDecision.reason,
    };
  }
}

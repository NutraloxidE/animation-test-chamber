/**
 * The generic canonical-document edit session.
 *
 * One session owns one target's progression:
 *
 *     Repository → Preview → Staged → Validated → Applied
 *
 * and each arrow is a separate, visible step. The three separations it exists
 * to enforce (work package §4.4–§4.6):
 *
 *   Preview is not Stage    editing a control changes the page, not the repo
 *   Stage is not Apply      staging records paths against one baseline; no write
 *   Apply is not commit     applying writes canonical files; git stays separate
 *
 * `EditSession` (session.ts) remains the Rig Editor's specialised session: it
 * additionally owns the animation-asset destination split, which is a Character
 * concern and deliberately *not* generalised here. A Scene has no asset-owned
 * paths, and a prefix list shared by both would sooner or later route a Scene
 * edit into an animation asset.
 */
import type { ValidationIssue, ValidationResult } from '@atc/schema';
import { analyzeDiff, evaluateEdit, type DiffReport, type EditActor } from '@atc/runtime-core';
import type { RepositoryDocumentTarget } from './repository-target.ts';

export interface DocumentOperationResult<TDocument> {
  ok: boolean;
  issues: ValidationIssue[];
  document?: TDocument;
  changedPaths?: string[];
}

export interface DocumentSessionOptions<TDocument, TOperation> {
  target: RepositoryDocumentTarget;
  /** The repository revision this session opened against. Apply checks it. */
  baseRevisionId: string;
  document: TDocument;
  /** Applies one operation to a document. Must not mutate its input. */
  apply: (document: TDocument, operation: TOperation) => DocumentOperationResult<TDocument>;
  /** Structural validation of a candidate document. */
  validate: (document: TDocument) => ValidationResult;
}

interface HistoryEntry<TDocument> {
  before: TDocument;
  after: TDocument;
  changedPaths: string[];
}

/** What Apply is asked to perform, and against which baseline. */
export interface RepositoryApplyRequest<TOperation> {
  target: RepositoryDocumentTarget;
  expected: { projectRevisionId: string };
  operations: TOperation[];
  actor: EditActor;
  intent: string;
  /** Paths this session's human unlocked. Never sent for an AI actor. */
  unlockedPaths?: string[];
}

export class DocumentEditSession<TDocument, TOperation> {
  readonly target: RepositoryDocumentTarget;
  /**
   * The repository revision this session's next Apply is built against.
   *
   * Not readonly, because a successful Apply moves it. A session that kept the
   * revision it opened at would send that stale value on the *second* Apply and
   * be refused as a conflict — against a change it made itself, one edit ago.
   */
  private currentRevisionId: string;

  private repository: TDocument;
  private preview: TDocument;
  /**
   * Staged *operations*, in dispatch order — not staged values.
   *
   * A Scene edit is frequently structural (an entity appeared, the order
   * changed), and a set of leaf paths cannot describe "this entity was created"
   * in a form the server can independently re-validate. Replaying the typed
   * operations server-side is what lets Apply refuse a write it does not
   * understand instead of trusting a document the client assembled.
   */
  private readonly stagedOperations: TOperation[] = [];
  private readonly stagedPathSet = new Set<string>();
  private readonly undoStack: HistoryEntry<TDocument>[] = [];
  private readonly redoStack: HistoryEntry<TDocument>[] = [];
  /** Paths a human has unlocked for the duration of this session. */
  private readonly unlocked = new Set<string>();
  /** Paths each dispatched-but-unstaged operation touched, by operation index. */
  private readonly pendingPaths: { operation: TOperation; paths: string[] }[] = [];
  /** Undone operations, kept so redo can put them back where they were. */
  private readonly redoOperations: { operation: TOperation; paths: string[] }[] = [];

  constructor(private readonly options: DocumentSessionOptions<TDocument, TOperation>) {
    this.target = options.target;
    this.currentRevisionId = options.baseRevisionId;
    this.repository = options.document;
    this.preview = options.document;
  }

  /** The revision the next Apply will declare. Moves when an Apply lands. */
  get baseRevisionId(): string {
    return this.currentRevisionId;
  }

  get repositoryDocument(): TDocument {
    return this.repository;
  }

  /** The document the live preview renders from. */
  get previewDocument(): TDocument {
    return this.preview;
  }

  get stagedPaths(): readonly string[] {
    return [...this.stagedPathSet].sort();
  }

  get staged(): readonly TOperation[] {
    return this.stagedOperations;
  }

  /** Operations dispatched into the preview but not yet staged. */
  get pending(): readonly TOperation[] {
    return this.pendingPaths.map((entry) => entry.operation);
  }

  get isDirty(): boolean {
    return this.preview !== this.repository;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  unlock(path: string): void {
    this.unlocked.add(path);
  }

  isUnlocked(path: string): boolean {
    return this.unlocked.has(path);
  }

  /**
   * Runs one operation against the preview.
   *
   * Protection is checked *before* the operation runs, on every path the
   * operation would touch, and for the actor that asked. A UI drag, an
   * Inspector field, an AI command and a scripted repository command all arrive
   * here, so there is one place a locked value can be refused rather than four
   * that have to remember to.
   *
   * Returns the refusal rather than throwing: the UI has to explain it next to
   * the control the human just moved.
   */
  dispatch(
    operation: TOperation,
    context: { actor?: EditActor; approved?: boolean } = {},
  ): DocumentOperationResult<TDocument> {
    const actor = context.actor ?? 'human';

    // A dry run first, so protection is evaluated against the paths the
    // operation actually touches rather than against a guess made from its type.
    const candidate = this.options.apply(this.preview, operation);
    if (!candidate.ok || candidate.document === undefined) return candidate;

    const refusals: ValidationIssue[] = [];
    for (const path of candidate.changedPaths ?? []) {
      const decision = evaluateEdit(this.preview, {
        path,
        actor,
        approved: context.approved,
        unlocked: this.unlocked.has(path),
      });
      if (!decision.allowed) {
        refusals.push({
          path,
          message: decision.reason || `protection refuses this edit by ${actor}`,
          keyword: decision.requiresApproval ? 'approval-required' : 'protection',
        });
      }
    }
    if (refusals.length > 0) return { ok: false, issues: refusals };

    this.undoStack.push({
      before: this.preview,
      after: candidate.document,
      changedPaths: [...(candidate.changedPaths ?? [])],
    });
    this.redoStack.length = 0;
    this.redoOperations.length = 0;
    this.preview = candidate.document;
    this.pendingPaths.push({ operation, paths: [...(candidate.changedPaths ?? [])] });
    return candidate;
  }

  /**
   * Undo and redo move the *operation list*, not only the preview document.
   *
   * The two must agree, because Apply replays operations while the human reads
   * the preview. An undone operation that stayed in the list would be applied
   * despite having visibly been taken back; a redone one that never came back
   * to the list would be visible in the preview and silently absent from the
   * write. Undoing something already staged unstages it, for the same reason:
   * "staged" cannot outlive the edit it describes.
   */
  undo(): boolean {
    const entry = this.undoStack.pop();
    if (!entry) return false;
    this.preview = entry.before;
    this.redoStack.push(entry);
    const undone = this.pendingPaths.pop();
    if (undone) {
      const staged = this.stagedOperations.indexOf(undone.operation);
      if (staged !== -1) {
        this.stagedOperations.splice(staged, 1);
        this.rebuildStagedPaths();
      }
      this.redoOperations.push(undone);
    }
    return true;
  }

  redo(): boolean {
    const entry = this.redoStack.pop();
    if (!entry) return false;
    this.preview = entry.after;
    this.undoStack.push(entry);
    const restored = this.redoOperations.pop();
    // Restored unstaged: a redo puts the edit back, and staging it again is a
    // second, separate decision the human has not made yet.
    if (restored) this.pendingPaths.push(restored);
    return true;
  }

  /** Recomputes the staged path set from the operations that are still staged. */
  private rebuildStagedPaths(): void {
    this.stagedPathSet.clear();
    for (const operation of this.stagedOperations) {
      const entry = this.pendingPaths.find((candidate) => candidate.operation === operation);
      for (const path of entry?.paths ?? []) this.stagedPathSet.add(path);
    }
  }

  /** Stages every pending operation that touched `path`. */
  stage(path: string): void {
    for (const entry of this.pendingPaths) {
      if (!entry.paths.includes(path)) continue;
      if (!this.stagedOperations.includes(entry.operation)) {
        this.stagedOperations.push(entry.operation);
      }
      for (const staged of entry.paths) this.stagedPathSet.add(staged);
    }
  }

  stageAll(): void {
    for (const entry of this.pendingPaths) {
      if (!this.stagedOperations.includes(entry.operation)) {
        this.stagedOperations.push(entry.operation);
      }
      for (const path of entry.paths) this.stagedPathSet.add(path);
    }
  }

  unstage(path: string): void {
    const kept: TOperation[] = [];
    this.stagedPathSet.clear();
    for (const operation of this.stagedOperations) {
      const entry = this.pendingPaths.find((candidate) => candidate.operation === operation);
      if (entry?.paths.includes(path)) continue;
      kept.push(operation);
      for (const staged of entry?.paths ?? []) this.stagedPathSet.add(staged);
    }
    this.stagedOperations.length = 0;
    this.stagedOperations.push(...kept);
  }

  /** Throws away every uncommitted change in this session. */
  revert(): void {
    this.preview = this.repository;
    this.stagedOperations.length = 0;
    this.stagedPathSet.clear();
    this.pendingPaths.length = 0;
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.redoOperations.length = 0;
  }

  /** Keeps the preview, discards only what was staged. */
  discardStaged(): void {
    this.stagedOperations.length = 0;
    this.stagedPathSet.clear();
  }

  diff(): DiffReport {
    return analyzeDiff(this.repository, this.preview);
  }

  /**
   * The document Apply would produce: the repository document with only the
   * *staged* operations replayed. Unstaged preview edits stay local to the
   * session, which is what makes "preview" and "staged" different words.
   */
  buildStagedDocument(): DocumentOperationResult<TDocument> {
    let document = this.repository;
    const changedPaths: string[] = [];
    for (const operation of this.stagedOperations) {
      const result = this.options.apply(document, operation);
      if (!result.ok || result.document === undefined) return result;
      document = result.document;
      changedPaths.push(...(result.changedPaths ?? []));
    }
    return { ok: true, issues: [], document, changedPaths };
  }

  validate(): ValidationResult {
    const staged = this.buildStagedDocument();
    if (!staged.ok || staged.document === undefined) {
      return { valid: false, issues: staged.issues };
    }
    return this.options.validate(staged.document);
  }

  buildApplyRequest(intent: string, actor: EditActor = 'human'): RepositoryApplyRequest<TOperation> {
    return {
      target: this.target,
      expected: { projectRevisionId: this.currentRevisionId },
      operations: [...this.stagedOperations],
      actor,
      intent,
      // Only a human's unlocks travel; the server refuses them from an AI actor
      // anyway, and sending them would be asking for something it must not grant.
      ...(actor === 'human' && this.unlocked.size > 0
        ? { unlockedPaths: [...this.unlocked] }
        : {}),
    };
  }

  /**
   * Accepts an applied document as the new baseline.
   *
   * Called only after the repository reports success, so the session never
   * claims a write that did not land. A failed Apply leaves the staged work
   * exactly where it was, because the human's next move is usually to fix one
   * issue and apply again — not to redo everything.
   *
   * `revisionId` is the revision the repository reported *back*. Keeping the
   * one the session opened at would make the very next Apply declare a baseline
   * that no longer exists, and it would be refused as a conflict with the
   * session's own previous write — the first thing a user hits when they apply
   * twice without reloading the page.
   */
  acceptApplied(document: TDocument, revisionId?: string): void {
    if (revisionId !== undefined) this.currentRevisionId = revisionId;
    this.repository = document;
    this.preview = document;
    this.stagedOperations.length = 0;
    this.stagedPathSet.clear();
    this.pendingPaths.length = 0;
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.redoOperations.length = 0;
  }
}

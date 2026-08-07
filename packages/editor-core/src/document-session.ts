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

/**
 * A key-order-independent JSON encoding, for comparing two canonical documents.
 *
 * `JSON.stringify` alone would report `{a:1,b:2}` and `{b:2,a:1}` as different,
 * and operation helpers rebuild objects with spread — which preserves insertion
 * order, but only until one of them stops doing so. Sorting keys makes the
 * comparison about what the document *says* rather than how it was assembled.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    // `undefined` members are absent as far as JSON is concerned, so a document
    // that carries one and a document that omits it are the same document.
    .filter(([, member]) => member !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, member]) => `${JSON.stringify(key)}:${stableStringify(member)}`).join(',')}}`;
}

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

/**
 * One dispatched operation, and everything undo/redo/staging needs to know
 * about it.
 *
 * Previously this was three parallel arrays — an undo stack of documents, a
 * pending list of operations, and a separate redo list — related to each other
 * by object identity. That worked until it did not: `rebuildStagedPaths` looked
 * an operation up in `pendingPaths` by `===`, so an operation that had been
 * undone (and therefore removed from `pendingPaths`) silently contributed no
 * paths, and two structurally identical operations were indistinguishable.
 *
 * Identity across separate arrays is not a model, it is a coincidence that
 * holds most of the time. One entry per operation, carrying its own staged
 * flag, is what lets Redo restore the staged status the operation had before
 * Undo — which is the declared behaviour and the thing the old shape could not
 * express at all.
 */
interface HistoryEntry<TDocument, TOperation> {
  operation: TOperation;
  before: TDocument;
  after: TDocument;
  changedPaths: string[];
  /** Whether this operation is currently staged for Apply. */
  staged: boolean;
  /**
   * The staged flag this operation carried when it was undone.
   *
   * Redo restores it. An edit that was staged, undone and redone is back
   * exactly where it was — not silently demoted to unstaged, which would make
   * Undo/Redo a way to quietly drop work out of an Apply the human believes
   * they have already approved.
   */
  stagedBeforeUndo: boolean;
}

/** What Apply is asked to perform, and against which baseline. */
export interface DocumentApplyRequest<TOperation> {
  target: RepositoryDocumentTarget;
  expected: { projectRevisionId: string };
  operations: TOperation[];
  actor: EditActor;
  intent: string;
  /**
   * A human's exact sign-off on the protected paths this Apply would change.
   *
   * Absent unless the caller supplied one. There is deliberately no
   * `unlockedPaths` here: a session unlock is a local UI gesture, and the
   * server recomputes which paths are protected anyway, so sending the
   * session's unlock set would be asking the server for something it must not
   * grant on a client's say-so.
   */
  approval?: { approvedPaths: string[]; reason: string };
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
   * The applied history, in dispatch order, and the redo branch above it.
   *
   * `applied` holds the operations currently reflected in the preview; `undone`
   * holds the ones taken back, most-recent-last, waiting for Redo. Both hold
   * *operations*, not values.
   *
   * A Scene edit is frequently structural (an entity appeared, the order
   * changed), and a set of leaf paths cannot describe "this entity was created"
   * in a form the server can independently re-validate. Replaying the typed
   * operations server-side is what lets Apply refuse a write it does not
   * understand instead of trusting a document the client assembled.
   */
  private readonly applied: HistoryEntry<TDocument, TOperation>[] = [];
  private readonly undone: HistoryEntry<TDocument, TOperation>[] = [];
  /** Paths a human has unlocked for the duration of this session. */
  private readonly unlocked = new Set<string>();

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

  /**
   * Every path the staged operations touched.
   *
   * Derived on read from the staged entries rather than maintained as a
   * separate set that has to be kept in step with them. The set and the list
   * disagreeing was the shape of the original staging bug.
   */
  get stagedPaths(): readonly string[] {
    const paths = new Set<string>();
    for (const entry of this.applied) {
      if (!entry.staged) continue;
      for (const path of entry.changedPaths) paths.add(path);
    }
    return [...paths].sort();
  }

  get staged(): readonly TOperation[] {
    return this.applied.filter((entry) => entry.staged).map((entry) => entry.operation);
  }

  /** Operations dispatched into the preview but not yet staged. */
  get pending(): readonly TOperation[] {
    return this.applied.filter((entry) => !entry.staged).map((entry) => entry.operation);
  }

  get isDirty(): boolean {
    return this.preview !== this.repository;
  }

  get canUndo(): boolean {
    return this.applied.length > 0;
  }

  get canRedo(): boolean {
    return this.undone.length > 0;
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

    /*
     * An operation that produces the value already there is a no-op, and a
     * no-op is not history.
     *
     * Recording one would put an entry on the undo stack that Undo cannot
     * visibly undo, mark the session dirty with nothing to show for it, and —
     * worst — add an operation to the Apply request that the server will
     * replay to no effect, so a "no change" Apply would arrive carrying work.
     *
     * Compared semantically rather than by reference: the operation helpers
     * rebuild objects (`{ ...scene, entities: [...] }`) even when every leaf is
     * unchanged, so a reference comparison would call every no-op a change.
     */
    const changedPaths = [...(candidate.changedPaths ?? [])];
    if (changedPaths.length === 0 || this.isSemanticallyEqual(this.preview, candidate.document)) {
      return { ok: true, issues: [], document: this.preview, changedPaths: [] };
    }

    this.applied.push({
      operation,
      before: this.preview,
      after: candidate.document,
      changedPaths,
      staged: false,
      stagedBeforeUndo: false,
    });
    // A new edit after an Undo discards the redo branch: the history is a line,
    // not a tree, and keeping a branch that can no longer be replayed onto this
    // preview would let Redo reintroduce an operation built on a document that
    // no longer exists.
    this.undone.length = 0;
    this.preview = candidate.document;
    return { ...candidate, changedPaths };
  }

  /**
   * Whether two canonical documents carry the same information.
   *
   * Canonical documents are plain JSON by construction — that is what makes
   * them storable, diffable and hashable — so serialising with sorted keys is
   * an exact comparison here rather than an approximation of one.
   */
  private isSemanticallyEqual(left: TDocument, right: TDocument): boolean {
    if (left === right) return true;
    return stableStringify(left) === stableStringify(right);
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
    const entry = this.applied.pop();
    if (!entry) return false;
    this.preview = entry.before;
    /*
     * The staged flag is remembered, then cleared. Cleared because an undone
     * operation must not travel in the next Apply — "staged" cannot outlive the
     * edit it describes. Remembered because Redo has to put it back exactly as
     * it was, and only this entry knows what that was.
     */
    entry.stagedBeforeUndo = entry.staged;
    entry.staged = false;
    this.undone.push(entry);
    return true;
  }

  redo(): boolean {
    const entry = this.undone.pop();
    if (!entry) return false;
    this.preview = entry.after;
    // Restored to the staged status it had before the Undo — staged if it was
    // staged, unstaged if it was not. Always restoring it as unstaged would
    // silently drop approved work out of the next Apply; always restoring it as
    // staged would stage an edit the human never approved.
    entry.staged = entry.stagedBeforeUndo;
    this.applied.push(entry);
    return true;
  }

  /**
   * Stages every operation that touched `path`.
   *
   * Whole operations, never individual paths. A single semantic edit can touch
   * several paths — placing an entity, reordering the list — and staging half
   * of one would produce an Apply request that cannot describe what the human
   * approved. So partial path staging stages the complete operation, and every
   * path it touched then reads as staged.
   */
  stage(path: string): void {
    for (const entry of this.applied) {
      if (entry.changedPaths.includes(path)) entry.staged = true;
    }
  }

  stageAll(): void {
    for (const entry of this.applied) entry.staged = true;
  }

  unstage(path: string): void {
    for (const entry of this.applied) {
      if (entry.changedPaths.includes(path)) entry.staged = false;
    }
  }

  /** Throws away every uncommitted change in this session. */
  revert(): void {
    this.preview = this.repository;
    this.applied.length = 0;
    this.undone.length = 0;
  }

  /** Keeps the preview, discards only what was staged. */
  discardStaged(): void {
    for (const entry of this.applied) entry.staged = false;
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
    for (const operation of this.staged) {
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

  /**
   * The request Apply will send.
   *
   * `approval` is supplied by the caller, not derived from this session's
   * unlock set. The two are different things: an unlock is a local gesture that
   * makes a control editable in this browser, while an approval names the exact
   * paths a human signed off on and why. The server recomputes which paths are
   * protected and compares against the approval, so a session that quietly
   * attached its own unlocks would be asking the server to trust the caller
   * about the one question the caller must not answer.
   *
   * Only a human can carry an approval. An AI may prepare the operations, but
   * an approval an agent attaches to its own request is not an approval, and
   * the server refuses it.
   */
  buildApplyRequest(
    intent: string,
    actor: EditActor = 'human',
    approval?: { approvedPaths: string[]; reason: string },
  ): DocumentApplyRequest<TOperation> {
    return {
      target: this.target,
      expected: { projectRevisionId: this.currentRevisionId },
      operations: [...this.staged],
      actor,
      intent,
      ...(actor === 'human' && approval ? { approval } : {}),
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
   * `revisionId` is the revision the repository reported *back*, and it is
   * mandatory. Keeping the one the session opened at would make the very next
   * Apply declare a baseline that no longer exists, and it would be refused as
   * a conflict with the session's own previous write — the first thing a user
   * hits when they apply twice without reloading the page.
   *
   * It was optional once. An optional revision means a caller can forget it and
   * find out one Apply later, from a conflict that names no cause; required
   * means they find out at compile time, which is the only time the mistake is
   * cheap.
   */
  acceptApplied(document: TDocument, revisionId: string): void {
    this.currentRevisionId = revisionId;
    this.repository = document;
    this.preview = document;
    this.applied.length = 0;
    this.undone.length = 0;
  }
}

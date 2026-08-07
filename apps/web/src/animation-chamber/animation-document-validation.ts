/**
 * What "valid" means for a chamber document.
 *
 * The session validator used to return unconditional success, with a comment
 * explaining that structural references were already resolved by the time a
 * session existed. That was true of the document as *materialised* and stopped
 * being true the moment anything could be edited: a transition re-pointed at a
 * state that does not exist is a resolved document made invalid by a keystroke,
 * and reporting it as valid is worse than not validating at all — it is a claim
 * nobody checked.
 *
 * So this validates exactly the classes an edit can break, and no more. It does
 * not re-derive asset resolution, which genuinely did happen upstream and
 * cannot be undone from here.
 */
import type { ValidationIssue, ValidationResult } from '@atc/schema';
import type { AnimationChamberDocument } from './AnimationChamberDocument.ts';

interface NumericRule {
  field: string;
  min?: number;
  max?: number;
  integer?: boolean;
}

/**
 * The ranges the panels can move a value outside of.
 *
 * Slider bounds are a UI courtesy; the AI provider, undo across a schema
 * change, and a hand-edited draft all reach these fields without passing a
 * slider, so the bound has to exist somewhere that is not the input element.
 */
const TRANSITION_RULES: NumericRule[] = [
  { field: 'blendDurationSec', min: 0, max: 10 },
  { field: 'exitTimeNormalized', min: 0, max: 1 },
  { field: 'inputBufferMs', min: 0, max: 5000 },
  { field: 'momentumRetention', min: 0, max: 1 },
  { field: 'playbackSpeed', min: 0.01, max: 10 },
  { field: 'rotationAuthority', min: 0, max: 1 },
  { field: 'startOffsetNormalized', min: 0, max: 1 },
  { field: 'priority', integer: true },
];

const STATE_RULES: NumericRule[] = [
  { field: 'speed', min: 0, max: 20 },
];

function checkNumeric(
  container: Record<string, unknown>,
  rules: readonly NumericRule[],
  basePath: string,
  issues: ValidationIssue[],
): void {
  for (const rule of rules) {
    const value = container[rule.field];
    if (value === undefined) continue;
    const path = `${basePath}/${rule.field}`;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      issues.push({ path, message: `${rule.field} must be a finite number`, keyword: 'type' });
      continue;
    }
    if (rule.integer && !Number.isInteger(value)) {
      issues.push({ path, message: `${rule.field} must be a whole number`, keyword: 'integer' });
    }
    if (rule.min !== undefined && value < rule.min) {
      issues.push({ path, message: `${rule.field} must be at least ${rule.min}`, keyword: 'minimum' });
    }
    if (rule.max !== undefined && value > rule.max) {
      issues.push({ path, message: `${rule.field} must be at most ${rule.max}`, keyword: 'maximum' });
    }
  }
}

export function validateAnimationChamberDocument(
  document: AnimationChamberDocument,
): ValidationResult {
  const issues: ValidationIssue[] = [];
  const stateIds = new Set(document.graph.states.map((state) => state.id));
  const clipIds = new Set(document.clips.map((clip) => clip.id));

  for (const state of document.graph.states) {
    checkNumeric(state as unknown as Record<string, unknown>, STATE_RULES, `/graph/states/${state.id}`, issues);
    /*
     * A state names a motion slot, and the slot is resolved to a clip through
     * the Motion Set. A slot with no binding plays nothing — which the viewport
     * shows as a body standing still for no stated reason, so it is said here
     * instead.
     */
    const slot = (state as unknown as { motionSlot?: string }).motionSlot;
    if (slot !== undefined && document.motionBindings[slot] === undefined) {
      issues.push({
        path: `/graph/states/${state.id}/motionSlot`,
        message: `motion slot "${slot}" has no binding in this subject's Motion Set`,
        keyword: 'reference',
      });
    }
  }

  for (const transition of document.graph.transitions) {
    const base = `/graph/transitions/${transition.id}`;
    checkNumeric(transition as unknown as Record<string, unknown>, TRANSITION_RULES, base, issues);

    for (const [field, id] of [
      ['from', transition.from],
      ['to', transition.to],
    ] as const) {
      // `from` may name the wildcard "any" in this schema; anything else has to
      // be a state that exists.
      if (id === undefined || id === '*' || id === 'any') continue;
      if (!stateIds.has(id)) {
        issues.push({
          path: `${base}/${field}`,
          message: `transition ${field} names state "${id}", which this graph does not have`,
          keyword: 'reference',
        });
      }
    }

    const window = (transition as unknown as { cancelWindow?: { start?: number; end?: number } })
      .cancelWindow;
    if (window && typeof window.start === 'number' && typeof window.end === 'number') {
      if (window.start > window.end) {
        issues.push({
          path: `${base}/cancelWindow`,
          message: 'cancel window starts after it ends',
          keyword: 'order',
        });
      }
    }
  }

  for (const [slot, clipId] of Object.entries(document.motionBindings)) {
    if (!clipIds.has(clipId)) {
      issues.push({
        path: `/motionBindings/${slot}`,
        message: `slot "${slot}" binds clip "${clipId}", which is not in this subject's resolved set`,
        keyword: 'reference',
      });
    }
  }
  for (const [context, bindings] of Object.entries(document.contextualMotionBindings)) {
    for (const [slot, clipId] of Object.entries(bindings)) {
      if (!clipIds.has(clipId)) {
        issues.push({
          path: `/contextualMotionBindings/${context}/${slot}`,
          message: `context "${context}" binds clip "${clipId}", which is not in this subject's resolved set`,
          keyword: 'reference',
        });
      }
    }
  }

  for (const [index, clip] of document.clips.entries()) {
    if (!(clip.durationSec > 0)) {
      issues.push({
        path: `/clips/${index}/durationSec`,
        message: `clip "${clip.id}" must have a positive duration`,
        keyword: 'minimum',
      });
    }
    // Event positions are normalized against the clip, so "outside the clip"
    // means outside 0..1 — a drag that overshoots the timeline rather than a
    // duration change.
    for (const [eventIndex, event] of (clip.events ?? []).entries()) {
      if (event.at < 0 || event.at > 1) {
        issues.push({
          path: `/clips/${index}/events/${eventIndex}/at`,
          message: `event "${event.id}" falls outside clip "${clip.id}"`,
          keyword: 'range',
        });
      }
    }
  }

  return { valid: issues.length === 0, issues };
}

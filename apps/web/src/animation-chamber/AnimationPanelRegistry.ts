/**
 * The right-side panels, in order, as data.
 *
 * A list rather than a switch buried in the shell, because §14 asks for a
 * registry that a test can compare against expected ids, labels and order. The
 * donor's ordering is reproduced exactly — including `World` at position two,
 * which the current branch had dropped and which this restoration puts back.
 *
 * `implemented` marks how far the native rewiring has reached. A panel that is
 * registered but not yet wired keeps its tab and renders a structured reason,
 * which is the behaviour §2 requires of any panel that cannot operate: keep the
 * tab, keep the component, say what is missing, never silently hide it. The
 * flag exists so that "not yet migrated" is a visible, testable state rather
 * than a missing tab nobody notices.
 */
import type { AnimationPanelId } from './AnimationChamberFacade.ts';

export interface AnimationPanelDescriptor {
  id: AnimationPanelId;
  label: string;
  /** Whether this panel reads the native subject facade yet. */
  implemented: boolean;
}

export const ANIMATION_PANELS: readonly AnimationPanelDescriptor[] = [
  { id: 'inspector', label: 'Inspector', implemented: true },
  { id: 'world', label: 'World', implemented: false },
  { id: 'graph', label: 'Graph', implemented: true },
  { id: 'timeline', label: 'Timeline', implemented: true },
  { id: 'timing', label: 'Timing', implemented: true },
  { id: 'replay', label: 'Replay', implemented: true },
  { id: 'terrain', label: 'Terrain', implemented: true },
  { id: 'ai', label: 'AI', implemented: true },
  { id: 'diff', label: 'Diff', implemented: true },
  { id: 'capability', label: 'Haptics', implemented: true },
  { id: 'acquisition', label: 'Import', implemented: true },
] as const;

export const ANIMATION_PANEL_IDS: readonly AnimationPanelId[] = ANIMATION_PANELS.map(
  (panel) => panel.id,
);

export function animationPanel(id: AnimationPanelId): AnimationPanelDescriptor {
  const found = ANIMATION_PANELS.find((panel) => panel.id === id);
  if (!found) throw new Error(`unknown animation panel "${id}"`);
  return found;
}

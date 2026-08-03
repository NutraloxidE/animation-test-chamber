/**
 * The right-hand dock: whatever is selected, inspected.
 *
 * There is no `World` tab any more, and that removal is the point rather than
 * a side effect. A tab named after a scene object means the object is reachable
 * only while that tab is open, and it means the answer to "what am I editing?"
 * is a tab index rather than a selection. Routing on `SceneSelection` makes the
 * dock a function of the selection — the switch below is exhaustive, so a new
 * selection kind cannot be added without deciding what inspects it.
 */
import type { SceneSelection } from '../selection/scene-selection.ts';
import { useChamber } from '../store.ts';
import { AttachmentInspector } from './AttachmentInspector.tsx';
import { CameraInspector } from './CameraInspector.tsx';
import { InstanceInspector } from './InstanceInspector.tsx';
import { TerrainInspector } from './TerrainInspector.tsx';
import { WorldInspector } from './WorldInspector.tsx';

export function InspectorBody({ selection }: { selection: SceneSelection }) {
  switch (selection.kind) {
    case 'world':
      return <WorldInspector />;
    case 'instance':
      return <InstanceInspector instanceId={selection.instanceId} />;
    case 'attachment':
      return (
        <AttachmentInspector instanceId={selection.instanceId} slotId={selection.slotId} />
      );
    case 'terrain':
      return <TerrainInspector />;
    case 'camera':
      return <CameraInspector />;
  }
}

export function ContextualInspector() {
  const selection = useChamber((state) => state.sceneSelection);
  const previewActive = useChamber(
    (state) =>
      state.animationPreview.targetInstanceId !== null && state.animationPreview.stateId !== null,
  );

  return (
    <div className="contextual-inspector" data-testid="contextual-inspector">
      {previewActive && (
        <p className="contextual-inspector__preview-banner" data-testid="preview-active-banner">
          PREVIEW active — the viewport is showing a temporary override, not authored behaviour.
        </p>
      )}
      <InspectorBody selection={selection} />
    </div>
  );
}

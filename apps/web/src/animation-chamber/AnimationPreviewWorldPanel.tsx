import { useAnimationChamber } from './useAnimationChamber.ts';
import type { PreviewWorldIntentSource } from './AnimationPreviewWorldSession.ts';

export function AnimationPreviewWorldPanel(): JSX.Element {
  const world = useAnimationChamber((state) => state.previewWorld);
  const duplicate = useAnimationChamber((state) => state.duplicatePreviewWorldInstance);
  const update = useAnimationChamber((state) => state.updatePreviewWorldInstance);
  const focus = useAnimationChamber((state) => state.focusPreviewWorldInstance);
  const targetCamera = useAnimationChamber((state) => state.targetPreviewWorldCamera);
  const revert = useAnimationChamber((state) => state.revertPreviewWorld);

  return (
    <section className="panel preview-world-panel" data-testid="preview-world-panel">
      <header className="panel__header">
        <div>
          <h2>Preview World</h2>
          <p className="finding finding--warning" data-testid="preview-world-warning">
            PREVIEW WORLD — Not saved to a Scene. Open Scene Editor for canonical composition.
          </p>
        </div>
        <div className="button-row">
          <button type="button" onClick={duplicate}>Duplicate test instance</button>
          <button type="button" onClick={revert}>Revert Preview World</button>
        </div>
      </header>

      <div className="preview-world-instances" data-testid="preview-world-instances">
        {world.instances.map((instance) => (
          <fieldset key={instance.id} data-testid={`preview-world-instance-${instance.id}`}>
            <legend>{instance.label}</legend>
            <label><input type="checkbox" checked={instance.enabled} onChange={(event) => update(instance.id, { enabled: event.target.checked })} /> Enabled</label>
            {(['x', 'y', 'z'] as const).map((axis) => (
              <label key={axis}>{axis.toUpperCase()} <input type="number" step="0.25" value={instance.position[axis]} onChange={(event) => update(instance.id, { position: { ...instance.position, [axis]: Number(event.target.value) } })} /></label>
            ))}
            <label>Yaw <input type="number" value={instance.yawDeg} onChange={(event) => update(instance.id, { yawDeg: Number(event.target.value) })} /></label>
            <label>Intent source <select value={instance.intentSource} onChange={(event) => update(instance.id, { intentSource: event.target.value as PreviewWorldIntentSource })}><option value="player">Player</option><option value="ai">AI</option><option value="replay">Replay</option></select></label>
            <div className="button-row">
              <button type="button" aria-pressed={world.focusedInstanceId === instance.id} onClick={() => focus(instance.id)}>Focus</button>
              <button type="button" aria-pressed={world.cameraTargetId === instance.id} onClick={() => targetCamera(instance.id)}>Camera target</button>
            </div>
          </fieldset>
        ))}
      </div>
      <p className="muted small">All instances share this Animator's session-only animation assignment.</p>
    </section>
  );
}

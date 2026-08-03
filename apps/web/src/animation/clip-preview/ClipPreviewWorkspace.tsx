/**
 * Clip Preview — sample a resolved clip, execute nothing.
 *
 * The banner is not a tooltip and not a footnote. The previous panel presented
 * a read-side pose substitution as "play this state on this instance now",
 * which is a claim about the runtime that the implementation deliberately does
 * not make: no transition fires, no semantic event is emitted, no recovery
 * policy runs, no root motion moves anything. Every one of those is real
 * behaviour a user could reasonably expect from that wording, so the honest
 * fix is to say what this is and point at the thing that does the rest.
 */
import { useState } from 'react';
import { useChamber } from '../../store.ts';
import { ScopeBadge } from '../../inspector/sections/ScopeBadge.tsx';
import { AnimationTargetHeader } from '../target/AnimationTargetHeader.tsx';
import { useAnimationTarget } from '../target/useAnimationTarget.ts';
import { layersOf, reachableClips, statesOnLayer } from '../target/resolve-animation-target.ts';
import { ClipPreviewTransport } from './ClipPreviewTransport.tsx';
import { ClipPreviewMetadata } from './ClipPreviewMetadata.tsx';

export function ClipPreviewWorkspace() {
  const preview = useChamber((state) => state.clipPreview);
  const setSource = useChamber((state) => state.setClipPreviewSource);
  const durationSec = useChamber((state) => state.clipPreviewDurationSec());
  const { resolved } = useAnimationTarget();

  const target = resolved?.ok ? resolved.target : null;
  const layers = target ? layersOf(target) : [];
  const activeLayer =
    preview.source?.kind === 'state' ? preview.source.layer : (layers[0] ?? 'locomotion');
  /*
   * Which *kind* of source the user is choosing is a UI position, not part of
   * the preview: deriving it from `preview.source` would snap the picker back
   * to By State the moment they cleared the clip they were about to replace.
   */
  const [sourceKind, setSourceKind] = useState<'state' | 'clip'>(
    preview.source?.kind === 'clip' ? 'clip' : 'state',
  );

  return (
    <div className="workspace workspace--clip-preview" data-testid="clip-preview">
      <header className="workspace__header">
        <h2>Clip Preview</h2>
        <ScopeBadge scope="PREVIEW" />
        <span className="workspace__badge" data-testid="clip-preview-pose-only">
          POSE ONLY
        </span>
        <span className="workspace__badge">TEMPORARY</span>
      </header>

      {/* §6.5: always visible, never only in a tooltip. */}
      <p className="workspace__banner" data-testid="clip-preview-semantics">
        <b>POSE ONLY.</b> Transitions, events, recovery, and gameplay root motion are not executed.
        Use <b>State Sandbox</b> for runtime behaviour.
      </p>

      <AnimationTargetHeader />

      {!target ? (
        <p className="workspace__hint" data-testid="clip-preview-no-target">
          Select an instance in the Hierarchy — or pin one — to preview its clips.
        </p>
      ) : (
        <>
          <div className="workspace__row">
            <label>
              Source
              <select
                value={sourceKind}
                data-testid="clip-preview-source-kind"
                onChange={(event) => {
                  // Switching source kind clears the selection rather than
                  // guessing an equivalent: a state and a clip are not the same
                  // thing, and there is no honest mapping between them.
                  setSourceKind(event.target.value === 'clip' ? 'clip' : 'state');
                  setSource(null);
                }}
              >
                <option value="state">By State</option>
                <option value="clip">By Clip</option>
              </select>
            </label>

            {sourceKind === 'state' ? (
              <>
                <label>
                  Layer
                  <select
                    value={activeLayer}
                    data-testid="clip-preview-layer"
                    onChange={(event) => {
                      const layer = event.target.value as 'locomotion' | 'action';
                      const first = statesOnLayer(target, layer)[0];
                      setSource(first ? { kind: 'state', layer, stateId: first.id } : null);
                    }}
                  >
                    {layers.map((layer) => (
                      <option key={layer} value={layer}>
                        {layer}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  State
                  <select
                    value={preview.source?.kind === 'state' ? preview.source.stateId : ''}
                    data-testid="clip-preview-state"
                    onChange={(event) =>
                      setSource(
                        event.target.value
                          ? {
                              kind: 'state',
                              layer: activeLayer as 'locomotion' | 'action',
                              stateId: event.target.value,
                            }
                          : null,
                      )
                    }
                  >
                    <option value="">None</option>
                    {/* This target's behaviour, not a global one. Two instances
                        on different Character Definitions must not be offered
                        each other's states. */}
                    {statesOnLayer(target, activeLayer).map((state) => (
                      <option key={state.id} value={state.id}>
                        {state.id}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            ) : (
              <label>
                Clip
                <select
                  value={preview.source?.kind === 'clip' ? preview.source.clipId : ''}
                  data-testid="clip-preview-clip-select"
                  onChange={(event) =>
                    setSource(event.target.value ? { kind: 'clip', clipId: event.target.value } : null)
                  }
                >
                  <option value="">None</option>
                  {/* Reachable through this character's Motion Set, not every
                      clip in the repository. */}
                  {reachableClips(target).map((clip) => (
                    <option key={clip.id} value={clip.id}>
                      {clip.id} · {clip.durationSec.toFixed(2)} s
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>

          {preview.source && (
            <ClipPreviewMetadata
              target={target}
              source={preview.source}
              durationSec={durationSec}
            />
          )}

          {preview.source?.kind === 'clip' && (
            <p className="workspace__hint" data-testid="clip-preview-clip-note">
              A clip chosen directly has no state to substitute into the viewport pose. The metadata
              and the transport describe it; the character keeps showing authored behaviour.
            </p>
          )}

          {preview.source && durationSec <= 0 && (
            <p className="workspace__hint" data-testid="clip-preview-unbound">
              Nothing is bound here in this context, so there is no clip time to play.
            </p>
          )}

          {/* Root motion, Phase 1: In Place. Claiming runtime root-motion
              fidelity from a pose sampler would be the same category of
              overstatement this workspace exists to remove. */}
          <p className="workspace__hint" data-testid="clip-preview-root-motion">
            Root motion: <b>In Place</b>. The instance stays where the world says it stands.
          </p>

          <ClipPreviewTransport durationSec={durationSec} />
        </>
      )}
    </div>
  );
}

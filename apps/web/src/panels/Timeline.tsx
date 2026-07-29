import { useEffect, useState } from 'react';
import { HapticPlayer } from '@atc/haptics-runtime';
import { useChamber } from '../store.ts';

const TRACKS = [
  'Animation',
  'Semantic Events',
  'Hitbox',
  'Hurtbox',
  'Root Motion',
  'Foot Contacts',
  'Audio markers',
  'VFX markers',
  'Haptics',
  'Adaptive Trigger',
  'Cancel Window',
] as const;

const EVENT_COLORS: Record<string, string> = {
  AttackWindup: '#fbbf24',
  AttackHit: '#ef4444',
  AttackRecoil: '#a78bfa',
  FootContactLeft: '#22c55e',
  FootContactRight: '#ef4444',
  JumpTakeoff: '#38bdf8',
  Landing: '#f97316',
  DodgeStart: '#14b8a6',
  DodgeEnd: '#0d9488',
  DamageReceived: '#dc2626',
  GuardImpact: '#94a3b8',
};

/**
 * Animation Timeline (PLAN 8.4). Tracks are driven by the selected state's clip:
 * semantic events, foot contacts and haptics all reference the same normalized
 * time, which is what keeps a hit, its sound cue and its rumble in sync.
 */
export function Timeline() {
  const project = useChamber((state) => state.project);
  const selectedStateId = useChamber((state) => state.selectedStateId);
  const selectedTransitionId = useChamber((state) => state.selectedTransitionId);
  const engine = useChamber((state) => state.engine);
  const [playhead, setPlayhead] = useState(0);

  useEffect(() => {
    const unsubscribe = engine.subscribe(() => {
      const record = engine.lastRecord;
      if (!record) return;
      const state = project.graph.states.find((entry) => entry.id === selectedStateId);
      setPlayhead(
        state?.layer === 'action' ? record.actionNormalizedTime : record.locomotionNormalizedTime,
      );
    });
    return unsubscribe;
  }, [engine, project, selectedStateId]);

  const state = project.graph.states.find((entry) => entry.id === selectedStateId);
  const clip = project.clips.find((entry) => entry.id === state?.clipId);
  const transition = project.graph.transitions.find((entry) => entry.id === selectedTransitionId);

  if (!clip) return <div className="panel">Select a state to see its timeline.</div>;

  const percent = (value: number): string => `${Math.min(100, Math.max(0, value * 100))}%`;

  return (
    <div className="panel timeline" data-testid="timeline">
      <header className="panel__header">
        <h2>Timeline</h2>
        <span className="muted">
          {clip.id} · {clip.durationSec.toFixed(2)}s · {clip.loop ? 'loop' : 'one-shot'}
        </span>
      </header>

      <div className="timeline__tracks">
        {TRACKS.map((track) => (
          <div className="timeline__row" key={track}>
            <span className="timeline__label">{track}</span>
            <div className="timeline__lane">
              {track === 'Animation' && <div className="lane-bar" />}

              {track === 'Semantic Events' &&
                clip.events.map((event) => (
                  <span
                    key={event.id}
                    className="marker"
                    style={{ left: percent(event.at), background: EVENT_COLORS[event.kind] ?? '#94a3b8' }}
                    title={`${event.kind} @ ${event.at}${
                      event.protection ? ` (${event.protection.level})` : ''
                    }`}
                  />
                ))}

              {track === 'Hitbox' &&
                clip.events
                  .filter((event) => event.kind === 'AttackHit')
                  .map((event) => (
                    <span
                      key={event.id}
                      className="window"
                      style={{ left: percent(event.at - 0.04), width: percent(0.12) }}
                      title="hitbox window, anchored to AttackHit"
                    />
                  ))}

              {track === 'Foot Contacts' && (
                <>
                  {clip.footContacts.left.map((window, index) => (
                    <span
                      key={`l${index}`}
                      className="window window--left"
                      style={{ left: percent(window.start), width: percent(window.end - window.start) }}
                      title="left foot planted"
                    />
                  ))}
                  {clip.footContacts.right.map((window, index) => (
                    <span
                      key={`r${index}`}
                      className="window window--right"
                      style={{ left: percent(window.start), width: percent(window.end - window.start) }}
                      title="right foot planted"
                    />
                  ))}
                </>
              )}

              {track === 'Root Motion' && (
                <span className="lane-note">
                  {clip.rootMotionMode} · Δ{clip.rootDisplacement.z.toFixed(2)}m forward
                </span>
              )}

              {track === 'Haptics' &&
                project.haptics.bindings
                  .filter((binding) => clip.events.some((event) => event.kind === binding.event))
                  .map((binding) => {
                    const event = clip.events.find((entry) => entry.kind === binding.event)!;
                    const widthNormalized = binding.durationMs / 1000 / clip.durationSec;
                    return (
                      <span
                        key={binding.id}
                        className="window window--haptic"
                        style={{
                          left: percent(event.at + binding.startDelayMs / 1000 / clip.durationSec),
                          width: percent(widthNormalized),
                        }}
                        title={`${binding.id}: ${binding.durationMs}ms, peak envelope ${HapticPlayer.envelopeAt(
                          binding,
                          binding.startDelayMs,
                        ).toFixed(2)}, requires ${binding.requiresTier}`}
                      />
                    );
                  })}

              {track === 'Adaptive Trigger' &&
                project.haptics.bindings
                  .filter(
                    (binding) =>
                      binding.adaptiveTriggerPreset !== 'off' &&
                      clip.events.some((event) => event.kind === binding.event),
                  )
                  .map((binding) => {
                    const event = clip.events.find((entry) => entry.kind === binding.event)!;
                    return (
                      <span
                        key={binding.id}
                        className="marker marker--trigger"
                        style={{ left: percent(event.at) }}
                        title={`${binding.adaptiveTriggerPreset} (experimental tier)`}
                      />
                    );
                  })}

              {track === 'Cancel Window' && transition?.cancelWindow && (
                <span
                  className="window window--cancel"
                  style={{
                    left: percent(transition.cancelWindow.start),
                    width: percent(transition.cancelWindow.end - transition.cancelWindow.start),
                  }}
                  title={`${transition.id} may fire in this window`}
                />
              )}

              {(track === 'Audio markers' || track === 'VFX markers' || track === 'Hurtbox') && (
                <span className="lane-note muted">
                  no authored markers — the semantic events above are the anchor points
                </span>
              )}
            </div>
          </div>
        ))}

        <div className="timeline__playhead" style={{ left: percent(playhead) }} />
      </div>
    </div>
  );
}

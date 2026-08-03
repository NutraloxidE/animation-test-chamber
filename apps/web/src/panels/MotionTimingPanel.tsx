import { useEffect, useRef, useState } from 'react';
import type { ClipTimeCurve } from '@atc/schema';
import { applyClipTimeCurve, clipForState, clipIdForState } from '@atc/animation-runtime';
import { useChamber } from '../store.ts';
import { WEAPON_MODES } from '../three/catalog.ts';
import { Field } from './Field.tsx';

const LINEAR: ClipTimeCurve = { x1: 0.25, y1: 0.25, x2: 0.75, y2: 0.75 };
const PRESETS: { label: string; curve: ClipTimeCurve }[] = [
  { label: 'Linear', curve: LINEAR },
  { label: 'Ease in', curve: { x1: 0.42, y1: 0, x2: 1, y2: 1 } },
  { label: 'Ease out', curve: { x1: 0, y1: 0, x2: 0.58, y2: 1 } },
  { label: 'Ease in-out', curve: { x1: 0.42, y1: 0, x2: 0.58, y2: 1 } },
];

type CurveKey = keyof ClipTimeCurve;

function elapsedAtSample(curve: ClipTimeCurve, sampled: number): number {
  let low = 0;
  let high = 1;
  for (let i = 0; i < 14; i += 1) {
    const elapsed = (low + high) / 2;
    const value = applyClipTimeCurve({ timeCurve: curve } as Parameters<typeof applyClipTimeCurve>[0], elapsed);
    if (value < sampled) low = elapsed;
    else high = elapsed;
  }
  return (low + high) / 2;
}

function CurveEditor({
  curve,
  playhead,
  onChange,
}: {
  curve: ClipTimeCurve;
  playhead: number;
  onChange: (curve: ClipTimeCurve) => void;
}) {
  const draggedPoint = useRef<1 | 2 | null>(null);
  const [activePoint, setActivePoint] = useState<1 | 2 | null>(null);
  const points = Array.from({ length: 41 }, (_, index) => {
    const elapsed = index / 40;
    const sampled = applyClipTimeCurve(
      {
        timeCurve: curve,
      } as Parameters<typeof applyClipTimeCurve>[0],
      elapsed,
    );
    return `${elapsed * 100},${100 - sampled * 100}`;
  }).join(' ');

  const setValue = (key: CurveKey, value: number) => onChange({ ...curve, [key]: value });
  const setPointFromPointer = (point: 1 | 2, svg: SVGSVGElement, clientX: number, clientY: number): void => {
    const rect = svg.getBoundingClientRect();
    const viewX = -8 + ((clientX - rect.left) / rect.width) * 116;
    const viewY = -8 + ((clientY - rect.top) / rect.height) * 116;
    const x = Math.max(0, Math.min(1, viewX / 100));
    const y = Math.max(0, Math.min(1, 1 - viewY / 100));
    onChange(point === 1 ? { ...curve, x1: x, y1: y } : { ...curve, x2: x, y2: y });
  };

  const startDrag = (point: 1 | 2, event: React.PointerEvent<SVGGElement>): void => {
    const svg = event.currentTarget.ownerSVGElement;
    if (!svg) return;
    event.preventDefault();
    draggedPoint.current = point;
    setActivePoint(point);
    svg.setPointerCapture(event.pointerId);
    setPointFromPointer(point, svg, event.clientX, event.clientY);
  };

  const moveDrag = (event: React.PointerEvent<SVGSVGElement>): void => {
    if (draggedPoint.current === null) return;
    setPointFromPointer(draggedPoint.current, event.currentTarget, event.clientX, event.clientY);
  };

  const endDrag = (): void => {
    draggedPoint.current = null;
    setActivePoint(null);
  };

  return (
    <>
      <svg
        className="timing-curve"
        viewBox="-8 -8 116 116"
        role="img"
        aria-label="Elapsed time to sampled animation time curve"
        data-testid="timing-curve"
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
      >
        <path className="timing-curve__grid" d="M0 0V100H100M0 50H100M50 0V100" />
        <path
          className="timing-curve__handles"
          d={`M0 100L${curve.x1 * 100} ${100 - curve.y1 * 100}M100 0L${curve.x2 * 100} ${100 - curve.y2 * 100}`}
        />
        <polyline className="timing-curve__line" points={points} />
        <g
          className={`timing-curve__control${activePoint === 1 ? ' is-active' : ''}`}
          data-testid="timing-control-1"
          onPointerDown={(event) => startDrag(1, event)}
        >
          <circle className="timing-curve__hit" cx={curve.x1 * 100} cy={100 - curve.y1 * 100} r="8" />
          <circle cx={curve.x1 * 100} cy={100 - curve.y1 * 100} r="3.5" />
        </g>
        <g
          className={`timing-curve__control${activePoint === 2 ? ' is-active' : ''}`}
          data-testid="timing-control-2"
          onPointerDown={(event) => startDrag(2, event)}
        >
          <circle className="timing-curve__hit" cx={curve.x2 * 100} cy={100 - curve.y2 * 100} r="8" />
          <circle cx={curve.x2 * 100} cy={100 - curve.y2 * 100} r="3.5" />
        </g>
        <circle
          className="timing-curve__playhead"
          cx={elapsedAtSample(curve, playhead) * 100}
          cy={100 - playhead * 100}
          r="3"
        />
      </svg>

      <div className="timing-presets">
        {PRESETS.map((preset) => (
          <button type="button" key={preset.label} onClick={() => onChange(preset.curve)}>
            {preset.label}
          </button>
        ))}
      </div>

      <div className="timing-controls">
        {(['x1', 'y1', 'x2', 'y2'] as const).map((key) => (
          <label key={key}>
            <span>{key.toUpperCase()}</span>
            <output data-testid={`timing-value-${key}`}>{curve[key].toFixed(2)}</output>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={curve[key]}
              onChange={(event) => setValue(key, Number(event.target.value))}
            />
          </label>
        ))}
      </div>
    </>
  );
}

/**
 * A curve belongs to a clip, and each weapon mode has its own attack clips, so
 * two modes only share a curve when the state has no per-weapon clip at all.
 * Which of those is true is invisible from the curve itself, so say it here:
 * one row naming every mode's clip, marking the one being edited and the ones
 * already diverged from the repository.
 */
function WeaponCurveRow({ stateId }: { stateId: string }) {
  const rawProject = useChamber((state) => state.project);
  /*
   * The *inspected* context, not any instance's loadout.
   *
   * This used to dispatch `setInstanceWeaponMode` on the focused instance, so
   * clicking a chip to see what the sword's curve looks like re-armed the
   * character in the viewport, staged a world edit and dirtied the world. The
   * chip reads as a view filter and behaved as an edit; separating the two is
   * the fix, and it is why the Graph header owns a Binding Context now.
   */
  const weaponModeId = useChamber((state) => state.motionBindingContext.weaponModeId);
  const setContext = useChamber((state) => state.setMotionBindingContext);
  const context = useChamber((state) => state.motionBindingContext);
  const session = useChamber((state) => state.session);
  useChamber((state) => state.revision);

  const state = rawProject.graph.states.find((entry) => entry.id === stateId);
  // A per-weapon clip is a contextual binding in the motion set now, so the
  // question "does this state vary by weapon" is asked of the bindings rather
  // than of a map on the state.
  const variesByWeapon =
    state !== undefined &&
    WEAPON_MODES.some(
      (mode) =>
        clipIdForState(rawProject, state.id, mode.id) !==
        clipIdForState(rawProject, state.id),
    );
  if (!state || !variesByWeapon) {
    return (
      <p className="muted weapon-curves__shared" data-testid="weapon-curves-shared">
        Shared by every weapon mode — this state has no per-weapon clip.
      </p>
    );
  }

  return (
    <div className="weapon-curves" data-testid="weapon-curves">
      {WEAPON_MODES.map((mode) => {
        const clipId = clipIdForState(rawProject, state.id, mode.id) ?? '';
        const field = session.fieldView(`/clips/${clipId}/timeCurve`);
        const edited =
          JSON.stringify(field.previewValue) !== JSON.stringify(field.repositoryValue);
        return (
          <button
            type="button"
            key={mode.id}
            className={`weapon-curves__chip${mode.id === weaponModeId ? ' is-current' : ''}${
              edited ? ' is-edited' : ''
            }`}
            data-testid={`weapon-curve-${mode.id}`}
            data-edited={edited ? 'true' : 'false'}
            title={clipId}
            onClick={() => setContext({ ...context, weaponModeId: mode.id })}
          >
            {mode.id}
            {edited && <span aria-label="edited"> •</span>}
          </button>
        );
      })}
    </div>
  );
}

export function MotionTimingPanel() {
  // The Graph workspace's target, under the inspected Binding Context — not a
  // globally resolved document that silently belongs to whichever character
  // happened to be active.
  const project = useChamber((state) => state.graphProject());
  const selectedStateId = useChamber((state) => state.selectedStateId);
  const selectState = useChamber((state) => state.selectState);
  const setPreviewValue = useChamber((state) => state.setPreviewValue);
  const stage = useChamber((state) => state.stage);
  const resetToRepository = useChamber((state) => state.resetToRepository);
  const session = useChamber((state) => state.session);
  const engine = useChamber((state) => state.engine);
  useChamber((state) => state.revision);
  const [playhead, setPlayhead] = useState(0);

  const state = project.graph.states.find((entry) => entry.id === selectedStateId) ?? project.graph.states[0]!;
  const clip = clipForState(project, state.id)!;
  const path = `/clips/${clip.id}/timeCurve`;
  const curve = clip.timeCurve ?? LINEAR;
  const field = session.fieldView(path);
  const changed = JSON.stringify(field.previewValue) !== JSON.stringify(field.repositoryValue);

  useEffect(
    () =>
      engine.subscribe(() => {
        const record = engine.lastRecord;
        if (!record) return;
        const active = state.layer === 'action' ? record.actionState === state.id : record.locomotionState === state.id;
        if (active) {
          setPlayhead(state.layer === 'action' ? record.actionNormalizedTime : record.locomotionNormalizedTime);
        }
      }),
    [engine, state.id, state.layer],
  );

  return (
    <div className="panel motion-timing" data-testid="motion-timing">
      <header className="panel__header">
        <div>
          <h2>Motion timing</h2>
          <p className="muted">Elapsed time → sampled pose and root displacement</p>
        </div>
        <select value={state.id} onChange={(event) => selectState(event.target.value)}>
          {project.graph.states.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.id}
            </option>
          ))}
        </select>
      </header>

      <CurveEditor
        curve={curve}
        playhead={playhead}
        onChange={(next) => setPreviewValue(path, next, { intent: 'Adjust motion timing' })}
      />

      <WeaponCurveRow stateId={state.id} />

      {/* Speed lives on the state, not the clip, so unlike the curve above it is
          one value for every weapon mode. Per-weapon pacing is the clip's own
          `durationSec`, edited in the inspector. */}
      <Field
        path={`/graph/states/${state.id}/speed`}
        label="Playback speed"
        min={0.05}
        max={4}
        step={0.01}
        format={(value) => `${value.toFixed(2)}× · ${(clip.durationSec / value).toFixed(2)}s`}
        testId={`timing-speed-${state.id}`}
      />

      <div className="timing-actions">
        <span className="muted">
          {clip.id} · {clip.durationSec.toFixed(2)}s
        </span>
        {(changed || field.needsSave) && (
          <>
            <button type="button" onClick={() => resetToRepository(path)}>
              Reset
            </button>
            <button
              type="button"
              className={field.staged ? 'is-staged' : field.needsSave ? 'needs-save' : ''}
              data-testid="timing-stage"
              onClick={() => stage(path)}
            >
              {field.staged ? '✓ Staged' : field.needsSave ? 'Save changes' : 'Stage'}
            </button>
            {field.staged && (
              <span className="timing-saved" role="status" data-testid="timing-stage-status">
                Saved to staged draft
              </span>
            )}
            {field.needsSave && (
              <span className="save-warning" role="status" data-testid="timing-save-warning">
                Changed since staged — save again
              </span>
            )}
          </>
        )}
      </div>
    </div>
  );
}

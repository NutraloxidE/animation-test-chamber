/**
 * The transport, in seconds.
 *
 * The readout is `0.18 s / 0.43 s` rather than a bare percentage on purpose:
 * the bug this replaces was a fixed one-second loop that made every clip take
 * the same time to play, and a normalized-only readout is exactly the display
 * that cannot show it.
 */
import { useEffect, useState } from 'react';
import { useChamber } from '../../store.ts';
import {
  MAX_PREVIEW_SPEED,
  MIN_PREVIEW_SPEED,
  formatPreviewTime,
  normalizedPreviewTime,
} from './clip-preview-state.ts';

/** One fixed-step sample. Frame stepping in clip time, not in render frames. */
const SAMPLE_STEP_SEC = 1 / 60;

export function ClipPreviewTransport({ durationSec }: { durationSec: number }) {
  const preview = useChamber((state) => state.clipPreview);
  const engine = useChamber((state) => state.worldEngine);
  const setPlaying = useChamber((state) => state.setClipPreviewPlaying);
  const setLoop = useChamber((state) => state.setClipPreviewLoop);
  const setSpeed = useChamber((state) => state.setClipPreviewSpeed);
  const setTimeSec = useChamber((state) => state.setClipPreviewTimeSec);
  const nudge = useChamber((state) => state.nudgeClipPreview);
  const clear = useChamber((state) => state.clearClipPreview);

  /*
   * The playhead lives in the engine while playing, because the engine is what
   * advances it. Sampling it on an interval keeps the readout honest without
   * putting a React render on every frame — and without the store and the
   * engine keeping two copies of one clock.
   */
  const [liveTimeSec, setLiveTimeSec] = useState(preview.timeSec);
  useEffect(() => {
    const id = window.setInterval(() => {
      setLiveTimeSec(engine.previewOverride?.timeSec ?? useChamber.getState().clipPreview.timeSec);
    }, 80);
    return () => window.clearInterval(id);
  }, [engine]);

  const timeSec = preview.playing ? liveTimeSec : preview.timeSec;
  const normalized = normalizedPreviewTime(timeSec, durationSec);
  const playable = durationSec > 0;

  return (
    <div className="clip-preview__transport" data-testid="clip-preview-transport">
      <div className="workspace__row">
        <button
          type="button"
          data-testid="clip-preview-play"
          disabled={!playable}
          onClick={() => setPlaying(true)}
        >
          Play
        </button>
        <button
          type="button"
          data-testid="clip-preview-pause"
          disabled={!playable}
          onClick={() => setPlaying(false)}
        >
          Pause
        </button>
        <button
          type="button"
          data-testid="clip-preview-stop"
          disabled={!playable}
          onClick={() => {
            setPlaying(false);
            setTimeSec(0);
          }}
        >
          Stop
        </button>
        <button
          type="button"
          data-testid="clip-preview-step-back"
          disabled={!playable}
          onClick={() => nudge(-SAMPLE_STEP_SEC)}
        >
          ◀ Frame
        </button>
        <button
          type="button"
          data-testid="clip-preview-step-forward"
          disabled={!playable}
          onClick={() => nudge(SAMPLE_STEP_SEC)}
        >
          Frame ▶
        </button>
        <label>
          Loop
          <input
            type="checkbox"
            checked={preview.loop}
            data-testid="clip-preview-loop"
            onChange={(event) => setLoop(event.target.checked)}
          />
        </label>
        <label>
          Speed
          <input
            type="number"
            min={MIN_PREVIEW_SPEED}
            max={MAX_PREVIEW_SPEED}
            step={0.1}
            value={preview.speed}
            data-testid="clip-preview-speed"
            onChange={(event) => setSpeed(Number(event.target.value))}
          />
        </label>
      </div>

      <div className="workspace__row">
        <input
          className="clip-preview__scrubber"
          type="range"
          min={0}
          max={durationSec > 0 ? durationSec : 1}
          step={0.001}
          value={timeSec}
          disabled={!playable}
          data-testid="clip-preview-scrubber"
          onChange={(event) => setTimeSec(Number(event.target.value))}
        />
        <span className="clip-preview__readout" data-testid="clip-preview-time">
          {formatPreviewTime(timeSec, durationSec)}
        </span>
        <span className="clip-preview__readout" data-testid="clip-preview-normalized">
          {(normalized * 100).toFixed(0)}%
        </span>
      </div>

      <div className="workspace__row">
        <button
          type="button"
          className="workspace__clear"
          data-testid="clip-preview-clear"
          disabled={preview.source === null}
          onClick={() => clear()}
        >
          Clear preview
        </button>
        <p className="workspace__hint">
          Clip Preview never writes to the project, the world or any asset. Leaving this workspace
          commits nothing; clearing restores authored behaviour.
        </p>
      </div>
    </div>
  );
}

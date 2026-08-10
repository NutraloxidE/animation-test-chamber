/**
 * Match audio.
 *
 * The repository ships no sound assets, and the brief is explicit that audio
 * must not become a dependency — so these cues are synthesised with the
 * platform's own WebAudio, a few oscillator envelopes and nothing else. No
 * files to load, no library to pull in, and a browser that refuses to give us
 * a context simply plays nothing while the match carries on.
 *
 * Autoplay policy means the context cannot exist before a gesture, so it is
 * created lazily on the first cue after one and every call is failure-tolerant.
 */
export type Cue =
  | "hit"
  | "player-hit"
  | "ko"
  | "pickup"
  | "level"
  | "purchase"
  | "heal"
  | "match-start"
  | "result";

interface Voice {
  wave: OscillatorType;
  from: number;
  to: number;
  seconds: number;
  gain: number;
}

const CUES: Record<Cue, Voice[]> = {
  hit: [{ wave: "square", from: 220, to: 120, seconds: 0.08, gain: 0.06 }],
  "player-hit": [
    { wave: "sawtooth", from: 180, to: 70, seconds: 0.16, gain: 0.11 },
    { wave: "square", from: 90, to: 60, seconds: 0.18, gain: 0.06 },
  ],
  ko: [
    { wave: "triangle", from: 320, to: 90, seconds: 0.32, gain: 0.1 },
    { wave: "sine", from: 160, to: 55, seconds: 0.4, gain: 0.08 },
  ],
  pickup: [
    { wave: "sine", from: 880, to: 1320, seconds: 0.09, gain: 0.07 },
    { wave: "sine", from: 1320, to: 1760, seconds: 0.09, gain: 0.05 },
  ],
  level: [
    { wave: "sine", from: 523, to: 784, seconds: 0.16, gain: 0.08 },
    { wave: "sine", from: 784, to: 1046, seconds: 0.22, gain: 0.07 },
  ],
  purchase: [{ wave: "triangle", from: 660, to: 990, seconds: 0.12, gain: 0.07 }],
  heal: [{ wave: "sine", from: 440, to: 660, seconds: 0.22, gain: 0.07 }],
  "match-start": [
    { wave: "sawtooth", from: 262, to: 392, seconds: 0.28, gain: 0.07 },
    { wave: "sine", from: 392, to: 523, seconds: 0.34, gain: 0.06 },
  ],
  result: [
    { wave: "triangle", from: 392, to: 262, seconds: 0.42, gain: 0.08 },
    { wave: "sine", from: 262, to: 196, seconds: 0.5, gain: 0.06 },
  ],
};

let context: AudioContext | null = null;
let unavailable = false;
/** Cue -> last play time, so a brawl cannot become a buzzsaw. */
const lastPlayed = new Map<Cue, number>();
const MIN_GAP_MS: Partial<Record<Cue, number>> = { hit: 70, "player-hit": 110, ko: 160, pickup: 90 };

function ensureContext(): AudioContext | null {
  if (unavailable) return null;
  if (context) return context;
  try {
    const Constructor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Constructor) {
      unavailable = true;
      return null;
    }
    context = new Constructor();
    return context;
  } catch {
    unavailable = true;
    return null;
  }
}

/** Plays one cue. Silently does nothing when audio is unavailable or muted. */
export function playCue(cue: Cue, volume = 1): void {
  const gap = MIN_GAP_MS[cue];
  const now = performance.now();
  if (gap !== undefined && now - (lastPlayed.get(cue) ?? -Infinity) < gap) return;
  lastPlayed.set(cue, now);

  const audio = ensureContext();
  if (!audio) return;
  try {
    if (audio.state === "suspended") void audio.resume();
    const start = audio.currentTime;
    for (const voice of CUES[cue]) {
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      oscillator.type = voice.wave;
      oscillator.frequency.setValueAtTime(voice.from, start);
      oscillator.frequency.exponentialRampToValueAtTime(Math.max(30, voice.to), start + voice.seconds);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, voice.gain * volume), start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + voice.seconds);
      oscillator.connect(gain).connect(audio.destination);
      oscillator.start(start);
      oscillator.stop(start + voice.seconds + 0.02);
    }
  } catch {
    /* A cue that will not play is never a reason to stop the match. */
  }
}

/**
 * A short rumble on the first connected pad, where the platform supports it.
 *
 * Feature-detected rather than assumed: most browsers expose no actuator at
 * all, and a controller unplugged mid-match must not throw.
 */
export function rumble(durationMs: number, strong: number, weak: number): void {
  try {
    const pads = typeof navigator.getGamepads === "function" ? navigator.getGamepads() : [];
    for (const pad of pads) {
      const actuator = (pad as unknown as { vibrationActuator?: { playEffect?: (type: string, options: unknown) => Promise<unknown> } })
        ?.vibrationActuator;
      if (!actuator?.playEffect) continue;
      void actuator
        .playEffect("dual-rumble", { duration: durationMs, strongMagnitude: strong, weakMagnitude: weak })
        .catch(() => undefined);
      return;
    }
  } catch {
    /* No haptics is a normal condition, not a failure. */
  }
}

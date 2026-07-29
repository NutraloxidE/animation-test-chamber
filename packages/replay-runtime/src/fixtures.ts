import type { ButtonAction, ReplayDefinition, ReplayFrame } from '@atc/schema';
import { FIXED_TIMESTEP_VERSION } from '@atc/schema';
import { emptyButtons, encodeButtons } from '@atc/input-runtime';

interface ScriptEntry {
  tick: number;
  move?: [number, number];
  hold?: ButtonAction[];
}

interface FixtureSpec {
  id: string;
  label: string;
  terrainPresetId: string;
  tickCount: number;
  initialPosition?: { x: number; y: number; z: number };
  script: ScriptEntry[];
}

function toFrame(entry: ScriptEntry): ReplayFrame {
  const buttons = emptyButtons();
  for (const action of entry.hold ?? []) buttons[action] = true;
  return {
    tick: entry.tick,
    moveX: entry.move?.[0] ?? 0,
    moveY: entry.move?.[1] ?? 0,
    lookX: 0,
    lookY: 0,
    buttons: encodeButtons(buttons),
  };
}

function buildFixture(spec: FixtureSpec): ReplayDefinition {
  return {
    schemaVersion: 1,
    id: spec.id,
    label: spec.label,
    revisionId: 'rev-0001',
    fixedTimestepVersion: FIXED_TIMESTEP_VERSION,
    seed: 1,
    terrainPresetId: spec.terrainPresetId,
    initialPosition: spec.initialPosition ?? { x: 0, y: 0, z: 0 },
    initialYawRad: 0,
    cameraYawRad: 0,
    tickCount: spec.tickCount,
    frames: spec.script.map(toFrame),
  };
}

/**
 * The required regression replays (PLAN 13.2). Each one is a deterministic
 * input script, not a recording, so the expectations are readable and a change
 * in behaviour shows up as a trace difference rather than as a mystery.
 */
export const REPLAY_FIXTURES: ReplayDefinition[] = [
  buildFixture({
    id: 'run-to-attack-forward',
    label: 'Run forward, then attack at speed',
    terrainPresetId: 'flat',
    tickCount: 150,
    script: [
      { tick: 0, move: [0, 1] },
      // Attack once the character has reached running speed.
      { tick: 70, move: [0, 1], hold: ['PrimaryAction'] },
      { tick: 74, move: [0, 1] },
      { tick: 140, move: [0, 0] },
    ],
  }),

  buildFixture({
    id: 'attack-01-to-attack-02',
    label: 'Combo cancel inside the window',
    terrainPresetId: 'flat',
    tickCount: 160,
    script: [
      { tick: 0, hold: ['PrimaryAction'] },
      { tick: 4 },
      // Second press lands inside attack-01's 0.35-0.8 cancel window.
      { tick: 30, hold: ['PrimaryAction'] },
      { tick: 34 },
    ],
  }),

  buildFixture({
    id: 'late-dodge-cancel',
    label: 'Dodge cancel late in the attack recovery',
    terrainPresetId: 'flat',
    tickCount: 160,
    script: [
      { tick: 0, hold: ['PrimaryAction'] },
      { tick: 4 },
      // Dodge press falls inside attack-01's 0.5-0.95 dodge cancel window.
      { tick: 36, hold: ['Dodge'] },
      { tick: 40 },
    ],
  }),

  buildFixture({
    id: 'jump-buffer-before-landing',
    label: 'Jump pressed just before touchdown is honoured',
    terrainPresetId: 'flat',
    tickCount: 200,
    script: [
      { tick: 0, move: [0, 1] },
      { tick: 30, move: [0, 1], hold: ['Jump'] },
      { tick: 34, move: [0, 1] },
      // Airborne for ~43 ticks, so this press lands a few ticks before
      // touchdown — inside the 140ms jump buffer, and must survive to fire on
      // landing rather than being dropped.
      { tick: 66, move: [0, 1], hold: ['Jump'] },
      { tick: 70, move: [0, 1] },
      { tick: 190, move: [0, 0] },
    ],
  }),

  buildFixture({
    id: 'downhill-root-motion',
    label: 'Running downhill with root motion projection',
    terrainPresetId: 'gentle-downhill',
    tickCount: 220,
    script: [
      { tick: 0, move: [0, 1] },
      { tick: 210, move: [0, 0] },
    ],
  }),

  buildFixture({
    id: 'stair-foot-ik',
    label: 'Ascending stairs with foot IK enabled',
    terrainPresetId: 'stairs',
    tickCount: 260,
    script: [
      { tick: 0, move: [0, 1] },
      { tick: 250, move: [0, 0] },
    ],
  }),

  buildFixture({
    id: 'moving-platform-jump',
    label: 'Jumping while riding a moving platform',
    terrainPresetId: 'moving-platform',
    tickCount: 240,
    // Starts standing on the moving platform so the test is about velocity
    // inheritance and re-landing, not about traversing to it.
    initialPosition: { x: 0, y: 0, z: 8 },
    script: [
      { tick: 30, hold: ['Jump'] },
      { tick: 34 },
      { tick: 140, hold: ['Jump'] },
      { tick: 144 },
    ],
  }),

  buildFixture({
    id: 'ice-surface-stop',
    label: 'Releasing the stick on ice',
    terrainPresetId: 'ice',
    tickCount: 240,
    script: [
      { tick: 0, move: [0, 1] },
      // Stick released; the character should keep sliding, not stop dead.
      { tick: 90, move: [0, 0] },
    ],
  }),
];

export function findReplayFixture(id: string): ReplayDefinition {
  const fixture = REPLAY_FIXTURES.find((replay) => replay.id === id);
  if (!fixture) {
    throw new Error(
      `unknown replay "${id}"; available: ${REPLAY_FIXTURES.map((r) => r.id).join(', ')}`,
    );
  }
  return fixture;
}

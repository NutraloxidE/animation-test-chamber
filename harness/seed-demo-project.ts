/**
 * Seeds projects/demo-character/project.json.
 *
 * This is a deliberate, explicitly-invoked seed tool, NOT a generator: the
 * project file is canonical data that humans and AI edit through the chamber
 * afterwards. It is not part of `harness:one-shot` and repo-guard does not treat
 * project.json as a generated artifact. Running it overwrites human edits, so it
 * refuses unless --force is passed when the file already exists.
 */
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AnimationClipDefinition, ProjectDefinition, StateDefinition, TransitionDefinition } from '@atc/schema';
import { validateProject, validateProjectReferences } from '@atc/schema';

const here = dirname(fileURLToPath(import.meta.url));
const outputPath = resolve(here, '../projects/demo-character/project.json');

const clip = (id: string, durationSec: number, loop: boolean, overrides: Partial<AnimationClipDefinition> = {}): AnimationClipDefinition => ({
  schemaVersion: 1,
  id,
  assetPath: null,
  proceduralGenerator: id,
  durationSec,
  loop,
  rootDisplacement: { x: 0, y: 0, z: 0 },
  rootMotionMode: 'InPlace',
  events: [],
  footContacts: { left: [{ start: 0, end: 1 }], right: [{ start: 0, end: 1 }] },
  ...overrides,
});

const clips: AnimationClipDefinition[] = [
  clip('idle', 2, true),
  clip('walk', 1, true, {
    rootDisplacement: { x: 0, y: 0, z: 1.6 },
    rootMotionMode: 'Hybrid',
    footContacts: {
      left: [{ start: 0, end: 0.45 }],
      right: [{ start: 0.5, end: 0.95 }],
    },
    events: [
      { id: 'walk-foot-l', kind: 'FootContactLeft', at: 0.02 },
      { id: 'walk-foot-r', kind: 'FootContactRight', at: 0.52 },
    ],
  }),
  clip('run', 0.7, true, {
    rootDisplacement: { x: 0, y: 0, z: 4.2 },
    rootMotionMode: 'Hybrid',
    footContacts: {
      left: [{ start: 0, end: 0.3 }],
      right: [{ start: 0.5, end: 0.8 }],
    },
    events: [
      { id: 'run-foot-l', kind: 'FootContactLeft', at: 0.05 },
      { id: 'run-foot-r', kind: 'FootContactRight', at: 0.55 },
    ],
  }),
  clip('jump', 0.5, false, {
    footContacts: { left: [], right: [] },
    events: [{ id: 'jump-takeoff', kind: 'JumpTakeoff', at: 0.02 }],
  }),
  clip('fall', 0.8, true, { footContacts: { left: [], right: [] } }),
  clip('land', 0.35, false, {
    events: [{ id: 'land-impact', kind: 'Landing', at: 0.05 }],
  }),
  clip('slide', 0.6, true, {
    footContacts: {
      left: [{ start: 0, end: 1 }],
      right: [{ start: 0, end: 1 }],
    },
  }),
  clip('action-none', 0.5, true, { footContacts: { left: [], right: [] } }),
  clip('attack-01', 0.75, false, {
    rootDisplacement: { x: 0, y: 0, z: 0.45 },
    rootMotionMode: 'RootMotion',
    footContacts: {
      left: [{ start: 0, end: 0.6 }],
      right: [{ start: 0.2, end: 1 }],
    },
    events: [
      { id: 'a1-windup', kind: 'AttackWindup', at: 0.15 },
      {
        id: 'a1-hit',
        kind: 'AttackHit',
        at: 0.42,
        // The hit event and its hitbox window must stay in sync; tuning the
        // transition must not silently desynchronize them.
        protection: {
          level: 'approval-required',
          reason: 'hit timing confirmed by hand',
        },
      },
      { id: 'a1-recoil', kind: 'AttackRecoil', at: 0.7 },
    ],
  }),
  clip('attack-02', 0.85, false, {
    rootDisplacement: { x: 0, y: 0, z: 0.7 },
    rootMotionMode: 'RootMotion',
    footContacts: {
      left: [{ start: 0, end: 0.5 }],
      right: [{ start: 0.3, end: 1 }],
    },
    events: [
      { id: 'a2-windup', kind: 'AttackWindup', at: 0.2 },
      { id: 'a2-hit', kind: 'AttackHit', at: 0.5 },
      { id: 'a2-recoil', kind: 'AttackRecoil', at: 0.78 },
    ],
  }),
  clip('dodge', 1.4666667, false, {
    rootDisplacement: { x: 0, y: 0, z: 5.5 },
    rootMotionMode: 'RootMotion',
    rootMotionCurve: 'FastInSlowOut',
    recoveryTransitionStartNormalized: 0.72,
    footContacts: {
      left: [{ start: 0.7, end: 1 }],
      right: [{ start: 0.7, end: 1 }],
    },
    events: [
      { id: 'dodge-start', kind: 'DodgeStart', at: 0.05 },
      { id: 'dodge-end', kind: 'DodgeEnd', at: 0.85 },
    ],
  }),
  clip('guard', 0.6, true, {}),
  clip('hit', 0.45, false, {
    events: [{ id: 'hit-damage', kind: 'DamageReceived', at: 0.05 }],
  }),
];

const state = (id: string, clipId: string, layer: 'locomotion' | 'action', overrides: Partial<StateDefinition> = {}): StateDefinition => ({
  schemaVersion: 1,
  id,
  clipId,
  layer,
  loop: true,
  speed: 1,
  timeoutSec: 0,
  allowReEntry: false,
  interruptible: true,
  bodyMask: layer === 'action' ? 'upper' : 'full',
  ...overrides,
});

const states: StateDefinition[] = [
  state('idle', 'idle', 'locomotion'),
  state('walk', 'walk', 'locomotion'),
  state('run', 'run', 'locomotion'),
  state('jump', 'jump', 'locomotion', { loop: false, interruptible: false }),
  state('fall', 'fall', 'locomotion'),
  state('land', 'land', 'locomotion', { loop: false, fallbackState: 'idle' }),
  state('slide', 'slide', 'locomotion'),

  state('action-none', 'action-none', 'action', { bodyMask: 'upper' }),
  state('attack-01', 'attack-01', 'action', {
    loop: false,
    interruptible: false,
    fallbackState: 'action-none',
  }),
  state('attack-02', 'attack-02', 'action', {
    loop: false,
    interruptible: false,
    fallbackState: 'action-none',
  }),
  state('dodge', 'dodge', 'action', {
    loop: false,
    interruptible: false,
    fallbackState: 'action-none',
    bodyMask: 'full',
  }),
  state('guard', 'guard', 'action'),
  state('hit', 'hit', 'action', {
    loop: false,
    fallbackState: 'action-none',
    bodyMask: 'full',
  }),
];

const transition = (id: string, from: string, to: string, overrides: Partial<TransitionDefinition> = {}): TransitionDefinition => ({
  schemaVersion: 1,
  id,
  from,
  to,
  conditions: [],
  blendDurationSec: 0.15,
  startOffsetNormalized: 0,
  playbackSpeed: 1,
  momentumRetention: 1,
  rotationAuthority: 1,
  interruptible: true,
  inputBufferMs: 150,
  priority: 50,
  ...overrides,
});

const transitions: TransitionDefinition[] = [
  // --- Locomotion -----------------------------------------------------------
  transition('idle-to-walk', 'idle', 'walk', {
    conditions: [{ parameter: 'moveMagnitude', operator: 'greaterThan', value: 0.05 }],
    blendDurationSec: 0.18,
  }),
  transition('walk-to-idle', 'walk', 'idle', {
    conditions: [{ parameter: 'moveMagnitude', operator: 'lessOrEqual', value: 0.05 }],
    blendDurationSec: 0.2,
  }),
  transition('walk-to-run', 'walk', 'run', {
    conditions: [{ parameter: 'moveMagnitude', operator: 'greaterThan', value: 0.6 }],
    blendDurationSec: 0.16,
  }),
  transition('run-to-walk', 'run', 'walk', {
    conditions: [{ parameter: 'moveMagnitude', operator: 'lessOrEqual', value: 0.6 }],
    blendDurationSec: 0.16,
  }),
  transition('run-to-idle', 'run', 'idle', {
    conditions: [{ parameter: 'moveMagnitude', operator: 'lessOrEqual', value: 0.05 }],
    blendDurationSec: 0.24,
    priority: 60,
  }),
  transition('any-to-jump', '*', 'jump', {
    conditions: [
      { parameter: 'Jump', operator: 'buffered', value: 140 },
      { parameter: 'grounded', operator: 'equals', value: true },
    ],
    blendDurationSec: 0.06,
    priority: 200,
    interruptible: false,
    inputBufferMs: 140,
  }),
  transition('jump-to-fall', 'jump', 'fall', {
    conditions: [{ parameter: 'verticalVelocity', operator: 'lessThan', value: 0 }],
    blendDurationSec: 0.12,
    exitTimeNormalized: 0.2,
  }),
  transition('any-to-fall', '*', 'fall', {
    conditions: [{ parameter: 'airborne', operator: 'equals', value: true }],
    blendDurationSec: 0.14,
    priority: 120,
  }),
  transition('fall-to-land', 'fall', 'land', {
    conditions: [{ parameter: 'grounded', operator: 'equals', value: true }],
    blendDurationSec: 0.08,
    priority: 150,
  }),
  transition('land-to-idle', 'land', 'idle', {
    conditions: [{ parameter: 'moveMagnitude', operator: 'lessOrEqual', value: 0.05 }],
    exitTimeNormalized: 0.6,
    blendDurationSec: 0.15,
  }),
  transition('land-to-run', 'land', 'run', {
    conditions: [{ parameter: 'moveMagnitude', operator: 'greaterThan', value: 0.6 }],
    exitTimeNormalized: 0.25,
    blendDurationSec: 0.12,
  }),
  transition('any-to-slide', '*', 'slide', {
    conditions: [{ parameter: 'terrainState', operator: 'equals', value: 'Sliding' }],
    blendDurationSec: 0.1,
    priority: 160,
  }),
  transition('slide-to-idle', 'slide', 'idle', {
    conditions: [{ parameter: 'sliding', operator: 'equals', value: false }],
    blendDurationSec: 0.2,
  }),

  // --- Action ---------------------------------------------------------------
  transition('idle-to-attack-01', 'action-none', 'attack-01', {
    conditions: [{ parameter: 'PrimaryAction', operator: 'buffered', value: 160 }],
    blendDurationSec: 0.09,
    inputBufferMs: 160,
    priority: 100,
  }),
  transition('run-to-attack-01', 'action-none', 'attack-01', {
    conditions: [
      { parameter: 'PrimaryAction', operator: 'buffered', value: 160 },
      { parameter: 'speed', operator: 'greaterThan', value: 3 },
    ],
    blendDurationSec: 0.11,
    startOffsetNormalized: 0.03,
    momentumRetention: 0.78,
    interruptible: false,
    inputBufferMs: 160,
    priority: 110,
    // This is the worked example from the plan: a value a human tuned by feel.
    protection: {
      level: 'approval-required',
      reason: 'human-tuned',
      setBy: 'human',
      fields: { momentumRetention: 'locked' },
    },
    provenance: {
      source: 'human-adjustment',
      basedOnAiProposal: 0.08,
      humanFinal: 0.11,
      replayId: 'run-to-attack-forward',
      terrainPresetId: 'flat',
      intent: '初動を早めるが、切り替わりの硬さは残さない',
    },
  }),
  transition('attack-01-to-attack-02', 'attack-01', 'attack-02', {
    conditions: [{ parameter: 'PrimaryAction', operator: 'buffered', value: 200 }],
    blendDurationSec: 0.08,
    // Combo cancel window: only cancellable mid-swing, never on the first frame.
    cancelWindow: { start: 0.35, end: 0.8 },
    interruptible: true,
    inputBufferMs: 200,
    priority: 120,
  }),
  transition('attack-01-to-dodge', 'attack-01', 'dodge', {
    conditions: [{ parameter: 'Dodge', operator: 'buffered', value: 180 }],
    blendDurationSec: 0.07,
    cancelWindow: { start: 0.5, end: 0.95 },
    interruptible: true,
    inputBufferMs: 180,
    priority: 180,
  }),
  transition('any-to-dodge', 'action-none', 'dodge', {
    conditions: [{ parameter: 'Dodge', operator: 'buffered', value: 180 }],
    blendDurationSec: 0.07,
    inputBufferMs: 180,
    priority: 170,
  }),
  transition('idle-to-guard', 'action-none', 'guard', {
    conditions: [{ parameter: 'guardHeld', operator: 'equals', value: true }],
    blendDurationSec: 0.12,
    priority: 90,
  }),
  transition('guard-to-none', 'guard', 'action-none', {
    conditions: [{ parameter: 'guardHeld', operator: 'equals', value: false }],
    blendDurationSec: 0.14,
  }),
  transition('hit-to-none', 'hit', 'action-none', {
    conditions: [],
    exitTimeNormalized: 0.9,
    blendDurationSec: 0.12,
  }),
  transition('any-to-hit', '*', 'hit', {
    conditions: [{ parameter: 'damaged', operator: 'equals', value: true }],
    blendDurationSec: 0.05,
    priority: 250,
    interruptible: true,
  }),
];

const project: ProjectDefinition = {
  schemaVersion: 1,
  id: 'demo-character',
  displayName: 'Demo Character',
  revisionId: 'rev-0001',
  defaultTerrainPresetId: 'flat',
  character: {
    schemaVersion: 1,
    id: 'demo-humanoid',
    displayName: 'Procedural Humanoid',
    modelAssetPath: null,
    capsuleRadius: 0.3,
    capsuleHeight: 1.8,
    skeleton: {
      schemaVersion: 1,
      id: 'canonical-humanoid',
      height: 1.8,
      hipsBone: 'hips',
      leftFootBone: 'foot_l',
      rightFootBone: 'foot_r',
      bones: [
        {
          name: 'hips',
          parent: null,
          humanoid: 'Hips',
          restPosition: { x: 0, y: 0.95, z: 0 },
        },
        {
          name: 'spine',
          parent: 'hips',
          humanoid: 'Spine',
          restPosition: { x: 0, y: 1.2, z: 0 },
        },
        {
          name: 'chest',
          parent: 'spine',
          humanoid: 'Chest',
          restPosition: { x: 0, y: 1.4, z: 0 },
        },
        {
          name: 'head',
          parent: 'chest',
          humanoid: 'Head',
          restPosition: { x: 0, y: 1.68, z: 0 },
        },
        {
          name: 'upperarm_l',
          parent: 'chest',
          humanoid: 'LeftUpperArm',
          restPosition: { x: -0.2, y: 1.45, z: 0 },
        },
        {
          name: 'lowerarm_l',
          parent: 'upperarm_l',
          humanoid: 'LeftLowerArm',
          restPosition: { x: -0.45, y: 1.45, z: 0 },
        },
        {
          name: 'hand_l',
          parent: 'lowerarm_l',
          humanoid: 'LeftHand',
          restPosition: { x: -0.65, y: 1.45, z: 0 },
        },
        {
          name: 'upperarm_r',
          parent: 'chest',
          humanoid: 'RightUpperArm',
          restPosition: { x: 0.2, y: 1.45, z: 0 },
        },
        {
          name: 'lowerarm_r',
          parent: 'upperarm_r',
          humanoid: 'RightLowerArm',
          restPosition: { x: 0.45, y: 1.45, z: 0 },
        },
        {
          name: 'hand_r',
          parent: 'lowerarm_r',
          humanoid: 'RightHand',
          restPosition: { x: 0.65, y: 1.45, z: 0 },
        },
        {
          name: 'upperleg_l',
          parent: 'hips',
          humanoid: 'LeftUpperLeg',
          restPosition: { x: -0.12, y: 0.9, z: 0 },
        },
        {
          name: 'lowerleg_l',
          parent: 'upperleg_l',
          humanoid: 'LeftLowerLeg',
          restPosition: { x: -0.12, y: 0.5, z: 0 },
        },
        {
          name: 'foot_l',
          parent: 'lowerleg_l',
          humanoid: 'LeftFoot',
          restPosition: { x: -0.12, y: 0.08, z: 0.05 },
        },
        {
          name: 'upperleg_r',
          parent: 'hips',
          humanoid: 'RightUpperLeg',
          restPosition: { x: 0.12, y: 0.9, z: 0 },
        },
        {
          name: 'lowerleg_r',
          parent: 'upperleg_r',
          humanoid: 'RightLowerLeg',
          restPosition: { x: 0.12, y: 0.5, z: 0 },
        },
        {
          name: 'foot_r',
          parent: 'lowerleg_r',
          humanoid: 'RightFoot',
          restPosition: { x: 0.12, y: 0.08, z: 0.05 },
        },
      ],
    },
  },
  clips,
  graph: {
    schemaVersion: 1,
    id: 'demo-graph',
    layers: [
      {
        id: 'locomotion',
        order: 0,
        defaultState: 'idle',
        weight: 1,
        bodyMask: 'full',
      },
      {
        id: 'action',
        order: 1,
        defaultState: 'action-none',
        weight: 1,
        bodyMask: 'upper',
      },
    ],
    states,
    transitions,
    // Death is reserved even though the MVP has no death state (PLAN 7.1).
    forcedTransitionOrder: ['death', 'hit', 'dodge', 'guard', 'attack-02', 'attack-01', 'jump', 'slide', 'fall', 'land', 'run', 'walk', 'idle', 'action-none'],
  },
  inputMap: {
    schemaVersion: 1,
    id: 'default-input',
    keyboard: [
      { action: 'Jump', codes: ['Space'] },
      { action: 'Dodge', codes: ['ShiftLeft', 'ShiftRight'] },
      { action: 'PrimaryAction', codes: ['KeyJ', 'KeyF'] },
      { action: 'SecondaryAction', codes: ['KeyK'] },
      { action: 'Guard', codes: ['KeyL'] },
      { action: 'LockOn', codes: ['KeyQ'] },
      { action: 'Interact', codes: ['KeyE'] },
      { action: 'Pause', codes: ['Escape'] },
    ],
    gamepad: [
      { action: 'Jump', buttons: [0] },
      { action: 'PrimaryAction', buttons: [2] },
      { action: 'SecondaryAction', buttons: [3] },
      { action: 'Dodge', buttons: [1, 5] },
      { action: 'Guard', buttons: [6, 4] },
      { action: 'LockOn', buttons: [10] },
      { action: 'Interact', buttons: [7] },
      { action: 'Pause', buttons: [9] },
    ],
    stickDeadzone: 0.12,
    lookSensitivity: 1,
    invertLookY: false,
    mobilePad: {
      visibility: 'auto',
      stickMode: 'floating',
      leftHanded: false,
      buttonScale: 1,
      opacity: 0.75,
      hideForRecording: false,
    },
    defaultInputBufferMs: 150,
    coyoteTimeMs: 120,
    jumpBufferMs: 140,
  },
  movement: {
    schemaVersion: 1,
    id: 'demo-movement',
    walkSpeed: 1.8,
    runSpeed: 5.2,
    acceleration: 28,
    deceleration: 34,
    rotationSpeed: 12,
    airControl: 0.35,
    jumpHeight: 1.15,
    gravity: 18,
    coyoteTimeMs: 120,
    jumpBufferMs: 140,
    stopBehavior: 'decelerate',
    actionMovementAuthority: 0.25,
    momentumRetention: 0.8,
    cameraRelative: true,
    protection: {
      level: 'editable',
      // Jump height was signed off against the moving-platform replay; changing
      // it silently would invalidate that tuning.
      fields: { jumpHeight: 'locked' },
      reason: 'jump height confirmed against moving-platform-jump replay',
      setBy: 'human',
    },
  },
  rootMotion: {
    schemaVersion: 1,
    id: 'demo-root-motion',
    mode: 'Hybrid',
    horizontalAuthority: 0.35,
    verticalAuthority: 0,
    rotationAuthority: 0.5,
    terrainProjection: true,
    physicsAuthority: 0,
  },
  terrain: {
    schemaVersion: 1,
    id: 'demo-terrain',
    groundProbeDistance: 0.32,
    probeRadius: 0.28,
    maxWalkableSlopeRad: 0.85,
    slideStartAngleRad: 0.95,
    stepUpHeight: 0.42,
    groundSnapStrength: 0.85,
    downhillAdhesion: 0.6,
    slopeSpeedCompensation: 0.35,
    bodyTiltStrength: 0.4,
    footIkStrength: 0.8,
    footTargetSmoothing: 0.35,
    pelvisOffsetStrength: 0.6,
    rootMotionTerrainProjection: true,
    heavyLandingSpeed: 8,
    lightLandingSpeed: 1.5,
    obstaclePushback: 0.9,
    ledgeDetectDistance: 0.6,
    movingPlatformVelocityInheritance: 1,
    movingPlatformRotationInheritance: 1,
  },
  camera: {
    schemaVersion: 1,
    id: 'demo-camera',
    distance: 5.5,
    height: 2.2,
    lookAtHeight: 1.2,
    followLagSec: 0.12,
    minPitchRad: -0.6,
    maxPitchRad: 0.9,
    fovDeg: 55,
  },
  haptics: {
    schemaVersion: 1,
    id: 'demo-haptics',
    masterIntensity: 0.8,
    bindings: [
      {
        id: 'haptic-attack-hit',
        event: 'AttackHit',
        startDelayMs: 0,
        durationMs: 90,
        lowFrequencyMagnitude: 0.85,
        highFrequencyMagnitude: 0.5,
        curve: 'ease-out',
        leftTriggerMagnitude: 0,
        rightTriggerMagnitude: 0.7,
        adaptiveTriggerPreset: 'recoil',
        resistanceStart: 0.3,
        resistanceStrength: 0.6,
        breakPoint: 0.75,
        requiresTier: 'generic-rumble',
      },
      {
        id: 'haptic-landing',
        event: 'Landing',
        startDelayMs: 0,
        durationMs: 120,
        lowFrequencyMagnitude: 0.6,
        highFrequencyMagnitude: 0.25,
        curve: 'ease-out',
        leftTriggerMagnitude: 0,
        rightTriggerMagnitude: 0,
        adaptiveTriggerPreset: 'off',
        resistanceStart: 0,
        resistanceStrength: 0,
        breakPoint: 0,
        requiresTier: 'generic-rumble',
      },
      {
        id: 'haptic-dodge',
        event: 'DodgeStart',
        startDelayMs: 0,
        durationMs: 60,
        lowFrequencyMagnitude: 0.3,
        highFrequencyMagnitude: 0.55,
        curve: 'ease-in-out',
        leftTriggerMagnitude: 0.4,
        rightTriggerMagnitude: 0.4,
        adaptiveTriggerPreset: 'pulse',
        resistanceStart: 0.2,
        resistanceStrength: 0.4,
        breakPoint: 0.5,
        requiresTier: 'trigger-rumble',
      },
      {
        id: 'haptic-footstep',
        event: 'FootContactLeft',
        startDelayMs: 0,
        durationMs: 35,
        lowFrequencyMagnitude: 0.12,
        highFrequencyMagnitude: 0.08,
        curve: 'linear',
        leftTriggerMagnitude: 0,
        rightTriggerMagnitude: 0,
        adaptiveTriggerPreset: 'off',
        resistanceStart: 0,
        resistanceStrength: 0,
        breakPoint: 0,
        requiresTier: 'generic-rumble',
      },
    ],
  },
  preferences: {
    schemaVersion: 1,
    preferredBlendMinSec: 0.06,
    preferredBlendMaxSec: 0.22,
    responsiveness: 0.6,
    momentumPreference: 0.7,
    rootMotionPolicy: 'prefer-hybrid',
    ikCorrectionPreference: 0.8,
    hapticIntensityPreference: 0.6,
    acceptanceHistory: [],
  },
  candidates: [],
  revisions: [
    {
      schemaVersion: 1,
      id: 'rev-0001',
      parentId: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      author: 'seed',
      message: 'seed demo character',
      changedPaths: [],
    },
  ],
  invariants: [
    {
      path: '/haptics/bindings/haptic-landing',
      reason: 'landing feedback must survive on every device tier',
    },
    {
      path: '/graph/forcedTransitionOrder',
      reason: 'forced transition ordering is a project-wide rule',
    },
    {
      path: '/inputMap/keyboard/Jump',
      reason: 'jump must always be reachable from the keyboard',
    },
  ],
};

const force = process.argv.includes('--force');
if (existsSync(outputPath) && !force) {
  console.error(`refusing to overwrite canonical data at ${outputPath}\n` + 'project.json is edited by humans through the chamber. Pass --force if you really mean it.');
  process.exit(1);
}

const schemaResult = validateProject(project);
const referenceResult = validateProjectReferences(project);
if (!schemaResult.valid || !referenceResult.valid) {
  console.error('seed project failed validation:');
  for (const issue of [...schemaResult.issues, ...referenceResult.issues]) {
    console.error(`  ${issue.path}: ${issue.message}`);
  }
  process.exit(1);
}

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(project, null, 2)}\n`, 'utf8');
console.log(`wrote ${outputPath}`);

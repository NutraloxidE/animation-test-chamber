import type {
  AnimationClipDefinition,
  AssetProvenance,
  AssetState,
  CandidateAsset,
  LicenseManifest,
  MotionBrief,
  ProjectDefinition,
} from '@atc/schema';
import { canAiEdit, canHumanEdit } from '@atc/runtime-core';
import { detectFormat, looksLikeGlb, parseGlb } from './glb.ts';
import { missingLicenseAnswers } from './license.ts';

export interface ImportRequest {
  filename: string;
  bytes: Uint8Array;
  license: LicenseManifest;
  brief?: MotionBrief;
  /** Clip this asset is intended to replace, if any. */
  replacesClipId?: string;
  contentHash: string;
}

export interface ImportResult {
  candidate: CandidateAsset | null;
  /** Set when the format needs the animation worker. */
  pendingJob: PendingConversionJob | null;
  errors: string[];
}

export interface PendingConversionJob {
  format: 'fbx' | 'bvh' | 'gltf';
  filename: string;
  contentHash: string;
  reason: string;
}

/** Allowed lifecycle moves (PLAN 15.5). Anything else is refused. */
const TRANSITIONS: Record<AssetState, AssetState[]> = {
  Imported: ['Candidate', 'Rejected'],
  Candidate: ['Retargeted', 'Rejected'],
  Retargeted: ['Validated', 'Rejected'],
  Validated: ['HumanAccepted', 'Rejected'],
  HumanAccepted: ['Registered', 'Rejected'],
  Registered: ['Rejected'],
  Rejected: [],
};

export function canPromote(from: AssetState, to: AssetState): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * Imports an asset into the candidate registry.
 *
 * GLB is handled directly and always works. Formats that need conversion are
 * not treated as failures — they become an explicit pending job, so a machine
 * without the Blender worker still records provenance and licence rather than
 * silently dropping the import (PLAN 15.2).
 */
export function importAsset(request: ImportRequest): ImportResult {
  const errors: string[] = [];
  const format = detectFormat(request.filename);

  if (!format) {
    return {
      candidate: null,
      pendingJob: null,
      errors: [`unsupported file extension for "${request.filename}"; expected .glb, .gltf, .fbx or .bvh`],
    };
  }

  if (format !== 'glb') {
    return {
      candidate: null,
      pendingJob: {
        format,
        filename: request.filename,
        contentHash: request.contentHash,
        reason: `${format.toUpperCase()} requires the animation worker to convert to GLB before import`,
      },
      errors: [],
    };
  }

  if (!looksLikeGlb(request.bytes)) {
    return {
      candidate: null,
      pendingJob: null,
      errors: ['file is named .glb but does not start with the glTF magic bytes'],
    };
  }

  let info;
  try {
    info = parseGlb(request.bytes);
  } catch (error) {
    return {
      candidate: null,
      pendingJob: null,
      errors: [error instanceof Error ? error.message : 'failed to parse GLB'],
    };
  }

  if (info.animations.length === 0) {
    errors.push('GLB contains no animation clips');
  }
  if (!info.hasSkin) {
    errors.push('GLB contains no skin; retargeting to the canonical humanoid will be approximate');
  }

  const licenceGaps = missingLicenseAnswers(request.license);
  if (licenceGaps.length > 0) {
    errors.push(`licence fields still unknown: ${licenceGaps.join(', ')}`);
  }

  const provenance: AssetProvenance = {
    schemaVersion: 1,
    contentHash: request.contentHash,
    originalFilename: request.filename,
    originalFormat: 'glb',
    importedAt: new Date().toISOString(),
    pipeline: ['acquire', 'verify-license-metadata', 'import', 'analyze-skeleton'],
    license: request.license,
  };

  const longest = info.animations.reduce((max, clip) => Math.max(max, clip.durationSec), 0);

  const candidate: CandidateAsset = {
    schemaVersion: 1,
    id: candidateIdFor(request.filename, request.contentHash),
    // Imported, not Candidate: promotion is a separate, explicit step.
    state: 'Imported',
    ...(request.brief ? { brief: request.brief } : {}),
    provenance,
    discoveredClips: info.animations.map((clip) => clip.name),
    durationSec: longest,
    issues: errors,
    replacesClipId: request.replacesClipId ?? null,
  };

  return { candidate, pendingJob: null, errors: [] };
}

function candidateIdFor(filename: string, hash: string): string {
  const stem = filename
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${stem || 'candidate'}-${hash.slice(0, 8)}`;
}

export interface PromotionResult {
  ok: boolean;
  candidate: CandidateAsset | null;
  reason: string;
}

/**
 * Moves a candidate along its lifecycle, enforcing the two rules that protect
 * existing work: validation gaps block promotion past Validated, and a clip
 * under protection is never replaced by tooling.
 */
export function promoteCandidate(
  project: ProjectDefinition,
  candidateId: string,
  to: AssetState,
  actor: 'human' | 'ai' = 'human',
): PromotionResult {
  const candidate = project.candidates.find((entry) => entry.id === candidateId);
  if (!candidate) return { ok: false, candidate: null, reason: `unknown candidate "${candidateId}"` };

  if (!canPromote(candidate.state, to)) {
    return {
      ok: false,
      candidate,
      reason: `cannot move a candidate from ${candidate.state} to ${to}`,
    };
  }

  if (to === 'Validated' && candidate.issues.length > 0) {
    return {
      ok: false,
      candidate,
      reason: `candidate still has ${candidate.issues.length} unresolved issue(s)`,
    };
  }

  if (to === 'HumanAccepted' && actor !== 'human') {
    return {
      ok: false,
      candidate,
      reason: 'only a human can mark an asset as HumanAccepted',
    };
  }

  if (to === 'Registered' && candidate.replacesClipId) {
    const clipPath = `/clips/${candidate.replacesClipId}`;
    const allowed = actor === 'human' ? canHumanEdit(project, clipPath) : canAiEdit(project, clipPath);
    if (!allowed) {
      return {
        ok: false,
        candidate,
        reason: `clip "${candidate.replacesClipId}" is protected and cannot be replaced automatically`,
      };
    }
  }

  return { ok: true, candidate: { ...candidate, state: to }, reason: '' };
}

/**
 * Builds the clip definition a registered candidate contributes. Only called
 * once the candidate reaches HumanAccepted.
 */
export function candidateToClip(
  candidate: CandidateAsset,
  clipName: string,
  assetPath: string,
): AnimationClipDefinition {
  return {
    schemaVersion: 1,
    id: `${candidate.id}-${clipName}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-'),
    assetPath,
    durationSec: Math.max(candidate.durationSec, 0.01),
    loop: candidate.brief?.loop ?? false,
    rootDisplacement: { x: 0, y: 0, z: 0 },
    rootMotionMode: candidate.brief?.rootMotionRequired ? 'RootMotion' : 'InPlace',
    events: [],
    // Contacts are unknown until the clip is analyzed; an empty list is honest,
    // an invented full-contact window would silently corrupt foot IK.
    footContacts: { left: [], right: [] },
    provenance: { source: 'import' },
  };
}

/** Structures a free-text motion request (PLAN 15.3). */
export function buildMotionBrief(id: string, request: string): MotionBrief {
  const lower = request.toLowerCase();
  const has = (...terms: string[]): boolean => terms.some((term) => lower.includes(term));

  return {
    schemaVersion: 1,
    id,
    action: request.slice(0, 80),
    purpose: '',
    style: has('heavy', '重') ? 'heavy' : has('light', '軽') ? 'light' : '',
    minDurationSec: 0,
    maxDurationSec: 0,
    rootMotionRequired: has('move', 'forward', 'step', '移動', '前進'),
    loop: has('loop', 'idle', 'walk', 'run', 'ループ', '歩', '走'),
    startPose: '',
    endPose: '',
    direction: has('forward', '前') ? 'forward' : has('back', '後') ? 'backward' : '',
    weapon: '',
    footContactExpectation: '',
    mirroringAllowed: true,
  };
}

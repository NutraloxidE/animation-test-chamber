import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { LicenseManifest } from '@atc/schema';
import {
  canCommitRawAsset,
  detectFormat,
  importAsset,
  looksLikeGlb,
  missingLicenseAnswers,
  parseGlb,
  promoteCandidate,
  unknownLicenseManifest,
  canPromote,
  createWorkerClient,
} from '@atc/acquisition-core';
import { loadDemoProject } from '../fixtures/project.ts';

/** Builds a minimal but structurally valid GLB with one animation. */
function buildGlb(options: { animations?: boolean; skin?: boolean } = {}): Uint8Array {
  const gltf: Record<string, unknown> = {
    asset: { version: '2.0', generator: 'test' },
    nodes: [{ name: 'hips' }, { name: 'foot_l' }],
    accessors: [{ max: [1.25], min: [0] }],
    ...(options.skin ? { skins: [{ joints: [0, 1] }] } : {}),
    ...(options.animations !== false
      ? {
          animations: [
            { name: 'walk', channels: [{}, {}], samplers: [{ input: 0 }] },
          ],
        }
      : {}),
  };

  const jsonText = JSON.stringify(gltf);
  const padded = jsonText + ' '.repeat((4 - (jsonText.length % 4)) % 4);
  const jsonBytes = new TextEncoder().encode(padded);

  const total = 12 + 8 + jsonBytes.length;
  const buffer = new ArrayBuffer(total);
  const view = new DataView(buffer);
  view.setUint32(0, 0x46546c67, true); // "glTF"
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonBytes.length, true);
  view.setUint32(16, 0x4e4f534a, true); // "JSON"
  new Uint8Array(buffer, 20).set(jsonBytes);
  return new Uint8Array(buffer);
}

const verifiedLicense: LicenseManifest = {
  ...unknownLicenseManifest({
    provider: 'test',
    sourceType: 'import',
    sourceRef: 'test.glb',
    acquiredBy: 'tester',
  }),
  commercialUse: 'allowed',
  rawAssetRedistribution: 'allowed',
  teamSharing: 'allowed',
  publicRepository: 'allowed',
  attributionRequired: 'forbidden',
  verificationStatus: 'human-verified',
};

const hashOf = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

describe('GLB parsing', () => {
  it('recognises the glTF magic', () => {
    expect(looksLikeGlb(buildGlb())).toBe(true);
    expect(looksLikeGlb(new Uint8Array([1, 2, 3, 4]))).toBe(false);
  });

  it('extracts animations and their duration from accessor metadata', () => {
    const info = parseGlb(buildGlb({ skin: true }));
    expect(info.animations).toHaveLength(1);
    expect(info.animations[0]!.name).toBe('walk');
    expect(info.animations[0]!.durationSec).toBeCloseTo(1.25, 5);
    expect(info.hasSkin).toBe(true);
  });

  it('rejects a file that is not a GLB', () => {
    expect(() => parseGlb(new TextEncoder().encode('this is not a glb at all'))).toThrow(
      /not a GLB/,
    );
  });

  it('detects formats from the extension', () => {
    expect(detectFormat('a.glb')).toBe('glb');
    expect(detectFormat('a.FBX')).toBe('fbx');
    expect(detectFormat('a.bvh')).toBe('bvh');
    expect(detectFormat('a.png')).toBeNull();
  });
});

describe('licence policy', () => {
  it('treats unknown exactly like forbidden', () => {
    const manifest = unknownLicenseManifest({
      provider: 'somewhere',
      sourceType: 'search',
      sourceRef: 'x',
      acquiredBy: 'tester',
    });
    const decision = canCommitRawAsset(manifest, { repositoryIsPublic: true });
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.join(' ')).toContain('is unknown and is not assumed to be allowed');
  });

  it('refuses a raw asset that forbids public repository use', () => {
    const decision = canCommitRawAsset(
      { ...verifiedLicense, publicRepository: 'forbidden' },
      { repositoryIsPublic: true },
    );
    expect(decision.allowed).toBe(false);
  });

  it('refuses anything a human has not verified', () => {
    const decision = canCommitRawAsset(
      { ...verifiedLicense, verificationStatus: 'unverified' },
      { repositoryIsPublic: true },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.join(' ')).toContain('not been verified by a human');
  });

  it('allows a fully verified, permissive asset', () => {
    expect(canCommitRawAsset(verifiedLicense, { repositoryIsPublic: true }).allowed).toBe(true);
  });

  it('lists exactly the unanswered licence questions', () => {
    const manifest = { ...verifiedLicense, commercialUse: 'unknown' as const };
    expect(missingLicenseAnswers(manifest)).toEqual(['commercialUse']);
  });
});

describe('import', () => {
  it('imports a GLB as a candidate, not as a live clip', () => {
    const bytes = buildGlb({ skin: true });
    const result = importAsset({
      filename: 'sword-swing.glb',
      bytes,
      license: verifiedLicense,
      contentHash: hashOf(bytes),
    });
    expect(result.candidate).not.toBeNull();
    expect(result.candidate!.state).toBe('Imported');
    expect(result.candidate!.discoveredClips).toEqual(['walk']);
    expect(result.candidate!.provenance.contentHash).toBe(hashOf(bytes));
  });

  it('records licence gaps as issues rather than importing silently', () => {
    const bytes = buildGlb({ skin: true });
    const result = importAsset({
      filename: 'x.glb',
      bytes,
      license: unknownLicenseManifest({
        provider: 'p',
        sourceType: 'import',
        sourceRef: 'x',
        acquiredBy: 't',
      }),
      contentHash: hashOf(bytes),
    });
    expect(result.candidate!.issues.join(' ')).toContain('licence fields still unknown');
  });

  it('turns an FBX into an explicit pending job instead of failing', () => {
    const result = importAsset({
      filename: 'motion.fbx',
      bytes: new Uint8Array([0, 1, 2]),
      license: verifiedLicense,
      contentHash: 'abc12345',
    });
    expect(result.candidate).toBeNull();
    expect(result.pendingJob?.format).toBe('fbx');
    expect(result.errors).toEqual([]);
  });

  it('rejects a mislabelled .glb', () => {
    const result = importAsset({
      filename: 'fake.glb',
      bytes: new TextEncoder().encode('nope'),
      license: verifiedLicense,
      contentHash: 'abc12345',
    });
    expect(result.candidate).toBeNull();
    expect(result.errors.join(' ')).toContain('glTF magic');
  });
});

describe('candidate lifecycle', () => {
  const project = loadDemoProject();
  const bytes = buildGlb({ skin: true });
  const candidate = importAsset({
    filename: 'swing.glb',
    bytes,
    license: verifiedLicense,
    contentHash: hashOf(bytes),
  }).candidate!;

  const withCandidate = { ...project, candidates: [candidate] };

  it('only permits the declared lifecycle moves', () => {
    expect(canPromote('Imported', 'Candidate')).toBe(true);
    expect(canPromote('Imported', 'HumanAccepted')).toBe(false);
    expect(canPromote('Registered', 'Candidate')).toBe(false);
  });

  it('blocks promotion to Validated while issues remain', () => {
    const flawed = {
      ...withCandidate,
      candidates: [{ ...candidate, state: 'Retargeted' as const, issues: ['foot sliding'] }],
    };
    const result = promoteCandidate(flawed, candidate.id, 'Validated');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('unresolved issue');
  });

  it('never lets an AI mark an asset HumanAccepted', () => {
    const validated = {
      ...withCandidate,
      candidates: [{ ...candidate, state: 'Validated' as const, issues: [] }],
    };
    expect(promoteCandidate(validated, candidate.id, 'HumanAccepted', 'ai').ok).toBe(false);
    expect(promoteCandidate(validated, candidate.id, 'HumanAccepted', 'human').ok).toBe(true);
  });

  it('refuses to register over a protected clip', () => {
    const protectedProject = {
      ...withCandidate,
      clips: withCandidate.clips.map((clip) =>
        clip.id === 'attack-01'
          ? { ...clip, protection: { level: 'locked' as const, reason: 'signed off' } }
          : clip,
      ),
      candidates: [
        { ...candidate, state: 'HumanAccepted' as const, issues: [], replacesClipId: 'attack-01' },
      ],
    };
    const result = promoteCandidate(protectedProject, candidate.id, 'Registered', 'human');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('protected');
  });
});

describe('animation worker', () => {
  it('reports unavailable, with a usable instruction, when no URL is set', async () => {
    const client = createWorkerClient({});
    expect(client.available).toBe(false);
    const job = await client.submit({
      format: 'fbx',
      filename: 'a.fbx',
      contentHash: 'abcd1234',
      options: {
        targetFps: 60,
        targetSkeletonId: 'canonical-humanoid',
        extractRootMotion: true,
        upAxis: 'y',
        unitScale: 1,
      },
    });
    expect(job.status).toBe('unavailable');
    expect(job.message).toContain('ANIMATION_WORKER_URL');
  });
});

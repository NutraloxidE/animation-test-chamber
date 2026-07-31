import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AnimationAssetRegistry,
  assetHashMatches,
  buildLibraryIndex,
  canonicalJson,
  computeContentHash,
  sealAsset,
  sha256Hex,
  type StoredAsset,
} from '@atc/animation-asset-runtime';
import { demoRegistry, loadDemoAssets } from '../../fixtures/project.ts';

describe('sha256', () => {
  /*
   * SHA-256 is implemented in the package rather than taken from `node:crypto`,
   * because hashing has to be synchronous *and* work in the browser bundle. An
   * implementation nobody checked against the published vectors would be a
   * silent corruption of every asset reference in the system.
   */
  it.each([
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    [
      'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    ],
  ])('matches the published vector for %o', (input, expected) => {
    const digest = sha256Hex(input);
    expect(digest.startsWith(expected)).toBe(true);
    expect(digest).toBe(createHash('sha256').update(input).digest('hex'));
  });

  it('agrees with node:crypto on every asset in the repository', () => {
    for (const stored of loadDemoAssets()) {
      const json = canonicalJson({
        ...stored.document,
        metadata: { ...stored.document.metadata, contentHash: '' },
      });
      expect(computeContentHash(stored.document)).toBe(
        createHash('sha256').update(json).digest('hex'),
      );
    }
  });
});

describe('canonical json', () => {
  it('is independent of key order', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it('preserves array order, which is meaningful', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it('drops undefined members the way JSON.stringify does', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });
});

describe('content hashing', () => {
  const asset = () => loadDemoAssets().find((entry) => entry.assetType === 'animation-clip')!.document;

  it('is deterministic', () => {
    expect(computeContentHash(asset())).toBe(computeContentHash(asset()));
  });

  it('excludes the hash field itself, so sealing is idempotent', () => {
    const sealed = sealAsset(asset());
    expect(assetHashMatches(sealed)).toBe(true);
    expect(sealAsset(sealed)).toEqual(sealed);
  });

  it('changes when the content changes', () => {
    const before = computeContentHash(asset());
    const changed = asset();
    (changed as { clip: { durationSec: number } }).clip.durationSec += 0.1;
    expect(computeContentHash(changed)).not.toBe(before);
  });

  it('every published asset matches its own recorded hash', () => {
    for (const stored of loadDemoAssets()) {
      expect(assetHashMatches(stored.document)).toBe(true);
    }
  });
});

describe('registry', () => {
  const registry = demoRegistry();
  const behaviorRef = registry.referenceTo(
    'animation-behavior',
    'humanoid-third-person-base',
    '1.0.0',
  );

  it('resolves a well-formed reference', () => {
    expect(registry.checkReference(behaviorRef)).toEqual([]);
    expect(registry.get(behaviorRef).metadata.id).toBe('humanoid-third-person-base');
  });

  it('refuses a reference whose content hash no longer matches', () => {
    const tampered = { ...behaviorRef, contentHash: 'f'.repeat(64) };
    const issues = registry.checkReference(tampered);
    expect(issues[0]?.code).toBe('hash-mismatch');
  });

  it('refuses a version that does not exist', () => {
    const issues = registry.checkReference({ ...behaviorRef, version: '9.9.9' });
    expect(issues[0]?.code).toBe('version-not-found');
  });

  it('refuses an asset id that does not exist', () => {
    const issues = registry.checkReference({ ...behaviorRef, assetId: 'not-a-thing' });
    expect(issues[0]?.code).toBe('missing-reference');
  });

  it('reports every asset as schema-valid', () => {
    for (const stored of registry.all()) {
      const report = registry.validate({
        assetType: stored.assetType,
        assetId: stored.id,
        version: stored.version,
        contentHash: '',
      });
      expect(report.issues).toEqual([]);
    }
  });

  it('searches the terms the library exposes', () => {
    const bySlot = registry.summaries({ text: 'action.primary.01' });
    expect(bySlot.map((summary) => summary.id)).toContain('humanoid-third-person-base');
  });

  it('filters by asset type', () => {
    const clips = registry.summaries({ assetType: 'animation-clip' });
    expect(clips.length).toBeGreaterThan(0);
    expect(clips.every((summary) => summary.assetType === 'animation-clip')).toBe(true);
  });
});

describe('registry construction', () => {
  it('reports an empty registry rather than throwing', () => {
    const empty = new AnimationAssetRegistry();
    expect(empty.size).toBe(0);
    expect(empty.summaries()).toEqual([]);
    expect(
      empty.checkReference({
        assetType: 'animation-clip',
        assetId: 'idle',
        version: '1.0.0',
        contentHash: '',
      })[0]?.code,
    ).toBe('missing-reference');
  });

  it('refuses to register the same asset key twice', () => {
    const one = loadDemoAssets()[0]!;
    expect(() => new AnimationAssetRegistry([one, one])).toThrow(/duplicate-asset-key/);
  });

  it('refuses a stored asset whose wrapper disagrees with its own document metadata', () => {
    const one = loadDemoAssets()[0]!;
    const mismatched: StoredAsset = { ...one, id: `${one.id}-not-the-real-id` };
    expect(() => new AnimationAssetRegistry([mismatched])).toThrow(/asset-metadata-mismatch/);
  });
});

describe('empty-hash references (PLAN Part III)', () => {
  const registry = demoRegistry();
  const behaviorRef = registry.referenceTo(
    'animation-behavior',
    'humanoid-third-person-base',
    '1.0.0',
  );

  it('checkReference has no bypass for an empty content hash on an otherwise-real reference', () => {
    const blanked = { ...behaviorRef, contentHash: '' };
    const issues = registry.checkReference(blanked);
    expect(issues[0]?.code).toBe('hash-mismatch');
  });

  it('the library index refuses an unsealed (draft) asset', () => {
    const draftClip = {
      ...loadDemoAssets().find((entry) => entry.assetType === 'animation-clip')!,
    };
    const unsealed: StoredAsset = {
      ...draftClip,
      document: { ...draftClip.document, metadata: { ...draftClip.document.metadata, contentHash: '' } },
    };
    const withDraft = new AnimationAssetRegistry([
      ...loadDemoAssets().filter((entry) => entry.id !== draftClip.id || entry.assetType !== draftClip.assetType),
      unsealed,
    ]);
    expect(() => buildLibraryIndex(withDraft)).toThrow(/unsealed-published-asset/);
  });
});

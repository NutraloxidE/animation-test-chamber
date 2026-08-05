/**
 * What a Prefab document is *not* allowed to be (§18.1).
 *
 * Every assertion here is a refusal. A schema that only proves the good case
 * passes is a schema that has not been shown to reject anything — and the whole
 * argument for a closed typed component union over an untyped bag rests on
 * exactly these rejections being real.
 */
import { describe, expect, it } from 'vitest';
import { validateAgainst } from '@atc/schema';
import { validatePrefabDocument } from '@atc/prefab-runtime';
import {
  animatorComponent,
  basePrefab,
  metadata,
  modelComponent,
  node,
  referenceTo,
} from './fixtures.ts';

const PARENT = {
  assetType: 'game-object-prefab',
  assetId: 'parent',
  version: '1.0.0',
  contentHash: 'b'.repeat(64),
};

describe('prefab references', () => {
  it('requires asset type, id, version and hash', () => {
    for (const missing of ['assetType', 'assetId', 'version', 'contentHash'] as const) {
      const reference: Record<string, unknown> = { ...PARENT };
      delete reference[missing];
      expect(validateAgainst('GameObjectPrefabReference', reference).valid).toBe(false);
    }
    expect(validateAgainst('GameObjectPrefabReference', PARENT).valid).toBe(true);
  });

  it('refuses an empty published content hash', () => {
    expect(
      validateAgainst('GameObjectPrefabReference', { ...PARENT, contentHash: '' }).valid,
    ).toBe(false);
  });

  it('refuses a floating "latest" version', () => {
    expect(
      validateAgainst('GameObjectPrefabReference', { ...PARENT, version: 'latest' }).valid,
    ).toBe(false);
  });
});

describe('components', () => {
  it('refuses an unknown component type', () => {
    const issues = validatePrefabDocument(
      basePrefab('p', node('root', [{ componentType: 'script' } as never])),
    );
    expect(issues.map((issue) => issue.code)).toContain('schema-invalid');
  });

  it('refuses an extra field on a known component', () => {
    const issues = validatePrefabDocument(
      basePrefab(
        'p',
        node('root', [{ ...animatorComponent(), bogus: 1 } as never]),
      ),
    );
    expect(issues.map((issue) => issue.code)).toContain('schema-invalid');
  });

  it('refuses two components with the same id on one node', () => {
    const twin = { ...modelComponent('navigator') };
    const issues = validatePrefabDocument(basePrefab('p', node('root', [twin, { ...twin }])));
    expect(issues.map((issue) => issue.code)).toContain('duplicate-component-id');
  });

  it('refuses a node id used twice in one Prefab', () => {
    const issues = validatePrefabDocument(
      basePrefab('p', node('root', [], [{ kind: 'inline', node: node('root') }])),
    );
    expect(issues.map((issue) => issue.code)).toContain('duplicate-node-id');
  });

  it('refuses a session-local model URL', () => {
    const issues = validatePrefabDocument(
      basePrefab(
        'p',
        node('root', [
          {
            ...modelComponent('navigator'),
            model: { kind: 'repository-model', assetPath: 'blob:abc', scale: 1, rotationYRad: 0 },
          } as never,
        ]),
      ),
    );
    expect(issues.map((issue) => issue.code)).toContain('invalid-component-constraint');
  });

  it('refuses a perspective camera with no field of view', () => {
    const issues = validatePrefabDocument(
      basePrefab(
        'p',
        node('root', [
          {
            schemaVersion: 1,
            componentId: 'camera',
            componentType: 'camera',
            enabled: true,
            projection: 'perspective',
          } as never,
        ]),
      ),
    );
    expect(issues.map((issue) => issue.code)).toContain('invalid-component-constraint');
  });
});

describe('transforms', () => {
  it('requires a transform on every node', () => {
    const root = node('root');
    const withoutTransform = { ...root } as Record<string, unknown>;
    delete withoutTransform.transform;
    expect(
      validateAgainst('BaseGameObjectPrefabAsset', {
        metadata: metadata('p'),
        derivation: { mode: 'base' },
        abstract: false,
        root: withoutTransform,
      }).valid,
    ).toBe(false);
  });
});

describe('derivation', () => {
  it('refuses a variant that stores a copied root payload', () => {
    expect(
      validateAgainst('VariantGameObjectPrefabAsset', {
        metadata: metadata('child'),
        derivation: { mode: 'variant', parent: PARENT, patches: [] },
        abstract: false,
        root: node('root'),
      }).valid,
    ).toBe(false);
  });

  it('accepts a variant that stores only parent and patches', () => {
    expect(
      validateAgainst('VariantGameObjectPrefabAsset', {
        metadata: metadata('child'),
        derivation: { mode: 'variant', parent: PARENT, patches: [] },
        abstract: false,
      }).valid,
    ).toBe(true);
  });

  it('requires a fork to say what it was forked from and why', () => {
    expect(
      validateAgainst('ForkGameObjectPrefabAsset', {
        metadata: metadata('forked'),
        derivation: { mode: 'fork', forkedFrom: PARENT },
        abstract: false,
        root: node('root'),
      }).valid,
    ).toBe(false);
  });
});

describe('canonical purity', () => {
  it('refuses a runtime field bolted onto a node', () => {
    const asset = basePrefab('p', node('root'));
    const contaminated = JSON.parse(JSON.stringify(asset)) as { root: Record<string, unknown> };
    contaminated.root.animationTime = 0.4;
    expect(validatePrefabDocument(contaminated as never).map((issue) => issue.code)).toContain(
      'schema-invalid',
    );
  });

  it('refuses runtime state smuggled through a patch value', () => {
    // The realistic leak. A patch `value` is `unknown` by necessity — it has to
    // hold whatever the patched field holds — so it is the one place a
    // schema-valid Prefab can still carry a mixer or a velocity, and the
    // denylist is what closes it.
    const contaminated = {
      metadata: metadata('child'),
      derivation: {
        mode: 'variant',
        parent: PARENT,
        patches: [
          {
            kind: 'patch-component',
            nodeId: 'root',
            componentId: 'animator',
            patches: [
              { path: '/assignment/instanceOverrides', op: 'set', value: { velocity: 3 } },
            ],
          },
        ],
      },
      abstract: false,
    };
    const issues = validatePrefabDocument(contaminated as never);
    expect(issues.map((issue) => issue.code)).toContain('runtime-state-in-canonical-document');
  });

  it('leaves a clean document alone', () => {
    const issues = validatePrefabDocument(basePrefab('p', node('root', [modelComponent('relay')])));
    expect(issues).toEqual([]);
  });
});

describe('paths', () => {
  it('refuses a Prefab stored somewhere its metadata does not name', () => {
    const asset = basePrefab('navigator', node('root'));
    const issues = validatePrefabDocument(asset, { filePath: 'assets/prefabs/relay/1.0.0.json' });
    expect(issues.map((issue) => issue.code)).toContain('prefab-path-mismatch');
    expect(referenceTo(asset).assetId).toBe('navigator');
  });
});

/**
 * Unity scene export.
 *
 * The property worth asserting is the one the whole contract is about: two
 * instances of one character must export as two small objects plus one set of
 * asset references, not as two copies of a character. An exporter that
 * serialized the resolved document per instance would produce a bundle that
 * looked complete and quietly doubled every clip.
 */
import { describe, expect, it } from 'vitest';
import { buildUnityBundle } from '@atc/unity-export';
import { REPLAY_FIXTURES } from '@atc/replay-runtime';
import { loadResolvedDemoProject } from '../../fixtures/project.ts';
import { CONTROLLED_ENTITY, SCRIPTED_ENTITY } from '../../fixtures/scene.ts';

function bundle() {
  // A fixed generated-at stamp: the default is `new Date()`, and a bundle that
  // embedded the current time could never be compared with itself.
  return buildUnityBundle(loadResolvedDemoProject(), [...REPLAY_FIXTURES], 'revision:test');
}

function projectDocument(files: { path: string; content: string }[]) {
  const file = files.find((entry) => entry.path === 'project.json')!;
  // The bundle nests the document under `project` beside its generated-file
  // marker, so a human opening the file can see it is generated output.
  return (JSON.parse(file.content) as { project: unknown }).project as {
    scenes: {
      id: string;
      entities: { id: string; kind: string; characterId?: string; transform: unknown }[];
      intentTracks: { id: string }[];
    }[];
    characters: { id: string; animation: unknown }[];
  };
}

describe('unity scene export', () => {
  it('exports the scene contract with stable entity ids', () => {
    const document = projectDocument(bundle());
    const scene = document.scenes[0];
    expect(scene).toBeDefined();
    const characters = scene!.entities.filter((entry) => entry.kind === 'character');
    expect(characters.map((entry) => entry.id)).toEqual([CONTROLLED_ENTITY, SCRIPTED_ENTITY]);
    expect(scene!.intentTracks.map((entry) => entry.id)).toEqual(['scripted-locomotion-cycle']);
  });

  it('exports two entities of one character without duplicating the character', () => {
    const document = projectDocument(bundle());
    const characterIds = document
      .scenes[0]!.entities.filter((entry) => entry.kind === 'character')
      .map((entry) => entry.characterId!);
    expect(new Set(characterIds).size).toBe(1);
    // One character definition in the bundle, referenced twice.
    expect(document.characters.filter((entry) => entry.id === characterIds[0]!)).toHaveLength(1);
  });

  it('carries asset references and their content hashes through', () => {
    const files = bundle();
    const manifest = files.find((entry) => entry.path === 'assets-manifest.json')!;
    const parsed = JSON.parse(manifest.content) as { assets?: { contentHash?: string }[] };
    for (const asset of parsed.assets ?? []) {
      expect(asset.contentHash ?? '').not.toBe('');
    }
  });

  it('generates C# DTOs for the world types', () => {
    const dtos = bundle().find((entry) =>
      entry.path.endsWith('Generated/ChamberDtos.cs'),
    )!.content;
    for (const type of [
      'class WorldDefinition',
      'class RuntimeInstanceDefinition',
      'class IntentTrackDefinition',
      'class RuntimeInstanceSource',
    ]) {
      expect(dtos).toContain(type);
    }
  });

  it('ships an adapter seam for entities rather than an implementation', () => {
    const files = bundle();
    const adapter = files.find((entry) => entry.path.endsWith('Runtime/IChamberScene.cs'))!.content;
    expect(adapter).toContain('void SpawnEntity(');
    expect(adapter).toContain('void BindController(');
    expect(adapter).toContain('ChamberStateMachine StateMachineFor(');
    expect(adapter).toContain('Observe()');

    /*
     * The control seam must be intent, not playback. An adapter offering a
     * "play this clip" entry point would let Unity skip the transition rules
     * the character was tuned with, which is the whole thing
     * ControllableCharacter exists to prevent on the web side.
     */
    expect(adapter).toContain('void InjectIntent(');
    expect(adapter).not.toContain('PlayAnimation(');
    expect(adapter).not.toContain('ForceState(');

    // The README must say what is missing. An adapter that quietly did less
    // than the browser is the failure mode this repository keeps writing down.
    const readme = files.find((entry) => entry.path.endsWith('AnimationTestChamberAdapter/README.md'))!.content;
    expect(readme).toContain('No entity spawning is implemented');
    expect(readme).toContain('No Animator Controller is generated');
  });

  it('is stable across a second export', () => {
    const first = bundle();
    const second = bundle();
    expect(second.map((file) => `${file.path}:${file.content}`)).toEqual(
      first.map((file) => `${file.path}:${file.content}`),
    );
  });
});

/**
 * What the Viewport draws and what it plays (§11.2, §11.4, §11.7).
 *
 * The bug being pinned down: the route resolved Character B while the Viewport
 * kept drawing Character A's model, because the model came from a store field
 * the route never touched. So the tests below assert the *link* — resolve for an
 * id, and the presentation's model is that id's authored model — rather than
 * merely that some model was produced.
 *
 * The clip assertions are the second half of the same problem. Playback used a
 * renderer-side `stateId -> clip name` map, so a take name that matched nothing
 * failed silently. Here every take a Character can play is resolved through the
 * canonical chain and checked against the file it names.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  resolveRigEditorCharacterPresentation,
  resolveWeaponGrip,
} from '../../../apps/web/src/rig-editor/resolve-character-presentation.ts';
import { loadDemoProject, loadResolvedDemoProject } from '../../fixtures/project.ts';

const project = loadDemoProject();
const PUBLIC_ROOT = resolve(__dirname, '../../../apps/web/public');

const presentationOf = (characterId: string, weaponModeId = 'unarmed', overrideId: string | null = null) =>
  resolveRigEditorCharacterPresentation({
    project: loadResolvedDemoProject(characterId),
    weaponModeId,
    previewModelOverridePresetId: overrideId,
  });

/** Animation take names inside a `.gltf` or `.glb`, read from the real file. */
function takeNamesIn(publicPath: string): Set<string> {
  const data = readFileSync(resolve(PUBLIC_ROOT, publicPath.replace(/^\//, '')));
  const json =
    data.subarray(0, 4).toString('utf8') === 'glTF'
      ? (() => {
          let offset = 12;
          while (offset < data.length) {
            const length = data.readUInt32LE(offset);
            const type = data.readUInt32LE(offset + 4);
            if (type === 0x4e4f534a) {
              return JSON.parse(data.subarray(offset + 8, offset + 8 + length).toString('utf8'));
            }
            offset += 8 + length;
          }
          throw new Error(`${publicPath}: no JSON chunk`);
        })()
      : JSON.parse(data.toString('utf8'));
  return new Set(
    ((json.animations ?? []) as { name?: string }[]).map((animation) => animation.name ?? ''),
  );
}

describe('route Character drives the model on screen', () => {
  it('presents each Character’s own authored model', () => {
    for (const character of project.characters) {
      const presentation = presentationOf(character.id);
      expect(presentation.characterId).toBe(character.id);
      expect(presentation.model.canonical).toEqual(character.model);
      // No override in play, so what is drawn *is* what is authored.
      expect(presentation.model.effective).toEqual(character.model);
      expect(presentation.model.isPreviewOverridden).toBe(false);
    }
  });

  /*
   * The reported symptom, as an assertion: two different Characters must not
   * present the same model. Before the model binding was authored data, every
   * route produced whatever the preset selector last held.
   */
  it('never presents two Characters as the same model', () => {
    const keys = project.characters.map((character) => {
      const model = presentationOf(character.id).model.effective;
      return model.kind === 'procedural-humanoid' ? model.presetId : model.assetPath;
    });
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('switches model when the route switches Character', () => {
    const first = presentationOf('demo-humanoid').model.effective;
    const second = presentationOf('quaternius-knight').model.effective;
    expect(first).not.toEqual(second);
    expect(first.kind).toBe('procedural-humanoid');
    expect(second.kind).toBe('repository-model');
  });
});

describe('preview model override', () => {
  it('changes only what is drawn, never the canonical binding', () => {
    const presentation = presentationOf('demo-humanoid', 'unarmed', 'sentinel');
    expect(presentation.model.canonical).toEqual(
      project.characters.find((character) => character.id === 'demo-humanoid')!.model,
    );
    expect(presentation.model.effective).toEqual({
      kind: 'procedural-humanoid',
      presetId: 'sentinel',
    });
    expect(presentation.model.isPreviewOverridden).toBe(true);
  });

  it('leaves the canonical project document untouched', () => {
    const before = structuredClone(project.characters);
    presentationOf('demo-humanoid', 'unarmed', 'relay');
    expect(loadDemoProject().characters).toEqual(before);
  });

  it('can only ever name a procedural appearance', () => {
    // It cannot name a model file, so a preview can never be mistaken on screen
    // for an authored imported model.
    const presentation = presentationOf('quaternius-knight', 'unarmed', 'navigator');
    expect(presentation.model.effective.kind).toBe('procedural-humanoid');
    expect(presentation.model.canonical.kind).toBe('repository-model');
  });

  it('is absent by default', () => {
    expect(presentationOf('demo-humanoid').model.previewOverridePresetId).toBeNull();
  });
});

describe('canonical clip resolution for imported models', () => {
  const imported = ['quaternius-knight', 'quaternius-universal-base'];

  it('exposes the default punch bindings as the unarmed motion context', () => {
    const resolved = loadResolvedDemoProject('quaternius-universal-base');

    expect(resolved.motionContextKeys).toContain('unarmed');
    expect(presentationOf('quaternius-universal-base', 'unarmed').takeByStateId['attack-01']!.animationName)
      .toBe('Rig|Punch_Jab');
  });

  it('resolves a take for every graph state, through the motion set', () => {
    for (const id of imported) {
      const presentation = presentationOf(id);
      const resolved = loadResolvedDemoProject(id);
      for (const state of resolved.graph.states) {
        const take = presentation.takeByStateId[state.id];
        expect(take, `${id} has no canonical take for ${state.id}`).toBeDefined();
        expect(take!.animationName.length).toBeGreaterThan(0);
        expect(take!.assetPath.startsWith('/assets/')).toBe(true);
      }
    }
  });

  it('names takes that actually exist in the files they name', () => {
    // The check the retired renderer-side maps could not fail: an unknown name
    // produced no error there, just the previous clip staying on screen.
    for (const id of imported) {
      for (const weaponModeId of ['unarmed', 'sword', 'magic', 'pistol', 'shield', 'throw']) {
        const presentation = presentationOf(id, weaponModeId);
        for (const [stateId, take] of Object.entries(presentation.takeByStateId)) {
          expect(
            takeNamesIn(take.assetPath),
            `${id}/${weaponModeId}/${stateId}`,
          ).toContain(take.animationName);
        }
      }
    }
  });

  it('follows the weapon context through canonical contextual bindings', () => {
    const unarmed = presentationOf('quaternius-universal-base', 'unarmed');
    const sword = presentationOf('quaternius-universal-base', 'sword');
    expect(unarmed.takeByStateId['attack-01']!.animationName).toBe('Rig|Punch_Jab');
    expect(sword.takeByStateId['attack-01']!.animationName).toBe('Sword_Regular_A');
    // Different files, and the position scale travels with the take rather than
    // with the mode — the mode no longer knows anything about either.
    expect(unarmed.takeByStateId['attack-01']!.positionScale).toBe(100);
    expect(sword.takeByStateId['attack-01']!.positionScale).toBeUndefined();
  });

  it('keeps a Character on its own takes when its motion set binds no context', () => {
    /*
     * The Knight's rig is not the universal rig, and its motion set binds no
     * weapon contexts. It therefore keeps its own takes in sword mode instead of
     * half-playing another rig's animation — which is what the old
     * `weapon.rigId === character.rigId` check approximated in the renderer.
     */
    const unarmed = presentationOf('quaternius-knight', 'unarmed');
    const sword = presentationOf('quaternius-knight', 'sword');
    expect(sword.takeByStateId['attack-01']).toEqual(unarmed.takeByStateId['attack-01']);
    expect(sword.takeByStateId['idle']!.assetPath).toContain('KnightCharacter.glb');
  });

  it('lists exactly the files its takes live in', () => {
    const universal = presentationOf('quaternius-universal-base', 'sword');
    expect(universal.sourceFiles).toEqual([
      '/assets/animations/quaternius-universal-2/UAL2_Standard_RM.glb',
      '/assets/animations/quaternius-universal/AnimationLibrary_UE_Standard.glb',
    ]);
    const knight = presentationOf('quaternius-knight');
    expect(knight.sourceFiles).toEqual(['/assets/characters/quaternius-knight/KnightCharacter.glb']);
  });

  it('resolves no takes at all for a procedural Character', () => {
    // Not an empty-ish fallback: a procedural Character has no imported takes,
    // and inventing entries here would imply files that do not exist.
    for (const id of ['demo-humanoid', 'alternate-humanoid-character', 'sentinel']) {
      expect(presentationOf(id).takeByStateId).toEqual({});
      expect(presentationOf(id).sourceFiles).toEqual([]);
    }
  });

  it('carries the canonical loop flag for every state', () => {
    const presentation = presentationOf('quaternius-knight');
    expect(presentation.loopByStateId['idle']).toBe(true);
    expect(presentation.loopByStateId['attack-01']).toBe(false);
  });
});

describe('weapon grips come from the authored model binding', () => {
  it('reads the Character’s own default', () => {
    const knight = project.characters.find((entry) => entry.id === 'quaternius-knight')!;
    expect(resolveWeaponGrip({ model: knight.model, weaponModeId: 'sword' })).toEqual({
      position: [0, 0, 0],
      rotation: [0, 0, 0],
    });
  });

  it('lets a session override win, without touching the authored default', () => {
    const knight = project.characters.find((entry) => entry.id === 'quaternius-knight')!;
    const sessionOverride = { position: [1, 2, 3] as [number, number, number], rotation: [0, 0, 0] as [number, number, number] };
    expect(resolveWeaponGrip({ model: knight.model, weaponModeId: 'sword', sessionOverride })).toEqual(
      sessionOverride,
    );
    expect(
      loadDemoProject().characters.find((entry) => entry.id === 'quaternius-knight')!.model,
    ).toEqual(knight.model);
  });

  it('has no grip for a procedural Character', () => {
    const navigator = project.characters.find((entry) => entry.id === 'demo-humanoid')!;
    expect(resolveWeaponGrip({ model: navigator.model, weaponModeId: 'sword' })).toBeUndefined();
  });
});

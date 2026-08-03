/**
 * The world simulates the *edited* document.
 *
 * Tuning is authored in the focused chamber; before `setProject` existed the
 * world engine kept the document it was constructed with, so every tuning edit
 * stopped at Isolate and the world silently ran the seed forever.
 */
import { describe, expect, it } from 'vitest';
import { WorldChamberEngine } from '../../../apps/web/src/world/world-engine.ts';
import { demoRegistry, loadDemoProject } from '../../fixtures/project.ts';

describe('world engine project sync', () => {
  it('simulates the document handed to setProject', () => {
    const project = loadDemoProject();
    const engine = new WorldChamberEngine({ registry: demoRegistry(), project });
    const instanceId = engine.instanceIds[0]!;

    const edited = {
      ...project,
      camera: { ...project.camera, fovDeg: project.camera.fovDeg + 10 },
    };
    engine.setProject(edited);

    expect(engine.instance(instanceId)?.resolved.camera.fovDeg).toBe(edited.camera.fovDeg);
  });
});

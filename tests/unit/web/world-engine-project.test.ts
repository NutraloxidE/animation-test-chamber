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

  /*
   * Root motion tracks come from the GLTF, so the renderer pushes them in — and
   * `setProject` rebuilds the runtime. Losing them on rebuild means the tuning
   * disappears from the world on the *next* edit, which looks like the world
   * ignoring root motion rather than a lifetime bug.
   */
  it('keeps action root motion tuning across a project rebuild', () => {
    const project = loadDemoProject();
    const engine = new WorldChamberEngine({ registry: demoRegistry(), project });
    const instanceId = engine.instanceIds[0]!;
    const tracks = {
      'attack-01': { times: [0, 1], positions: [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1.5 }] },
    };

    engine.setActionRootMotion(instanceId, { enabled: true, tracks });
    engine.setProject({ ...project, displayName: `${project.displayName} edited` });

    const simulation = engine.instance(instanceId)!.simulation as unknown as {
      upperBodyActionRootMotionEnabled: boolean;
      actionRootMotionTracks: typeof tracks;
    };
    expect(simulation.upperBodyActionRootMotionEnabled).toBe(true);
    expect(simulation.actionRootMotionTracks).toEqual(tracks);
  });
});

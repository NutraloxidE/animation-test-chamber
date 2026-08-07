import { describe, expect, it } from 'vitest';
import { AnimationPreviewWorldSession } from '../../../apps/web/src/animation-chamber/AnimationPreviewWorldSession.ts';

describe('the subject-local Preview World', () => {
  it('seeds the exact subject and duplicates only ephemeral state', () => {
    const world = new AnimationPreviewWorldSession('prefab/node/animator');
    expect(world.state.instances[0]!.id).toContain('prefab/node/animator');

    world.duplicate();
    expect(world.state.instances).toHaveLength(2);
    expect(world.state.instances[1]!.position.x).toBe(2);
  });

  it('changes focus, camera, transform and intent without an EditSession', () => {
    const world = new AnimationPreviewWorldSession('subject');
    world.duplicate();
    const id = world.state.instances[1]!.id;
    world.update(id, { position: { x: 3, y: 0, z: -2 }, yawDeg: 45, intentSource: 'ai' });
    world.focus(id);
    world.targetCamera(id);

    expect(world.state).toMatchObject({ focusedInstanceId: id, cameraTargetId: id });
    expect(world.state.instances[1]).toMatchObject({
      position: { x: 3, y: 0, z: -2 },
      yawDeg: 45,
      intentSource: 'ai',
    });
  });

  it('reverts and cannot retain another subject', () => {
    const first = new AnimationPreviewWorldSession('subject-a');
    first.duplicate();
    first.revert();
    expect(first.state.instances).toHaveLength(1);

    const second = new AnimationPreviewWorldSession('subject-b');
    expect(JSON.stringify(second.state)).not.toContain('subject-a');
    expect(JSON.stringify(second.state)).toContain('subject-b');
  });
});

/**
 * A prop that turns and bobs in place.
 *
 * Deliberately generic — a coin, a rune, a quest marker — and deliberately
 * transform-only: this is the ordinary-object movement path, so it refuses to
 * be attached to anything the character simulation owns. Time comes from
 * `ctx.deltaSeconds`, so a paused Scene leaves the prop exactly where it was.
 */
import { defineGameplayScript, numberProp } from '@atc/gameplay-sdk';

export default defineGameplayScript({
  id: 'spin-and-bob',
  version: '1.0.0',
  displayName: 'Spin and Bob',
  properties: {
    turnsPerSecond: numberProp({ default: 0.7, min: 0, max: 8, instanceOverride: true }),
    bobHeight: numberProp({ default: 0.18, min: 0, max: 4, instanceOverride: true }),
    bobPerSecond: numberProp({ default: 0.8, min: 0, max: 8, instanceOverride: true }),
  },
  state: (): { elapsed: number; baseY: number; anchored: boolean } => ({ elapsed: 0, baseY: 0, anchored: false }),
  fixedUpdate(ctx, self) {
    const local = ctx.self.transform.local();
    if (!self.state.anchored) {
      self.state.baseY = local.position.y;
      self.state.anchored = true;
    }
    self.state.elapsed += ctx.deltaSeconds;
    const yaw = self.state.elapsed * self.props.turnsPerSecond * Math.PI * 2;
    const half = yaw / 2;
    ctx.self.transform.setLocal({
      position: {
        x: local.position.x,
        y: self.state.baseY + Math.sin(self.state.elapsed * self.props.bobPerSecond * Math.PI * 2) * self.props.bobHeight,
        z: local.position.z,
      },
      rotation: { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) },
      scale: local.scale,
    });
  },
});

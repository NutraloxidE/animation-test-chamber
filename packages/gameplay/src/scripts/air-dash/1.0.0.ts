import { booleanProp, defineGameplayScript, numberProp } from '@atc/gameplay-sdk';

export default defineGameplayScript({
  id: 'air-dash', version: '1.0.0', displayName: 'Air Dash',
  properties: {
    speed: numberProp({ default: 10, min: 0, instanceOverride: true }),
    durationSeconds: numberProp({ default: 0.18, min: 0.01, instanceOverride: true }),
    cooldownSeconds: numberProp({ default: 0.8, min: 0, instanceOverride: true }),
    allowGrounded: booleanProp({ default: false, instanceOverride: true }),
  },
  state: () => ({ cooldownTicksRemaining: 0, dashCount: 0 }),
  events: { dash: {} },
  fixedUpdate(_ctx, self) { if (self.state.cooldownTicksRemaining > 0) self.state.cooldownTicksRemaining -= 1; },
  onEvent(ctx, self, event) {
    if (event.type !== 'dash' || self.state.cooldownTicksRemaining > 0 || !ctx.self.character) return;
    const character = ctx.self.character;
    if (character.snapshot().grounded && !self.props.allowGrounded) return;
    const durationTicks = Math.max(1, Math.round(self.props.durationSeconds / ctx.deltaSeconds));
    const result = character.command({ type: 'motion-override', key: 'dash', velocity: { x: 0, y: 0, z: self.props.speed }, space: 'camera', durationTicks, priority: 100, horizontal: 'replace', vertical: 'preserve', facing: 'velocity' });
    if (!result.ok) return;
    character.setGameplayParameter('gameplay.dashing', true, durationTicks);
    self.state.cooldownTicksRemaining = Math.max(1, Math.round(self.props.cooldownSeconds / ctx.deltaSeconds));
    self.state.dashCount += 1;
  },
});

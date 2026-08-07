import { booleanProp, defineGameplayScript, numberProp } from '@atc/gameplay-sdk';

export default defineGameplayScript({
  id: 'stamina', version: '1.0.0', displayName: 'Stamina',
  properties: {
    maxStamina: numberProp({ default: 100, min: 0, instanceOverride: true }),
    drainPerSecond: numberProp({ default: 20, min: 0, instanceOverride: true }),
    regenPerSecond: numberProp({ default: 10, min: 0, instanceOverride: true }),
    startsSprinting: booleanProp({ default: false }),
  },
  state: ({ props }) => ({ stamina: props.maxStamina, sprinting: props.startsSprinting }),
  events: { sprint: { active: booleanProp() } },
  onEvent(_ctx, self, event) { if (event.type === 'sprint') self.state.sprinting = Boolean(event.payload.active) && self.state.stamina > 0; },
  fixedUpdate(ctx, self) {
    const rate = self.state.sprinting ? -self.props.drainPerSecond : self.props.regenPerSecond;
    self.state.stamina = Math.max(0, Math.min(self.props.maxStamina, self.state.stamina + rate * ctx.deltaSeconds));
    if (self.state.stamina === 0) self.state.sprinting = false;
  },
});

import { defineGameplayScript, numberProp } from '@atc/gameplay-sdk';

export default defineGameplayScript({
  id: 'health', version: '1.0.0', displayName: 'Health',
  properties: {
    maxHp: numberProp({ default: 100, min: 1, step: 1, instanceOverride: true }),
    regenPerSecond: numberProp({ default: 0, min: 0, step: 0.1, instanceOverride: true }),
  },
  state: ({ props }) => ({ hp: props.maxHp, dead: false as boolean }),
  events: { damage: { amount: numberProp({ min: 0 }) }, heal: { amount: numberProp({ min: 0 }) } },
  onEvent(_ctx, self, event) {
    if (event.type === 'damage') self.state.hp = Math.max(0, self.state.hp - (event.payload.amount as number));
    if (event.type === 'heal') self.state.hp = Math.min(self.props.maxHp, self.state.hp + (event.payload.amount as number));
    self.state.dead = self.state.hp <= 0;
  },
  fixedUpdate(ctx, self) { if (!self.state.dead) self.state.hp = Math.min(self.props.maxHp, self.state.hp + self.props.regenPerSecond * ctx.deltaSeconds); },
});

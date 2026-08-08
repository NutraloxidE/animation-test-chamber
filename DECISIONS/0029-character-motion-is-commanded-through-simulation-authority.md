# Character motion is commanded through simulation authority

CharacterMotor nodes have one world-space authority: `ControllableCharacter` and its `Simulation`. Gameplay Scripts issue typed motion commands and never mutate character transforms or select animation clips directly.

Commands queued during Script tick N are consumed by Character simulation on tick N+1. Durations are simulation ticks; replacement priority and stable origin keys define deterministic arbitration. Runtime animation parameters use the protected `gameplay.*` namespace and may drive authored graph transitions.

Ordinary GameObjects use runtime-only local transform operations. Those operations refuse CharacterMotor-owned nodes. When no commands exist, the legacy movement and replay path is unchanged.

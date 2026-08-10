# 0030 — Scripted AI drives characters through the intent channel

Accepted.

A Gameplay Script may drive a character bound to an AI intent channel by
supplying one frame of normalized intent per tick (`character.setIntent`), and
may name the motion context that character resolves its clips in
(`character.setMotionContext`). Both are refused for anything else: a character
whose intent comes from a device, a track or a replay keeps exactly one
authority, and a Script asking to drive it is an error rather than a merge.

The alternative was a second NPC combat path — an AI that selects clips, or a
parallel state machine reached through gameplay parameters. That path produces a
character which behaves one way for a human and another way for everything else,
and makes the tuning the character was authored with — input acceptance windows,
recovery policy, root motion, contextual bindings — true only for the player.
`setIntent` keeps "AI decisions belong in game code" and "one character control
boundary" as the same statement.

Motion context is a *resolution* input rather than a game rule, so a Script names
it and the existing contextual-binding machinery answers the rest. The Animator
resolves a playback plan per context on first use, and the renderer draws through
the plan for the context the simulation is actually in — so a character that
switched to sword mode cannot step sword states while an unarmed swing is on
screen.

Two supporting capabilities follow from this and are equally generic: the per-tick
camera yaw is exposed to Gameplay Scripts, because intent is camera-relative when
the project's movement policy says so and a Script steering toward a world point
otherwise has to guess what forward means; and authored `EquipmentSockets` are
filled by the host through one render prop, so the renderer owns *where* an item
hangs and the game owns *what* hangs there.

None of this adds a mechanic-named Component. Health, stamina, damage, economy,
progression, AI decisions and match lifecycle remain Gameplay Scripts.

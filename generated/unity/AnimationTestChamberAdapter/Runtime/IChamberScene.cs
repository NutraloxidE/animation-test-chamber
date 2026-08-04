using System.Collections.Generic;

namespace AnimationTestChamber
{
    /// <summary>
    /// One entity's observable state, mirroring the web runtime's
    /// entity-qualified observations. Reported *by* entity id, never by list
    /// position: the canonical scene is ordered, but a position is not an
    /// identity, and a reordered scene would silently relabel every reading.
    /// </summary>
    public struct ChamberEntityObservation
    {
        public string entityId;
        public string characterId;
        public bool enabled;
        public UnityEngine.Vector3 position;
        public UnityEngine.Quaternion rotation;
        public string locomotionStateId;
        public string actionStateId;
    }

    /// <summary>
    /// The seam between the canonical Scene contract and a Unity scene.
    /// <para>
    /// Deliberately not implemented here. Spawning, parenting, camera choice
    /// and prefab selection are project decisions; an adapter that guessed at
    /// them would be a framework, and replacing a framework is harder than
    /// implementing four methods.
    /// </para>
    /// <para>
    /// The one contract an implementation must honour is the one the web
    /// runtime honours: entities of the same character share resolved
    /// definition data and share no mutable state. Caching a state machine by
    /// character id is the specific mistake this interface exists to warn about.
    /// </para>
    /// <para>
    /// Control mirrors the web runtime's boundary too. Intent arrives
    /// normalized and the adapter feeds it to a controllable character; an
    /// implementation that reached for an AnimationClip by name would skip the
    /// transition rules the character was tuned with, and would behave one way
    /// for a human and another for everything else.
    /// </para>
    /// </summary>
    public interface IChamberScene
    {
        /// <summary>Creates a runtime entity from its canonical definition.</summary>
        void SpawnEntity(CharacterSceneEntity definition);

        /// <summary>
        /// Binds a controller to an already-spawned entity. The adapter
        /// supplies human and replay sources; scripted tracks come from the
        /// bundle, and AI channels from the host.
        /// </summary>
        void BindController(string entityId, CharacterControllerBindingDefinition controller);

        /// <summary>
        /// Hands one frame of normalized intent to an entity. The only normal
        /// way to drive a character: never a clip name, never a state id.
        /// </summary>
        void InjectIntent(string entityId, IntentTrackKeyframe intent);

        /// <summary>
        /// The state machine owned by one entity. Must return a distinct
        /// object per entity id.
        /// </summary>
        ChamberStateMachine StateMachineFor(string entityId);

        /// <summary>Current observations, one per spawned entity.</summary>
        IReadOnlyList<ChamberEntityObservation> Observe();
    }

    /// <summary>
    /// Samples an intent track with the same hold semantics as the web runtime:
    /// every field keeps the value of the latest keyframe at or before the tick.
    /// Interpolating here would make the same track mean two different things in
    /// the two engines.
    /// </summary>
    public static class ChamberIntentTrack
    {
        public static IntentTrackKeyframe SampleAt(IntentTrackDefinition track, int tick)
        {
            var local = track.loop ? tick % track.durationTicks : UnityEngine.Mathf.Min(tick, track.durationTicks - 1);
            IntentTrackKeyframe held = default;
            var found = false;
            foreach (var keyframe in track.keyframes)
            {
                if (keyframe.tick > local) continue;
                if (!found || keyframe.tick >= held.tick)
                {
                    held = keyframe;
                    found = true;
                }
            }
            return held;
        }
    }
}

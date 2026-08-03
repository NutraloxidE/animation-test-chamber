using System.Collections.Generic;

namespace AnimationTestChamber
{
    /// <summary>
    /// One instance's observable state, mirroring the web runtime's
    /// instance-qualified observations. Reported *by* instance id, never by
    /// list position: the canonical world is ordered, but a position is not an
    /// identity, and a reordered world would silently relabel every reading.
    /// </summary>
    public struct ChamberInstanceObservation
    {
        public string instanceId;
        public string characterId;
        public bool enabled;
        public UnityEngine.Vector3 position;
        public float yawRad;
        public string locomotionStateId;
        public string actionStateId;
    }

    /// <summary>
    /// The seam between the canonical world contract and a Unity scene.
    /// <para>
    /// Deliberately not implemented here. Spawning, parenting, camera choice
    /// and prefab selection are project decisions; an adapter that guessed at
    /// them would be a framework, and replacing a framework is harder than
    /// implementing four methods.
    /// </para>
    /// <para>
    /// The one contract an implementation must honour is the one the web
    /// runtime honours: instances of the same character share resolved
    /// definition data and share no mutable state. Caching a state machine by
    /// character id is the specific mistake this interface exists to warn about.
    /// </para>
    /// </summary>
    public interface IChamberWorld
    {
        /// <summary>Creates a runtime instance from its canonical definition.</summary>
        void SpawnInstance(RuntimeInstanceDefinition definition);

        /// <summary>
        /// Binds an intent source to an already-spawned instance. The adapter
        /// supplies local-input and replay sources; scripted tracks come from
        /// the bundle.
        /// </summary>
        void BindIntentSource(string instanceId, IntentSourceDefinition source);

        /// <summary>
        /// The state machine owned by one instance. Must return a distinct
        /// object per instance id.
        /// </summary>
        ChamberStateMachine StateMachineFor(string instanceId);

        /// <summary>Current observations, one per spawned instance.</summary>
        IReadOnlyList<ChamberInstanceObservation> Observe();
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

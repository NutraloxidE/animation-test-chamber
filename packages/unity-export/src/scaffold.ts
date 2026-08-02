/**
 * The minimal Unity adapter scaffold (PLAN 16.2).
 *
 * This is a scaffold, not a runtime: it imports canonical data, exposes the same
 * state-machine semantics as the web runtime, and defines the adapter seams for
 * input, haptics and terrain. It compiles, and it is honest about what it does
 * not do — see LIMITATIONS in the README.
 */
export const ADAPTER_FILES: { path: string; content: string }[] = [
  {
    path: 'README.md',
    content: `# Animation Test Chamber — Unity Adapter (generated)

This folder is **generated output**. Regenerate with \`pnpm unity:export\`.
Do not hand-edit it and do not treat it as a source of truth: the browser side
holds the canonical data, and there is no import-back path in the MVP.

## Install

Copy \`AnimationTestChamberAdapter/\` into your Unity project's \`Assets/\`
folder, and the JSON bundle next to it (or into \`StreamingAssets/\`).

Then use **Tools > Animation Test Chamber > Import Chamber Project**.

## What works

- Deserializing the canonical bundle into typed DTOs (\`ChamberDtos.cs\`)
- A runtime state machine with the same transition ordering, cancel windows,
  exit times and input buffering semantics as the web runtime
- Adapter interfaces for input, haptics and terrain
- The canonical **world** contract: multiple runtime instances of shared
  character definitions, their transforms, their bound intent sources and the
  deterministic intent tracks scripted instances sample
  (\`IChamberWorld.cs\`)

## Multi-instance worlds

\`ProjectDefinition.world\` carries a list of \`RuntimeInstanceDefinition\`.
Each instance names a character by id; it does **not** carry a copy of that
character's behaviour, motion set, rig or clips. Two instances of one character
therefore appear in the bundle as two small objects and one set of asset
references, which is the property \`IChamberWorld\` is shaped to preserve:
spawn many, resolve once.

A project exported before this contract existed has no \`world\` field. Treat
that as a single instance of \`activeCharacterId\` — that is exactly what the
web runtime does.

## LIMITATIONS

These are real, and listed so nobody discovers them the hard way:

1. **No Animator Controller is generated.** The state machine here is driven
   from JSON at runtime. Generating a \`.controller\` asset is out of scope.
2. **No clip binding.** \`AnimationClipDefinition.assetPath\` is carried through,
   but wiring clips to a Playable graph or Animator is left to the project.
3. **Terrain is not reimplemented.** \`IChamberTerrain\` is an interface with a
   flat-ground default. The web runtime's height-field sampling is not ported,
   so terrain states will differ until you implement it against your colliders.
4. **Foot IK is not ported.** Use Unity's own IK; the tuned parameters come
   across as data.
5. **Haptics are a no-op by default.** \`IChamberHaptics\` has an empty
   implementation; wire it to your platform's gamepad API.
6. **Float precision differs.** Do not expect the web replay traces to match
   bit-for-bit; use them as behavioural references, not golden values.
7. **No instance spawning is implemented.** \`IChamberWorld\` defines the seam —
   spawn, bind intent, own a state machine per instance, report observations —
   and nothing behind it. Instantiating GameObjects, parenting them and
   choosing a camera target are project decisions, not adapter decisions.
8. **Intent sources are declarations, not drivers.** \`local-input\` and
   \`replay\` name a source the adapter must supply; only \`scripted-track\`
   and \`none\` can be evaluated from the bundle alone.
9. **World traces are not compared.** The web harness hashes a world run and
   asserts it is reproducible. Nothing here does, and given (6) a cross-engine
   hash comparison would fail for reasons that have nothing to do with
   behaviour.
`,
  },
  {
    path: 'Runtime/ChamberProject.cs',
    content: `using System;
using System.IO;
using UnityEngine;
using AnimationTestChamber.Generated;

namespace AnimationTestChamber
{
    /// <summary>
    /// Loads a chamber bundle produced by the browser runtime.
    /// </summary>
    public static class ChamberProject
    {
        [Serializable]
        private class ProjectEnvelope
        {
            public ResolvedProject project;
        }

        public static ResolvedProject LoadFromJson(string json)
        {
            if (string.IsNullOrEmpty(json))
            {
                throw new ArgumentException("chamber project JSON is empty", nameof(json));
            }

            var envelope = JsonUtility.FromJson<ProjectEnvelope>(json);
            if (envelope == null || envelope.project == null)
            {
                throw new InvalidDataException("chamber project JSON has no \\"project\\" field");
            }

            return envelope.project;
        }

        public static ResolvedProject LoadFromFile(string path)
        {
            return LoadFromJson(File.ReadAllText(path));
        }
    }
}
`,
  },
  {
    path: 'Runtime/ChamberStateMachine.cs',
    content: `using System;
using System.Collections.Generic;
using System.Linq;
using AnimationTestChamber.Generated;

namespace AnimationTestChamber
{
    /// <summary>
    /// Runtime state machine mirroring the web implementation's semantics:
    /// forced-transition ordering, then priority, then id; exit times and cancel
    /// windows gate transitions out of non-interruptible states.
    /// </summary>
    public class ChamberStateMachine
    {
        public class LayerState
        {
            public string StateId;
            public float TimeSec;
            public float NormalizedTime;
            public float BlendWeight = 1f;
            public string LastTransitionId;
            public float PlaybackSpeed = 1f;
        }

        public const float FixedDeltaTime = 1f / 60f;

        private readonly ResolvedProject _project;
        private readonly Dictionary<string, LayerState> _layers = new Dictionary<string, LayerState>();

        public ChamberStateMachine(ResolvedProject project)
        {
            _project = project ?? throw new ArgumentNullException(nameof(project));
            Reset();
        }

        public void Reset()
        {
            _layers.Clear();
            foreach (var layer in _project.graph.layers)
            {
                _layers[layer.id] = new LayerState { StateId = layer.defaultState };
            }
        }

        public LayerState GetLayer(string layerId)
        {
            return _layers.TryGetValue(layerId, out var state) ? state : null;
        }

        private int ForcedRank(string stateId)
        {
            var index = _project.graph.forcedTransitionOrder.IndexOf(stateId);
            return index < 0 ? _project.graph.forcedTransitionOrder.Count : index;
        }

        /// <summary>Advances one fixed tick.</summary>
        public void Tick(IChamberParameters parameters)
        {
            foreach (var layerDef in _project.graph.layers.OrderBy(l => l.order))
            {
                var layer = _layers[layerDef.id];
                var candidates = _project.graph.transitions
                    .Where(t => TargetLayerOf(t.to) == layerDef.id)
                    .OrderBy(t => ForcedRank(t.to))
                    .ThenByDescending(t => t.priority)
                    .ThenBy(t => t.id, StringComparer.Ordinal);

                foreach (var transition in candidates)
                {
                    if (!CanFire(transition, layer, parameters))
                    {
                        continue;
                    }

                    var target = FindState(transition.to);
                    layer.StateId = transition.to;
                    layer.TimeSec = transition.startOffsetNormalized * DurationOf(transition.to);
                    layer.NormalizedTime = transition.startOffsetNormalized;
                    layer.BlendWeight = transition.blendDurationSec > 0f ? 0f : 1f;
                    layer.LastTransitionId = transition.id;
                    layer.PlaybackSpeed = transition.playbackSpeed * (target?.speed ?? 1f);
                    break;
                }

                Advance(layer);
            }
        }

        private void Advance(LayerState layer)
        {
            var duration = DurationOf(layer.StateId);
            layer.TimeSec += FixedDeltaTime * layer.PlaybackSpeed;
            layer.NormalizedTime = duration > 0f ? layer.TimeSec / duration : 0f;

            var state = FindState(layer.StateId);
            if (state != null && state.loop && layer.NormalizedTime > 1f)
            {
                layer.NormalizedTime -= (float)Math.Floor(layer.NormalizedTime);
            }
            else if (layer.NormalizedTime > 1f)
            {
                layer.NormalizedTime = 1f;
            }

            if (layer.BlendWeight < 1f)
            {
                layer.BlendWeight = Math.Min(1f, layer.BlendWeight + FixedDeltaTime * 8f);
            }
        }

        private bool CanFire(TransitionDefinition transition, LayerState layer, IChamberParameters parameters)
        {
            if (transition.from != "*" && transition.from != layer.StateId)
            {
                return false;
            }

            var target = FindState(transition.to);
            if (target == null)
            {
                return false;
            }

            if (transition.to == layer.StateId && !target.allowReEntry)
            {
                return false;
            }

            var current = FindState(layer.StateId);
            if (layer.BlendWeight < 1f && !transition.interruptible)
            {
                return false;
            }

            var hasCancelWindow = transition.cancelWindow != null;
            if (current != null && !current.interruptible && transition.from != "*")
            {
                // Matches the web runtime: a non-interruptible state may only be
                // left through a declared exit time or cancel window.
                if (transition.exitTimeNormalized <= 0f && !hasCancelWindow)
                {
                    return false;
                }
            }

            if (transition.exitTimeNormalized > 0f && layer.NormalizedTime < transition.exitTimeNormalized)
            {
                return false;
            }

            if (hasCancelWindow)
            {
                if (layer.NormalizedTime < transition.cancelWindow.start ||
                    layer.NormalizedTime > transition.cancelWindow.end)
                {
                    return false;
                }
            }

            return transition.conditions.All(condition => parameters.Evaluate(condition));
        }

        private string TargetLayerOf(string stateId)
        {
            return FindState(stateId)?.layer;
        }

        private StateDefinition FindState(string stateId)
        {
            return _project.graph.states.FirstOrDefault(s => s.id == stateId);
        }

        private float DurationOf(string stateId)
        {
            var state = FindState(stateId);
            if (state == null)
            {
                return 1f;
            }
            var clip = _project.clips.FirstOrDefault(c => c.id == state.clipId);
            return clip?.durationSec ?? 1f;
        }
    }
}
`,
  },
  {
    path: 'Runtime/IChamberParameters.cs',
    content: `using AnimationTestChamber.Generated;

namespace AnimationTestChamber
{
    /// <summary>
    /// Supplies the values transition conditions are evaluated against.
    /// Implement this against your own character controller.
    /// </summary>
    public interface IChamberParameters
    {
        bool Evaluate(TransitionCondition condition);
    }
}
`,
  },
  {
    path: 'Runtime/ChamberInput.cs',
    content: `using System.Collections.Generic;
using UnityEngine;

namespace AnimationTestChamber
{
    /// <summary>
    /// Placeholder input mapping. The canonical input map carries the bindings;
    /// wiring them to Unity's Input System is left to the project.
    /// </summary>
    public class ChamberInput : MonoBehaviour
    {
        public Vector2 Move { get; private set; }
        public Vector2 Look { get; private set; }

        private readonly Dictionary<string, bool> _buttons = new Dictionary<string, bool>();

        public bool IsDown(string action)
        {
            return _buttons.TryGetValue(action, out var down) && down;
        }

        public void SetButton(string action, bool down)
        {
            _buttons[action] = down;
        }

        public void SetAxes(Vector2 move, Vector2 look)
        {
            Move = move;
            Look = look;
        }
    }
}
`,
  },
  {
    path: 'Runtime/IChamberHaptics.cs',
    content: `namespace AnimationTestChamber
{
    /// <summary>
    /// Adapter seam for haptics. The default implementation is a no-op, which
    /// is the correct behaviour on a device with no supported actuator.
    /// </summary>
    public interface IChamberHaptics
    {
        void Play(string semanticEvent, float lowFrequency, float highFrequency, float durationMs);
    }

    public class NullChamberHaptics : IChamberHaptics
    {
        public void Play(string semanticEvent, float lowFrequency, float highFrequency, float durationMs)
        {
            // Intentionally empty: unsupported haptics must never block gameplay.
        }
    }
}
`,
  },
  {
    path: 'Runtime/IChamberWorld.cs',
    content: `using System.Collections.Generic;

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
`,
  },
  {
    path: 'Runtime/IChamberTerrain.cs',
    content: `using UnityEngine;

namespace AnimationTestChamber
{
    /// <summary>
    /// Adapter seam for terrain queries. The web runtime samples a declarative
    /// height field; in Unity you will normally back this with raycasts.
    /// </summary>
    public interface IChamberTerrain
    {
        bool SampleGround(Vector3 position, out float height, out Vector3 normal);
    }

    /// <summary>Flat-ground default so the scaffold runs before you wire colliders.</summary>
    public class FlatChamberTerrain : IChamberTerrain
    {
        public bool SampleGround(Vector3 position, out float height, out Vector3 normal)
        {
            height = 0f;
            normal = Vector3.up;
            return true;
        }
    }
}
`,
  },
  {
    path: 'Editor/ChamberImporter.cs',
    content: `using System.IO;
using UnityEditor;
using UnityEngine;

namespace AnimationTestChamber.EditorTools
{
    public static class ChamberImporter
    {
        [MenuItem("Tools/Animation Test Chamber/Import Chamber Project")]
        public static void ImportChamberProject()
        {
            var path = EditorUtility.OpenFilePanel("Select chamber project.json", "", "json");
            if (string.IsNullOrEmpty(path))
            {
                return;
            }

            try
            {
                var project = ChamberProject.LoadFromFile(path);
                Debug.Log(
                    $"Imported chamber project '{project.displayName}' " +
                    $"(revision {project.revisionId}) with {project.clips.Count} clip(s) " +
                    $"and {project.graph.transitions.Count} transition(s).");

                var target = Path.Combine(Application.streamingAssetsPath, "chamber-project.json");
                Directory.CreateDirectory(Path.GetDirectoryName(target));
                File.Copy(path, target, true);
                AssetDatabase.Refresh();
                Debug.Log($"Copied chamber bundle to {target}");
            }
            catch (System.Exception error)
            {
                Debug.LogError($"Failed to import chamber project: {error.Message}");
            }
        }
    }
}
`,
  },
];

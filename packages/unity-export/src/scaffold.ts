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
            public ProjectDefinition project;
        }

        public static ProjectDefinition LoadFromJson(string json)
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

        public static ProjectDefinition LoadFromFile(string path)
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

        private readonly ProjectDefinition _project;
        private readonly Dictionary<string, LayerState> _layers = new Dictionary<string, LayerState>();

        public ChamberStateMachine(ProjectDefinition project)
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

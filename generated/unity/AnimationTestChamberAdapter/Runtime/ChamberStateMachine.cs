using System;
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

using System.Collections.Generic;
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

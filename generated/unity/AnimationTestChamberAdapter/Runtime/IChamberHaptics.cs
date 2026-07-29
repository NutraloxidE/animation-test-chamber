namespace AnimationTestChamber
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

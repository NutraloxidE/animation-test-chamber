using AnimationTestChamber.Generated;

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

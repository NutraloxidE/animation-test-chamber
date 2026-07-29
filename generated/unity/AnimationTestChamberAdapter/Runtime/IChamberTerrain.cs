using UnityEngine;

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

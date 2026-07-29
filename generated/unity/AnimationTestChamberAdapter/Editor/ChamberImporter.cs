using System.IO;
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

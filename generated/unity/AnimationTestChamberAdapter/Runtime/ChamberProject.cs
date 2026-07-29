using System;
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
                throw new InvalidDataException("chamber project JSON has no \"project\" field");
            }

            return envelope.project;
        }

        public static ProjectDefinition LoadFromFile(string path)
        {
            return LoadFromJson(File.ReadAllText(path));
        }
    }
}

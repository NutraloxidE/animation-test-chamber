# Animation worker (optional)

Converts FBX and BVH into the canonical GLB the chamber imports, and retargets
onto the canonical humanoid skeleton.

**This worker is optional.** The chamber runs without it. When
`ANIMATION_WORKER_URL` is unset, any FBX/BVH import becomes an explicit pending
job that names what is missing, rather than failing silently — see
`packages/acquisition-core/src/worker.ts`.

No implementation is shipped here: a Blender install is a large, platform-specific
dependency, and the plan's non-goals exclude bundling one. What is shipped is the
contract, so a worker can be dropped in without touching the app.

## Contract

The API server speaks HTTP to `ANIMATION_WORKER_URL`. Two endpoints:

### `POST /jobs`

```jsonc
{
  "format": "fbx",                 // fbx | bvh | gltf
  "filename": "sword-swing.fbx",
  "contentHash": "sha256-hex",
  "content": "base64…",            // optional for large files
  "options": {
    "targetFps": 60,
    "targetSkeletonId": "canonical-humanoid",
    "extractRootMotion": true,
    "upAxis": "y",
    "unitScale": 1
  }
}
```

Responds with a job:

```jsonc
{
  "id": "job-123",
  "status": "queued",              // queued | running | succeeded | failed | unavailable
  "outputPath": "…/converted.glb", // on success
  "message": "human-readable status",
  "pipeline": ["import-fbx", "normalize-axes", "retarget", "export-glb"]
}
```

### `GET /jobs/:id`

Returns the same job shape.

## Requirements on an implementation

- `pipeline` must list the steps that actually ran. It is copied into the
  asset's `AssetProvenance.pipeline`, and provenance that lies is worse than
  provenance that is missing.
- Output must be GLB with a `+Y` up axis, 1 unit = 1 metre, and a `+Z` facing
  character, matching the runtime defaults.
- Root motion must be extractable as a separate track when
  `extractRootMotion` is set, so the chamber can switch between In-Place, Root
  Motion and Hybrid.
- Failure must report `failed` with a usable `message`. Never return
  `succeeded` with an empty or partial result.
- The worker must not fetch assets from the internet. It receives bytes and
  returns bytes; acquisition and licence verification happen before it runs.

## Reference implementation sketch

Python + `blender --background --python convert.py`, exposed with any HTTP
framework. Keep it stateless and idempotent on `contentHash` so a retried job
does not duplicate work.

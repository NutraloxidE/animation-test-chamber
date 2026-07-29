/**
 * Minimal GLB reader.
 *
 * Only the JSON chunk is parsed. Animation durations come from the accessor
 * min/max metadata that glTF requires on sampler inputs, so a clip list and its
 * timings can be extracted without decoding the binary buffer or pulling in a
 * full glTF loader on the server.
 */

export interface GlbAnimationInfo {
  name: string;
  durationSec: number;
  channelCount: number;
}

export interface GlbInfo {
  version: number;
  animations: GlbAnimationInfo[];
  nodeNames: string[];
  hasSkin: boolean;
  generator: string | null;
}

export class GlbParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GlbParseError';
  }
}

const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a; // "JSON"

interface GltfJson {
  asset?: { version?: string; generator?: string };
  animations?: {
    name?: string;
    channels?: unknown[];
    samplers?: { input?: number }[];
  }[];
  nodes?: { name?: string }[];
  skins?: unknown[];
  accessors?: { max?: number[]; min?: number[] }[];
}

export function parseGlb(bytes: Uint8Array): GlbInfo {
  if (bytes.byteLength < 12) {
    throw new GlbParseError('file is too small to be a GLB');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint32(0, true);
  if (magic !== GLB_MAGIC) {
    throw new GlbParseError('not a GLB file (missing glTF magic); .gltf and .fbx need conversion');
  }

  const version = view.getUint32(4, true);
  const totalLength = view.getUint32(8, true);
  if (totalLength > bytes.byteLength) {
    throw new GlbParseError('GLB header declares more bytes than the file contains');
  }

  let offset = 12;
  let json: GltfJson | null = null;

  while (offset + 8 <= bytes.byteLength) {
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    const dataStart = offset + 8;
    if (dataStart + chunkLength > bytes.byteLength) {
      throw new GlbParseError('GLB chunk extends past the end of the file');
    }
    if (chunkType === CHUNK_JSON) {
      const text = new TextDecoder().decode(bytes.subarray(dataStart, dataStart + chunkLength));
      try {
        json = JSON.parse(text) as GltfJson;
      } catch {
        throw new GlbParseError('GLB JSON chunk is not valid JSON');
      }
      break;
    }
    // Chunks are 4-byte aligned.
    offset = dataStart + chunkLength + ((4 - (chunkLength % 4)) % 4);
  }

  if (!json) throw new GlbParseError('GLB contains no JSON chunk');

  const accessors = json.accessors ?? [];
  const animations: GlbAnimationInfo[] = (json.animations ?? []).map((animation, index) => {
    let duration = 0;
    for (const sampler of animation.samplers ?? []) {
      if (typeof sampler.input !== 'number') continue;
      const accessor = accessors[sampler.input];
      const max = accessor?.max?.[0];
      if (typeof max === 'number' && max > duration) duration = max;
    }
    return {
      name: animation.name ?? `animation-${index}`,
      durationSec: duration,
      channelCount: animation.channels?.length ?? 0,
    };
  });

  return {
    version,
    animations,
    nodeNames: (json.nodes ?? []).map((node, index) => node.name ?? `node-${index}`),
    hasSkin: (json.skins?.length ?? 0) > 0,
    generator: json.asset?.generator ?? null,
  };
}

/** True when the bytes start with the GLB magic. */
export function looksLikeGlb(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 4) return false;
  return bytes[0] === 0x67 && bytes[1] === 0x6c && bytes[2] === 0x54 && bytes[3] === 0x46;
}

export function detectFormat(filename: string): 'glb' | 'gltf' | 'fbx' | 'bvh' | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.glb')) return 'glb';
  if (lower.endsWith('.gltf')) return 'gltf';
  if (lower.endsWith('.fbx')) return 'fbx';
  if (lower.endsWith('.bvh')) return 'bvh';
  return null;
}

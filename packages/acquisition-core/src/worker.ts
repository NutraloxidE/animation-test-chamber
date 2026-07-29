/**
 * HTTP contract for the optional animation worker (Blender headless).
 *
 * The worker is never required. When ANIMATION_WORKER_URL is unset, every
 * conversion request resolves to an explicit `unavailable` job so the UI can say
 * exactly what is missing instead of failing opaquely.
 */

export interface ConversionJobRequest {
  /** Source format the worker must read. */
  format: 'fbx' | 'bvh' | 'gltf';
  filename: string;
  contentHash: string;
  /** Base64 payload. Large files should use the upload URL flow instead. */
  content?: string;
  options: {
    targetFps: number;
    /** Canonical humanoid rig to retarget onto. */
    targetSkeletonId: string;
    extractRootMotion: boolean;
    upAxis: 'y' | 'z';
    unitScale: number;
  };
}

export type ConversionJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'unavailable';

export interface ConversionJob {
  id: string;
  status: ConversionJobStatus;
  /** Populated on success: path to the produced GLB. */
  outputPath?: string;
  message: string;
  /** Steps the worker actually ran, mirrored into AssetProvenance.pipeline. */
  pipeline: string[];
}

export interface AnimationWorkerClient {
  readonly available: boolean;
  submit(request: ConversionJobRequest): Promise<ConversionJob>;
  poll(jobId: string): Promise<ConversionJob>;
}

/** Client used when no worker URL is configured. */
export class UnavailableWorkerClient implements AnimationWorkerClient {
  readonly available = false;

  async submit(request: ConversionJobRequest): Promise<ConversionJob> {
    return {
      id: `unavailable-${request.contentHash.slice(0, 8)}`,
      status: 'unavailable',
      message:
        `${request.format.toUpperCase()} conversion needs the animation worker. ` +
        'Set ANIMATION_WORKER_URL, or convert the file to GLB and import that instead.',
      pipeline: [],
    };
  }

  async poll(jobId: string): Promise<ConversionJob> {
    return {
      id: jobId,
      status: 'unavailable',
      message: 'no animation worker is configured',
      pipeline: [],
    };
  }
}

export class HttpWorkerClient implements AnimationWorkerClient {
  readonly available = true;

  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async submit(request: ConversionJobRequest): Promise<ConversionJob> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, '')}/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      });
      if (!response.ok) {
        return {
          id: 'error',
          status: 'failed',
          message: `worker returned ${response.status}`,
          pipeline: [],
        };
      }
      return (await response.json()) as ConversionJob;
    } catch (error) {
      return {
        id: 'error',
        status: 'failed',
        message: error instanceof Error ? error.message : 'worker request failed',
        pipeline: [],
      };
    }
  }

  async poll(jobId: string): Promise<ConversionJob> {
    try {
      const response = await this.fetchImpl(
        `${this.baseUrl.replace(/\/$/, '')}/jobs/${encodeURIComponent(jobId)}`,
      );
      if (!response.ok) {
        return { id: jobId, status: 'failed', message: `worker returned ${response.status}`, pipeline: [] };
      }
      return (await response.json()) as ConversionJob;
    } catch (error) {
      return {
        id: jobId,
        status: 'failed',
        message: error instanceof Error ? error.message : 'worker request failed',
        pipeline: [],
      };
    }
  }
}

export function createWorkerClient(env: NodeJS.ProcessEnv = process.env): AnimationWorkerClient {
  const url = env.ANIMATION_WORKER_URL;
  return url ? new HttpWorkerClient(url) : new UnavailableWorkerClient();
}

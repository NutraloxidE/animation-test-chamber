export type PreviewWorldIntentSource = 'player' | 'ai' | 'replay';

export interface PreviewWorldInstance {
  id: string;
  label: string;
  enabled: boolean;
  position: { x: number; y: number; z: number };
  yawDeg: number;
  intentSource: PreviewWorldIntentSource;
}

export interface PreviewWorldState {
  instances: PreviewWorldInstance[];
  focusedInstanceId: string;
  cameraTargetId: string;
}

export class AnimationPreviewWorldSession {
  private nextId = 2;
  private readonly initial: PreviewWorldState;
  private current: PreviewWorldState;

  constructor(subjectId: string) {
    this.initial = {
      instances: [
        {
          id: `${subjectId}:preview-1`,
          label: 'Current subject',
          enabled: true,
          position: { x: 0, y: 0, z: 0 },
          yawDeg: 0,
          intentSource: 'player',
        },
      ],
      focusedInstanceId: `${subjectId}:preview-1`,
      cameraTargetId: `${subjectId}:preview-1`,
    };
    this.current = structuredClone(this.initial);
  }

  get state(): PreviewWorldState {
    return structuredClone(this.current);
  }

  duplicate(): void {
    const source = this.instance(this.current.focusedInstanceId);
    const id = `${source.id.replace(/:preview-\d+$/, '')}:preview-${this.nextId++}`;
    this.current.instances.push({
      ...structuredClone(source),
      id,
      label: `Test instance ${this.current.instances.length + 1}`,
      position: { ...source.position, x: source.position.x + 2 },
    });
  }

  update(id: string, patch: Partial<Omit<PreviewWorldInstance, 'id'>>): void {
    const index = this.current.instances.findIndex((entry) => entry.id === id);
    if (index < 0) throw new Error(`unknown Preview World instance "${id}"`);
    this.current.instances[index] = { ...this.current.instances[index]!, ...structuredClone(patch) };
  }

  focus(id: string): void {
    this.instance(id);
    this.current.focusedInstanceId = id;
  }

  targetCamera(id: string): void {
    this.instance(id);
    this.current.cameraTargetId = id;
  }

  revert(): void {
    this.current = structuredClone(this.initial);
    this.nextId = 2;
  }

  private instance(id: string): PreviewWorldInstance {
    const found = this.current.instances.find((entry) => entry.id === id);
    if (!found) throw new Error(`unknown Preview World instance "${id}"`);
    return found;
  }
}

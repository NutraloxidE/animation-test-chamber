import type { JsonObject, ScriptComponent } from '@atc/schema';
import { deterministicRandom, seedFrom, validateProperties, type GameplayContext, type GameplayEvent, type GameplayScriptDefinition, type GameplaySelf } from '@atc/gameplay-sdk';
import type { ComponentRuntimeContext, RuntimeComponent, RuntimeComponentStepContext } from './components.ts';

export type GameplayRuntimeIssueCode =
  | 'gameplay-script-not-found'
  | 'gameplay-script-hash-mismatch'
  | 'gameplay-script-invalid-properties'
  | 'gameplay-script-start-failed'
  | 'gameplay-script-update-failed'
  | 'gameplay-script-event-failed';

export interface GameplayRuntimeIssue { code: GameplayRuntimeIssueCode; message: string; gameObjectId: string; nodeId: string; componentId: string; scriptId: string; version: string }

const unavailableWorld = { get: () => undefined, findByTag: () => [], emit: () => { throw new Error('gameplay world is unavailable'); }, spawn: () => { throw new Error('gameplay world is unavailable'); }, despawn: () => { throw new Error('gameplay world is unavailable'); } };

export class GameplayScriptRuntime implements RuntimeComponent {
  readonly componentType = 'script';
  readonly componentId: string;
  readonly script: ScriptComponent['script'];
  readonly props: JsonObject;
  readonly state: JsonObject;
  readonly issues: GameplayRuntimeIssue[] = [];
  enabled: boolean;
  private readonly definition: GameplayScriptDefinition | undefined;
  private readonly self: GameplaySelf;
  private readonly random: () => number;
  private started = false;

  constructor(component: ScriptComponent, private readonly context: ComponentRuntimeContext) {
    this.componentId = component.componentId;
    this.script = component.script;
    this.props = { ...component.properties };
    this.enabled = component.enabled;
    this.random = deterministicRandom(seedFrom([context.gameObjectId, context.nodeId, component.componentId, component.script.assetId, component.script.version]));
    const registry = context.services.gameplayRegistry;
    const candidate = registry?.find(component.script);
    if (!candidate) this.fail('gameplay-script-not-found', `${component.script.assetId}@${component.script.version} is unavailable`);
    else if (candidate.reference.contentHash !== component.script.contentHash) this.fail('gameplay-script-hash-mismatch', `${component.script.assetId}@${component.script.version} hash mismatch`);
    else {
      const propertyIssues = validateProperties(candidate.definition.properties, component.properties);
      if (propertyIssues.length) this.fail('gameplay-script-invalid-properties', propertyIssues.map((issue) => `${issue.path} ${issue.message}`).join('; '));
      else this.definition = candidate.definition;
    }
    this.state = this.definition ? this.definition.state({ props: this.props }) : {};
    this.self = { gameObjectId: context.gameObjectId, props: this.props, state: this.state };
  }

  private fail(code: GameplayRuntimeIssueCode, message: string): void {
    this.enabled = false;
    const issue = { code, message, gameObjectId: this.context.gameObjectId, nodeId: this.context.nodeId, componentId: this.componentId, scriptId: this.script.assetId, version: this.script.version };
    this.issues.push(issue);
    this.context.services.logger?.warn(`[${code}] ${this.context.gameObjectId}/${this.componentId}: ${message}`);
  }

  private gameplayContext(step: RuntimeComponentStepContext): GameplayContext { return { ...step, random: this.random, world: this.context.services.gameplayWorld ?? unavailableWorld }; }

  start(step: RuntimeComponentStepContext): void {
    if (!this.enabled || this.started) return;
    this.started = true;
    try { this.definition?.start?.(this.gameplayContext(step), this.self); }
    catch (error) { this.fail('gameplay-script-start-failed', error instanceof Error ? error.message : String(error)); }
  }

  step(step: RuntimeComponentStepContext): void {
    if (!this.enabled) return;
    if (!this.started) this.start(step);
    try { this.definition?.fixedUpdate?.(this.gameplayContext(step), this.self); }
    catch (error) { this.fail('gameplay-script-update-failed', error instanceof Error ? error.message : String(error)); }
  }

  event(step: RuntimeComponentStepContext, event: GameplayEvent): void {
    if (!this.enabled) return;
    const eventSchema = this.definition?.events?.[event.type];
    if (!eventSchema) return;
    const issues = validateProperties(eventSchema, event.payload);
    if (issues.length) { this.fail('gameplay-script-event-failed', issues.map((issue) => issue.message).join('; ')); return; }
    try { this.definition?.onEvent?.(this.gameplayContext(step), this.self, event); }
    catch (error) { this.fail('gameplay-script-event-failed', error instanceof Error ? error.message : String(error)); }
  }

  snapshot(): JsonObject { return structuredClone(this.state); }
  dispose(): void { this.definition?.dispose?.(this.self); }
}

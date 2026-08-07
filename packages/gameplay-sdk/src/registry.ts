import type { GameplayScriptReference } from '@atc/schema';
import type { RegisteredGameplayScript } from './types.ts';

export class GameplayScriptRegistry {
  private readonly entries = new Map<string, RegisteredGameplayScript>();
  constructor(entries: readonly RegisteredGameplayScript[] = []) { for (const entry of entries) this.add(entry); }
  private key(reference: Pick<GameplayScriptReference, 'assetId' | 'version'>): string { return `${reference.assetId}@${reference.version}`; }
  add(entry: RegisteredGameplayScript): void {
    const key = this.key(entry.reference);
    if (this.entries.has(key)) throw new Error(`gameplay script "${key}" is already registered`);
    this.entries.set(key, entry);
  }
  resolve(reference: GameplayScriptReference): RegisteredGameplayScript | undefined {
    const entry = this.entries.get(this.key(reference));
    return entry?.reference.contentHash === reference.contentHash ? entry : undefined;
  }
  find(reference: Pick<GameplayScriptReference, 'assetId' | 'version'>): RegisteredGameplayScript | undefined { return this.entries.get(this.key(reference)); }
  list(): RegisteredGameplayScript[] { return [...this.entries.values()]; }
}

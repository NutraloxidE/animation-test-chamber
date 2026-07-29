import { RuleBasedProvider } from './rule-based.ts';
import { AnthropicProvider } from './anthropic.ts';
import type { AiProvider } from './types.ts';

export * from './types.ts';
export * from './rule-based.ts';
export * from './anthropic.ts';

/**
 * Chooses a provider from the environment. The rule-based provider is the
 * default and the fallback — an unset or invalid AI configuration degrades to
 * it silently rather than disabling AI tuning in the UI.
 */
export function createAiProvider(env: NodeJS.ProcessEnv = process.env): AiProvider {
  const requested = env.AI_PROVIDER ?? 'rule-based';
  const apiKey = env.ANTHROPIC_API_KEY;

  if (requested === 'anthropic' && apiKey) {
    return new AnthropicProvider(apiKey, env.ANTHROPIC_MODEL || 'claude-opus-5');
  }
  return new RuleBasedProvider();
}

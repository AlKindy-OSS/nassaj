import { AntigravityProvider } from '@/modules/providers/list/antigravity/antigravity.provider.js';
import { ClaudeProvider } from '@/modules/providers/list/claude/claude.provider.js';
import { CodexProvider } from '@/modules/providers/list/codex/codex.provider.js';
import { CursorProvider } from '@/modules/providers/list/cursor/cursor.provider.js';
import { DeepSeekProvider } from '@/modules/providers/list/deepseek/deepseek.provider.js';
import { GeminiProvider } from '@/modules/providers/list/gemini/gemini.provider.js';
import { GlmProvider } from '@/modules/providers/list/glm/glm.provider.js';
import { HermesProvider } from '@/modules/providers/list/hermes/hermes.provider.js';
import { KimiProvider } from '@/modules/providers/list/kimi/kimi.provider.js';
import { OpenCodeProvider } from '@/modules/providers/list/opencode/opencode.provider.js';
import type { IProvider } from '@/shared/interfaces.js';
import type { LLMProvider } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

// Partial<Record<...>> because not every LLMProvider literal in the type union
// is guaranteed to have a concrete provider instance registered at startup.
// `resolveProvider` already returns an `AppError` for any unregistered key.
const providers: Partial<Record<LLMProvider, IProvider>> = {
  // Antigravity (agy) is re-enabled over the provider-models layer: its model
  // catalog is fetched live from the agy CloudCode endpoint with a graceful
  // fallback to ANTIGRAVITY_FALLBACK_MODELS (see antigravity-models.provider.ts
  // and antigravity-catalog.client.ts).
  antigravity: new AntigravityProvider(),
  claude: new ClaudeProvider(),
  codex: new CodexProvider(),
  cursor: new CursorProvider(),
  gemini: new GeminiProvider(),
  hermes: new HermesProvider(),
  opencode: new OpenCodeProvider(),
  // Hosted vendor providers (single internal user). Registered here so their
  // models surface automatically in /api/providers/:provider/models and the
  // model picker, and resolveProvider returns them for the chat dispatch.
  kimi: new KimiProvider(),
  deepseek: new DeepSeekProvider(),
  glm: new GlmProvider(),
};

/**
 * Central registry for resolving concrete provider implementations by id.
 */
export const providerRegistry = {
  listProviders(): IProvider[] {
    return Object.values(providers);
  },

  resolveProvider(provider: string): IProvider {
    const key = provider as LLMProvider;
    const resolvedProvider = providers[key];
    if (!resolvedProvider) {
      throw new AppError(`Unsupported provider "${provider}".`, {
        code: 'UNSUPPORTED_PROVIDER',
        statusCode: 400,
      });
    }

    return resolvedProvider;
  },
};

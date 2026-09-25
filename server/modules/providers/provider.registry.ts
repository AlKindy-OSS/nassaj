import { AntigravityProvider } from '@/modules/providers/list/antigravity/antigravity.provider.js';
import { ClaudeProvider } from '@/modules/providers/list/claude/claude.provider.js';
import { CodexProvider } from '@/modules/providers/list/codex/codex.provider.js';
import { CursorProvider } from '@/modules/providers/list/cursor/cursor.provider.js';
import { DeepSeekProvider } from '@/modules/providers/list/deepseek/deepseek.provider.js';
import { GlmProvider } from '@/modules/providers/list/glm/glm.provider.js';
import { HermesProvider } from '@/modules/providers/list/hermes/hermes.provider.js';
import { GeminiSessionsProvider } from '@/modules/providers/list/gemini/gemini-sessions.provider.js';
import { KimiProvider } from '@/modules/providers/list/kimi/kimi.provider.js';
import { OpenCodeProvider } from '@/modules/providers/list/opencode/opencode.provider.js';
import { QwenProvider } from '@/modules/providers/list/qwen/qwen.provider.js';
import type { McpProvider } from '@/modules/providers/shared/mcp/mcp.provider.js';
import type { IProvider, IProviderSessions } from '@/shared/interfaces.js';
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
  hermes: new HermesProvider(),
  opencode: new OpenCodeProvider(),
  qwen: new QwenProvider(),
  // Hosted vendor providers (single internal user). Registered here so their
  // models surface automatically in /api/providers/:provider/models and the
  // model picker, and resolveProvider returns them for the chat dispatch.
  kimi: new KimiProvider(),
  deepseek: new DeepSeekProvider(),
  glm: new GlmProvider(),
};

// Gemini is retired from every active provider surface, but persisted rows may
// still name it. Keep only its stateless history reader: this map is never used
// by model/auth/sync/dispatch paths and therefore cannot create a new session.
const legacyHistoryProviders: Readonly<Partial<Record<LLMProvider, IProviderSessions>>> =
  Object.freeze({ gemini: new GeminiSessionsProvider() });

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

  /** Resolves a read-only history facet, including retired persisted providers. */
  resolveHistorySessions(provider: string): IProviderSessions {
    const key = provider as LLMProvider;
    const active = providers[key];
    if (active) return active.sessions;
    const legacy = legacyHistoryProviders[key];
    if (legacy) return legacy;
    throw new AppError(`Unsupported provider history "${provider}".`, {
      code: 'UNSUPPORTED_PROVIDER',
      statusCode: 400,
    });
  },

  /** Same registered instances, narrowed explicitly for the connector writer. */
  resolveConnectorMcpProvider(provider: 'claude' | 'codex'): McpProvider {
    const resolvedProvider = providers[provider];
    if (provider === 'claude' && resolvedProvider instanceof ClaudeProvider) {
      return resolvedProvider.mcp;
    }
    if (provider === 'codex' && resolvedProvider instanceof CodexProvider) {
      return resolvedProvider.mcp;
    }
    throw new AppError(`Unsupported connector MCP target "${provider}".`, {
      code: 'CONNECTOR_MCP_TARGET_UNSUPPORTED',
      statusCode: 400,
    });
  },
};

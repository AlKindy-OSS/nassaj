import { AntigravityProvider } from '@/modules/providers/list/antigravity/antigravity.provider.js';
import { ClaudeProvider } from '@/modules/providers/list/claude/claude.provider.js';
import { CodexProvider } from '@/modules/providers/list/codex/codex.provider.js';
import { CursorProvider } from '@/modules/providers/list/cursor/cursor.provider.js';
import { DeepSeekProvider } from '@/modules/providers/list/deepseek/deepseek.provider.js';
import { GlmProvider } from '@/modules/providers/list/glm/glm.provider.js';
import { KimiProvider } from '@/modules/providers/list/kimi/kimi.provider.js';
import { OpenCodeProvider } from '@/modules/providers/list/opencode/opencode.provider.js';
import { QwenProvider } from '@/modules/providers/list/qwen/qwen.provider.js';
import type { McpProvider } from '@/modules/providers/shared/mcp/mcp.provider.js';
import { VendorSessionsProvider } from '@/modules/providers/shared/vendor/vendor-sessions.provider.js';
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
  opencode: new OpenCodeProvider(),
  qwen: new QwenProvider(),
  // Hosted vendor providers (single internal user). Registered here so their
  // models surface automatically in /api/providers/:provider/models and the
  // model picker, and resolveProvider returns them for the chat dispatch.
  kimi: new KimiProvider(),
  deepseek: new DeepSeekProvider(),
  glm: new GlmProvider(),
};

/**
 * History-only readers (T-1953, ADR-192): ids whose body was deleted but whose
 * recorded conversations must stay readable. They are NOT providers — nothing
 * here can launch, authenticate or configure anything, and `resolveProvider`
 * keeps refusing them.
 *
 * hermes: every turn was appended to the nassaj-owned JSONL transcript
 * (`~/.nassaj-vendor-sessions/hermes/<projectHash>/<sessionId>.jsonl`), never
 * read from the CLI's own store, so the generic vendor reader is the whole reader.
 */
const historyOnlySessions: Partial<Record<LLMProvider, IProviderSessions>> = {
  hermes: new VendorSessionsProvider({ provider: 'hermes' }),
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

  /** Resolves the read-only history facet of a registered provider or of a deleted body. */
  resolveHistorySessions(provider: string): IProviderSessions {
    // Own keys only: the id comes from a stored session row, and an inherited
    // name such as `constructor` must reach the typed refusal below.
    const key = provider as LLMProvider;
    const active = Object.hasOwn(providers, key) ? providers[key] : undefined;
    if (active) return active.sessions;
    const historyOnly = Object.hasOwn(historyOnlySessions, key) ? historyOnlySessions[key] : undefined;
    if (historyOnly) return historyOnly;
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

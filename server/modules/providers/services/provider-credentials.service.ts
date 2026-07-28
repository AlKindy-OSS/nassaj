/**
 * provider-credentials.service — T-866/B1: single dispatch point for the
 * `/:provider/api-key` routes. It generalizes the old vendor-only path into
 * three cases, resolved per provider:
 *
 *   1. facet    — the provider exposes an IProviderCredentialWriter
 *                 (claude/codex/opencode): delegate to it. The key is written
 *                 into that provider's OWN credential surface inside the user's
 *                 resolved (isolated) tree.
 *   2. vendor   — kimi/deepseek/glm: keep the legacy encrypted-secrets-store
 *                 path (providerSecretsService) — these hosted HTTP APIs read no
 *                 provider config file.
 *   3. none     — no facet, not a vendor (hermes/cursor/antigravity/gemini):
 *                 400 TERMINAL_ONLY (configure by logging in from the terminal).
 *
 * The service owns the business rules; the route stays a thin transport +
 * authorization adapter. Every result is existence-only `{ provider,
 * configured }` — the key value is never returned or logged.
 *
 * Authorization shape (enforced by the route via `requiresElevatedRole`): a
 * write is "shared-scoped" — it touches the OPERATOR's credentials rather than
 * an isolated per-user tree — exactly when the provider is NOT isolated per the
 * provider-sharing policy. Those writes are restricted to owner/admin; isolated
 * writes are per-user (userId comes from the caller's token only).
 */

import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { providerSecretsService } from '@/modules/providers/services/provider-secrets.service.js';
import { isProviderIsolated } from '@/services/provider-sharing.js';
import { isVendorSecretProvider } from '@/services/isolation/provider-secrets-store.js';
import type {
  IProviderCredentialWriter,
  ProviderCredentialStatus,
  ProviderCredentialWriterCapability,
} from '@/shared/interfaces.js';
import type { LLMProvider } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/** Resolves the writer facet for a provider, or null when it has none. */
function resolveWriter(provider: string): IProviderCredentialWriter | null {
  try {
    return providerRegistry.resolveProvider(provider).credentials ?? null;
  } catch {
    // Unregistered provider id: no facet (falls through to vendor/none).
    return null;
  }
}

/** Raised when a provider supports no API-key configuration path at all. */
function terminalOnly(provider: string): AppError {
  return new AppError(
    `Provider "${provider}" is configured from the terminal only.`,
    { code: 'TERMINAL_ONLY', statusCode: 400 },
  );
}

export const providerCredentialsService = {
  /**
   * Advertises how (and for which targets) a provider's key is configured, so
   * the frontend can render the right entry UI. `none` means the provider is
   * terminal-only. Never throws for a known-but-unconfigurable provider.
   */
  getCapability(provider: string): ProviderCredentialWriterCapability {
    const writer = resolveWriter(provider);
    if (writer) {
      return writer.getWriterCapability();
    }
    if (isVendorSecretProvider(provider)) {
      // Vendor keys live in the nassaj-managed encrypted store (a file write).
      return { method: 'native_file' };
    }
    return { method: 'none' };
  },

  /**
   * True when configuring this provider writes the OPERATOR's shared
   * credentials (provider marked 'shared'/unknown in the sharing policy) rather
   * than an isolated per-user tree — the route restricts those to owner/admin.
   * Vendors default 'isolated' so they are per-user unless an admin shares them.
   */
  requiresElevatedRole(provider: string): boolean {
    // Vendor keys are ALWAYS stored per-user in the encrypted store (keyed by
    // userId), so configuring one never touches shared operator credentials —
    // no elevated role, and no DB read on this hot validation path.
    if (isVendorSecretProvider(provider)) {
      return false;
    }
    // A facet write is shared-scoped (hits the operator's own credential file)
    // exactly when the provider is not isolated per the sharing policy.
    return !isProviderIsolated(provider);
  },

  async setKey(
    userId: string | number | null | undefined,
    provider: string,
    apiKey: unknown,
    target?: string,
  ): Promise<ProviderCredentialStatus> {
    const writer = resolveWriter(provider);
    if (writer) {
      if (typeof apiKey !== 'string' || apiKey.trim() === '') {
        throw new AppError('API key is required and must not be empty.', {
          code: 'INVALID_API_KEY',
          statusCode: 400,
        });
      }
      return writer.setApiKey(userId, apiKey.trim(), target);
    }
    if (isVendorSecretProvider(provider)) {
      const result = providerSecretsService.setKey(userId, provider, apiKey);
      return { provider: result.provider as LLMProvider, configured: result.configured };
    }
    throw terminalOnly(provider);
  },

  async deleteKey(
    userId: string | number | null | undefined,
    provider: string,
    target?: string,
  ): Promise<ProviderCredentialStatus> {
    const writer = resolveWriter(provider);
    if (writer) {
      return writer.deleteApiKey(userId, target);
    }
    if (isVendorSecretProvider(provider)) {
      const result = providerSecretsService.deleteKey(userId, provider);
      return { provider: result.provider as LLMProvider, configured: result.configured };
    }
    throw terminalOnly(provider);
  },

  async getStatus(
    userId: string | number | null | undefined,
    provider: string,
    target?: string,
  ): Promise<ProviderCredentialStatus> {
    const writer = resolveWriter(provider);
    if (writer) {
      return { provider: provider as LLMProvider, configured: await writer.isConfigured(userId, target) };
    }
    if (isVendorSecretProvider(provider)) {
      const result = providerSecretsService.getStatus(userId, provider);
      return { provider: result.provider as LLMProvider, configured: result.configured };
    }
    throw terminalOnly(provider);
  },
};

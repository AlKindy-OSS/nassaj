import type { IProviderAuth } from '@/shared/interfaces.js';
import type { LLMProvider, ProviderAuthStatus } from '@/shared/types.js';
import { hasProviderKey } from '@/services/isolation/provider-secrets-store.js';

/**
 * Shared auth facet for hosted vendor providers (kimi/deepseek/glm).
 *
 * These are remote HTTP APIs with no local CLI, so "installed" is always true and
 * "authenticated" is purely a function of whether the calling user has an API key
 * stored in the encrypted per-user secrets store. This mirrors ADR-030: a vendor
 * becomes usable the moment its key is configured. getStatus never throws — an
 * absent key is reported as `authenticated: false`, not an error.
 */
export class VendorAuthProvider implements IProviderAuth {
  private readonly provider: LLMProvider;

  constructor(provider: LLMProvider) {
    this.provider = provider;
  }

  async getStatus(userId?: string | number | null): Promise<ProviderAuthStatus> {
    const authenticated = hasProviderKey(userId ?? null, this.provider as 'kimi' | 'deepseek' | 'glm');
    return {
      installed: true,
      provider: this.provider,
      authenticated,
      email: null,
      method: authenticated ? 'api_key' : null,
      error: authenticated ? undefined : 'No API key configured',
    };
  }
}

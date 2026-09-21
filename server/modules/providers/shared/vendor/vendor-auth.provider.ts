import type { IProviderAuth } from '@/shared/interfaces.js';
import type { LLMProvider, ProviderAuthStatus } from '@/shared/types.js';
import { credentialPrincipalId } from '@/services/isolation/credential-principal.js';
import { resolveSlotKey } from '@/services/isolation/provider-slot-key.js';

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
    // T-1260: `sharedFallback: false` preserves today's answer exactly — this
    // facet reports whether THIS member has configured a key, and an org key
    // does not make their account "authenticated". Wave B revisits that once a
    // shared slot is something a member can be told about.
    const authenticated =
      resolveSlotKey(credentialPrincipalId(userId, this.provider), this.provider as 'kimi' | 'deepseek' | 'glm', {
        sharedFallback: false,
      }) !== null;
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

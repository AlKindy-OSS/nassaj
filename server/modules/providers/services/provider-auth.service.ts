import { providerRegistry } from '@/modules/providers/provider.registry.js';
import type { LLMProvider, ProviderAuthStatus } from '@/shared/types.js';

export const providerAuthService = {
  /**
   * Resolves a provider and returns its installation/authentication status.
   *
   * `userId` is forwarded to the provider so credential-isolating providers
   * report the status of that user's resolved environment, not the operator's.
   */
  async getProviderAuthStatus(
    providerName: string,
    userId?: string | number | null,
  ): Promise<ProviderAuthStatus> {
    const provider = providerRegistry.resolveProvider(providerName);
    return provider.auth.getStatus(userId);
  },

  /**
   * Returns whether a provider runtime appears installed.
   * Falls back to true if status lookup itself fails so callers preserve the
   * original runtime error instead of replacing it with a status-check failure.
   */
  async isProviderInstalled(providerName: LLMProvider): Promise<boolean> {
    try {
      const { auth } = providerRegistry.resolveProvider(providerName);
      // Prefer an install-only probe (IProviderAuth.isInstalled) when the provider
      // offers one: it reports runtime presence WITHOUT reading or logging
      // credential state. For claude this is the B-190 fix — a userId-less
      // getStatus() falls back to the operator ~/.claude and logs a misleading
      // "credentials check failed" WARN, even though this caller only needs the
      // install boolean and the isolated user's real spawn env is fine. Providers
      // without the probe keep the historical getStatus().installed path.
      if (typeof auth.isInstalled === 'function') {
        return await auth.isInstalled();
      }
      return (await auth.getStatus()).installed;
    } catch {
      return true;
    }
  },
};

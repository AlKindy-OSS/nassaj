import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { harnessLinkModeService } from '@/modules/providers/services/harness-link-mode.runtime.js';
import {
  isLinkModeHarness,
  type SwitchLinkModeInput,
} from '@/modules/providers/services/harness-link-mode.service.js';
import type { LLMProvider, ProviderAuthStatus } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/** Antigravity is subscription-only and OpenCode key-only: neither has a link mode. */
function assertLinkModeHarness(providerName: string): 'claude' | 'codex' {
  if (isLinkModeHarness(providerName)) return providerName;
  throw new AppError(`Provider "${providerName}" has no link-mode choice.`, {
    code: 'LINK_MODE_UNSUPPORTED', statusCode: 400,
  });
}

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
   * ADR-200 S4 / M4: the caller's chosen link mode beside the effective one
   * (what the CLI runs on under its own precedence), with drift warnings.
   * Flag off → `{ provider, enabled: false }`.
   */
  async getLinkModeStatus(providerName: string, userId?: string | number | null) {
    return harnessLinkModeService.getStatus(userId ?? null, assertLinkModeHarness(providerName));
  },

  /** ADR-200 S4: the caller's explicit switch between subscription and API key. */
  async switchLinkMode(providerName: string, userId: string | number | null, input: SwitchLinkModeInput) {
    return harnessLinkModeService.switchMode(userId, assertLinkModeHarness(providerName), input);
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

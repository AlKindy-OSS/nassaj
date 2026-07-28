import {
  VENDOR_SECRET_PROVIDERS,
  deleteProviderKey,
  hasProviderKey,
  isVendorSecretProvider,
  setProviderKey,
} from '@/services/isolation/provider-secrets-store.js';
import { AppError } from '@/shared/utils.js';

/**
 * provider-secrets.service — the production caller over the encrypted per-user
 * secrets store (provider-secrets-store.js) for hosted vendor API keys
 * (kimi/deepseek/glm).
 *
 * Boundary: this service owns the business rules (vendor whitelist, non-empty
 * key, never surface the secret) so the route layer stays a thin transport
 * adapter. It returns only existence — `{ provider, configured }` — never the
 * key itself, and never logs the key. Setting a key here makes
 * `GET /api/providers/:provider/auth/status` report `authenticated: true`,
 * because VendorAuthProvider reads the same store via hasProviderKey.
 *
 * @typedef {'kimi'|'deepseek'|'glm'} VendorSecretProvider
 */

// Mirrors the store's `VendorProvider` JSDoc typedef. Declared as an explicit
// literal union (not derived from the runtime VENDOR_SECRET_PROVIDERS array)
// because that array lives in a JS module and tsc widens its element type to
// `string`, which would not satisfy the store's typed key APIs.
export type VendorSecretProviderId = 'kimi' | 'deepseek' | 'glm';

export type ProviderSecretStatus = {
  provider: VendorSecretProviderId;
  configured: boolean;
};

/**
 * Validates that `provider` is one of the three supported vendors, throwing a
 * 400 AppError otherwise. Returns the narrowed id so callers get the literal
 * type without an extra cast.
 */
function assertVendorProvider(provider: string): VendorSecretProviderId {
  if (!isVendorSecretProvider(provider)) {
    throw new AppError(
      `Provider "${provider}" does not support API key configuration.`,
      { code: 'UNSUPPORTED_SECRET_PROVIDER', statusCode: 400 },
    );
  }

  return provider as VendorSecretProviderId;
}

export const providerSecretsService = {
  /** The vendors whose API keys may be configured through these routes. */
  supportedProviders(): readonly VendorSecretProviderId[] {
    // VENDOR_SECRET_PROVIDERS is the single source of truth for the whitelist;
    // the cast re-narrows the JS module's widened `string[]` to the literal union.
    return VENDOR_SECRET_PROVIDERS as readonly VendorSecretProviderId[];
  },

  /**
   * Stores (or replaces) the API key for one (userId, provider). Rejects an
   * empty/whitespace key and any non-vendor provider with a 400. The plaintext
   * is encrypted at rest by the store and is never returned or logged.
   */
  setKey(
    userId: string | number | null | undefined,
    provider: string,
    apiKey: unknown,
  ): ProviderSecretStatus {
    const vendor = assertVendorProvider(provider);

    if (typeof apiKey !== 'string' || apiKey.trim() === '') {
      throw new AppError('API key is required and must not be empty.', {
        code: 'INVALID_API_KEY',
        statusCode: 400,
      });
    }

    setProviderKey(userId ?? null, vendor, apiKey.trim());
    return { provider: vendor, configured: true };
  },

  /**
   * Removes the stored key for one (userId, provider). Idempotent: deleting an
   * absent key still resolves to `configured: false`. Rejects a non-vendor id.
   */
  deleteKey(
    userId: string | number | null | undefined,
    provider: string,
  ): ProviderSecretStatus {
    const vendor = assertVendorProvider(provider);
    deleteProviderKey(userId ?? null, vendor);
    return { provider: vendor, configured: false };
  },

  /**
   * Reports whether a usable key is stored for one (userId, provider) without
   * ever returning the secret value. Rejects a non-vendor id.
   */
  getStatus(
    userId: string | number | null | undefined,
    provider: string,
  ): ProviderSecretStatus {
    const vendor = assertVendorProvider(provider);
    return { provider: vendor, configured: hasProviderKey(userId ?? null, vendor) };
  },
};

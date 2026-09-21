import {
  VENDOR_SECRET_PROVIDERS,
  deleteProviderKey,
  deleteSharedVendorKey,
  isVendorSecretProvider,
  setProviderKey,
  setSharedVendorKey,
} from '@/services/isolation/provider-secrets-store.js';
import { assertNotClaudeSubscriptionToken } from '@/modules/providers/shared/credentials/subscription-token-guard.js';
import { resolveSlotKey } from '@/services/isolation/provider-slot-key.js';
import { AppError } from '@/shared/utils.js';

/**
 * provider-secrets.service — the production caller over the encrypted per-user
 * secrets store (provider-secrets-store.js) for hosted vendor API keys and the
 * versioned Qwen credential profile (plan, region, key).
 *
 * Boundary: this service owns the business rules (vendor whitelist, non-empty
 * key, never surface the secret) so the route layer stays a thin transport
 * adapter. It returns only existence — `{ provider, configured }` — never the
 * key itself, and never logs the key. Setting a key here makes
 * `GET /api/providers/:provider/auth/status` report `authenticated: true`,
 * because VendorAuthProvider reads the same store via hasProviderKey.
 *
 * @typedef {'kimi'|'deepseek'|'glm'|'qwen'} VendorSecretProvider
 */

// Mirrors the store's `VendorProvider` JSDoc typedef. Declared as an explicit
// literal union (not derived from the runtime VENDOR_SECRET_PROVIDERS array)
// because that array lives in a JS module and tsc widens its element type to
// `string`, which would not satisfy the store's typed key APIs.
export type VendorSecretProviderId = 'kimi' | 'deepseek' | 'glm' | 'qwen';

/**
 * Syntax-only validation for the documented `sk-sp-` prefix. It does not prove
 * authenticity or entitlement; those are established only by the future
 * measured CLI integration. The 16..512 total-length bound rejects truncation
 * and memory-abuse payloads without inventing an exact vendor key length.
 */
export function isQwenCodingPlanKey(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const key = value.trim();
  return key.length >= 16 && key.length <= 512 && /^sk-sp-[A-Za-z0-9._-]+$/.test(key);
}

export type QwenPlan = 'coding_plan' | 'token_plan';
export type QwenRegion = 'china' | 'international';

export type QwenCredentialProfile = {
  version: 1;
  plan: QwenPlan;
  region: QwenRegion;
  key: string;
};

const QWEN_KEY_MIN_LENGTH = 16;
const QWEN_KEY_MAX_LENGTH = 512;

function isQwenPlan(value: unknown): value is QwenPlan {
  return value === 'coding_plan' || value === 'token_plan';
}

function isQwenRegion(value: unknown): value is QwenRegion {
  return value === 'china' || value === 'international';
}

function isSafeQwenKey(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const key = value.trim();
  return key.length >= QWEN_KEY_MIN_LENGTH
    && key.length <= QWEN_KEY_MAX_LENGTH
    && !/[\s\u0000-\u001F\u007F]/.test(key);
}

export function createQwenCredentialProfile(
  apiKey: unknown,
  plan: unknown,
  region: unknown,
): QwenCredentialProfile {
  if (!isQwenPlan(plan)) {
    throw new AppError('Qwen plan must be coding_plan or token_plan.', {
      code: 'INVALID_QWEN_PLAN', statusCode: 400,
    });
  }
  if (!isQwenRegion(region)) {
    throw new AppError('Qwen region must be china or international.', {
      code: 'INVALID_QWEN_REGION', statusCode: 400,
    });
  }
  const normalizedKey = typeof apiKey === 'string' ? apiKey.trim() : '';
  const validKey = plan === 'coding_plan'
    ? isQwenCodingPlanKey(normalizedKey)
    : isSafeQwenKey(normalizedKey);
  if (!validKey) {
    throw new AppError(
      plan === 'coding_plan'
        ? 'Qwen Coding Plan keys must be 16–512 characters and begin with "sk-sp-".'
        : 'Qwen Token Plan keys must be 16–512 characters without whitespace or control characters.',
      {
        code: plan === 'coding_plan' ? 'INVALID_QWEN_CODING_PLAN_KEY' : 'INVALID_QWEN_TOKEN_PLAN_KEY',
        statusCode: 400,
      },
    );
  }
  return { version: 1, plan, region, key: normalizedKey };
}

function parseQwenProfile(value: string): QwenCredentialProfile | null {
  // Compatibility with the first Qwen wave: the encrypted slot contained the
  // bare Coding Plan key. Preserve its international default without ever
  // rewriting or surfacing the plaintext during a status read.
  if (isQwenCodingPlanKey(value)) {
    return { version: 1, plan: 'coding_plan', region: 'international', key: value.trim() };
  }
  try {
    const parsed = JSON.parse(value) as Partial<QwenCredentialProfile>;
    if (parsed.version !== 1 || !isQwenPlan(parsed.plan) || !isQwenRegion(parsed.region)) return null;
    if (!isSafeQwenKey(parsed.key)) return null;
    if (parsed.plan === 'coding_plan' && !isQwenCodingPlanKey(parsed.key)) return null;
    return {
      version: 1,
      plan: parsed.plan,
      region: parsed.region,
      key: parsed.key.trim(),
    };
  } catch {
    return null;
  }
}

function getQwenProfileForUser(
  userId: string | number | null | undefined,
): QwenCredentialProfile | null {
  if (userId === null || userId === undefined) return null;
  const resolved = resolveSlotKey(userId, 'qwen', { sharedFallback: false });
  return resolved?.key ? parseQwenProfile(resolved.key) : null;
}

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
    qwenOptions?: { plan?: unknown; region?: unknown },
  ): ProviderSecretStatus {
    const vendor = assertVendorProvider(provider);

    if (typeof apiKey !== 'string' || apiKey.trim() === '') {
      throw new AppError('API key is required and must not be empty.', {
        code: 'INVALID_API_KEY',
        statusCode: 400,
      });
    }

    // B-1252 — a `claude setup-token` subscription token is not a vendor API
    // key. Storing it here would encrypt a personal Claude subscription bearer
    // into the key slot nassaj injects as KIMI_API_KEY / DEEPSEEK_API_KEY /
    // GLM_API_KEY, i.e. hand it to a different vendor's client. Same helper the
    // opencode and codex writers use, so the rule has one definition.
    assertNotClaudeSubscriptionToken(apiKey, `the ${vendor} API key`);

    // T-1260 — the WRITE side of the same split. `userId ?? SYSTEM_SCOPE` said
    // "an unauthenticated writer edits the operator's key set" without ever
    // saying it, which is the shape wave B has to put a role check and an audit
    // row in front of. Spelling the two branches out changes nothing today (the
    // provider router sits behind authenticateToken, so `userId` is a member id
    // on every reachable path) and gives that gate exactly one line to guard.
    if (vendor === 'qwen' && (userId === null || userId === undefined)) {
      throw new AppError('Qwen Coding Plan credentials must belong to an authenticated member.', {
        code: 'QWEN_PERSONAL_CREDENTIAL_REQUIRED',
        statusCode: 403,
      });
    }
    let storedValue = apiKey.trim();
    if (vendor === 'qwen') {
      const profile = createQwenCredentialProfile(
        apiKey,
        qwenOptions?.plan ?? 'coding_plan',
        qwenOptions?.region ?? 'international',
      );
      storedValue = JSON.stringify(profile);
    }

    if (userId === null || userId === undefined) {
      setSharedVendorKey(vendor, storedValue);
    } else {
      setProviderKey(userId, vendor, storedValue);
    }
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
    if (vendor === 'qwen' && (userId === null || userId === undefined)) {
      throw new AppError('Qwen Coding Plan has no operator-wide credential slot.', {
        code: 'QWEN_SHARED_CREDENTIAL_FORBIDDEN',
        statusCode: 403,
      });
    }
    if (userId === null || userId === undefined) {
      deleteSharedVendorKey(vendor);
    } else {
      deleteProviderKey(userId, vendor);
    }
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
    // `sharedFallback: false` preserved verbatim: `configured` has always meant
    // "this scope holds a key", and today an org key does not make a member's
    // slot read as configured. §5 of the design doc tracks that gap (a member on
    // the org key sees `false`) as a wave-C disclosure fix, not a wave-A one.
    return {
      provider: vendor,
      configured: vendor === 'qwen'
        ? getQwenProfileForUser(userId) !== null
        : resolveSlotKey(userId, vendor, { sharedFallback: false }) !== null,
    };
  },

  /** Returns the parsed personal Qwen profile for server-side runtime use only. */
  getQwenProfile(userId: string | number | null | undefined): QwenCredentialProfile | null {
    return getQwenProfileForUser(userId);
  },
};

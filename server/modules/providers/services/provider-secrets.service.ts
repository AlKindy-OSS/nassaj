import {
  VENDOR_SECRET_PROVIDERS,
  deleteProviderKey,
  deleteSharedVendorKey,
  isVendorSecretProvider,
  setProviderKey,
  setSharedVendorKey,
} from '@/services/isolation/provider-secrets-store.js';
import { withProviderSecretsStore } from '@/services/isolation/provider-secrets-store.errors.js';
import { assertNotClaudeSubscriptionToken } from '@/modules/providers/shared/credentials/subscription-token-guard.js';
import { resolveSlotKey } from '@/services/isolation/provider-slot-key.js';
// Namespace import on purpose (same reason as credential-principal.js): many
// test files mock the database barrel with a partial export set.
import * as database from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';
import { isQwenPlanEnabled, qwenPlanProfileVerdict } from '@/services/isolation/opencode-qwen-plan.js';

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
 * Stored plans. `coding_plan` survives only as a LEGACY value read from records
 * saved before ADR-200 D3; nothing writes it any more.
 */
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

/**
 * ADR-200 S7: the only profile nassaj writes is a Token Plan key for the
 * international region (D3, D4). The key carries no vendor prefix rule; only
 * its length and the absence of whitespace/control characters are checked.
 */
export function createQwenCredentialProfile(apiKey: unknown): QwenCredentialProfile {
  const normalizedKey = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!isSafeQwenKey(normalizedKey)) {
    throw new AppError(
      'Alibaba Token Plan keys must be 16–512 characters without whitespace or control characters.',
      { code: 'INVALID_QWEN_TOKEN_PLAN_KEY', statusCode: 400 },
    );
  }
  return { version: 1, plan: 'token_plan', region: 'international', key: normalizedKey };
}

function parseQwenProfile(value: string): QwenCredentialProfile | null {
  try {
    const parsed = JSON.parse(value) as Partial<QwenCredentialProfile>;
    if (parsed.version !== 1 || !isQwenPlan(parsed.plan) || !isQwenRegion(parsed.region)) return null;
    if (!isSafeQwenKey(parsed.key)) return null;
    return { version: 1, plan: parsed.plan, region: parsed.region, key: parsed.key.trim() };
  } catch {
    // The first Qwen wave stored the bare Coding Plan key. It is surfaced as a
    // legacy profile (never rewritten, never deleted silently).
    return isSafeQwenKey(value)
      ? { version: 1, plan: 'coding_plan', region: 'international', key: value.trim() }
      : null;
  }
}

function getQwenProfileForUser(
  userId: string | number | null | undefined,
): QwenCredentialProfile | null {
  if (userId === null || userId === undefined) return null;
  const resolved = resolveSlotKey(userId, 'qwen', { sharedFallback: false });
  return resolved?.key ? parseQwenProfile(resolved.key) : null;
}

/** Request facts the Qwen credential audit row carries (T-1906). Never the key. */
export type QwenCredentialAuditContext = {
  ipAddress?: string | null;
  userAgent?: string | null;
};

function toAuditUserId(userId: string | number | null | undefined): number | undefined {
  const id = Number(userId);
  return Number.isInteger(id) && id > 0 ? id : undefined;
}

/**
 * The ONE place a Qwen credential write/delete is audited (T-1906): every path
 * (per-provider route, company fan-out) reaches setKey/deleteKey, so a row per
 * mutation is guaranteed without the routes repeating it.
 */
function auditQwenCredential(
  action: 'qwen_credential_set' | 'qwen_credential_deleted',
  userId: string | number | null | undefined,
  metadata: Record<string, unknown>,
  context: QwenCredentialAuditContext | undefined,
): void {
  database.auditLogDb?.record(action, {
    userId: toAuditUserId(userId),
    metadata: { provider: 'qwen', scope: 'personal', ...metadata },
    ipAddress: context?.ipAddress ?? undefined,
    userAgent: context?.userAgent ?? undefined,
  });
}

/**
 * ADR-200 §8: the literal vendor keys a member currently holds in their OWN
 * slots (no shared fallback). Used only to redact text; never returned to a
 * client or logged. A slot that cannot be read contributes nothing.
 */
function readVendorRedactionSecrets(userId: string | number | null | undefined): string[] {
  if (userId === null || userId === undefined || userId === '') return [];
  const secrets: string[] = [];
  for (const vendor of VENDOR_SECRET_PROVIDERS as readonly VendorSecretProviderId[]) {
    try {
      const raw = resolveSlotKey(userId, vendor, { sharedFallback: false })?.key;
      if (typeof raw !== 'string' || raw === '') continue;
      secrets.push(vendor === 'qwen' ? parseQwenProfile(raw)?.key ?? raw : raw);
    } catch {
      // An unreadable slot cannot be redacted against; it holds nothing usable.
    }
  }
  return secrets;
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
    auditContext?: QwenCredentialAuditContext,
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
      throw new AppError('Alibaba Token Plan credentials must belong to an authenticated member.', {
        code: 'QWEN_PERSONAL_CREDENTIAL_REQUIRED',
        statusCode: 403,
      });
    }
    const qwenProfile = vendor === 'qwen' ? createQwenCredentialProfile(apiKey) : null;
    const storedValue = qwenProfile ? JSON.stringify(qwenProfile) : apiKey.trim();

    withProviderSecretsStore(() => {
      if (userId === null || userId === undefined) setSharedVendorKey(vendor, storedValue);
      else setProviderKey(userId, vendor, storedValue);
    });
    if (qwenProfile) {
      auditQwenCredential('qwen_credential_set', userId, {
        configured: true,
        plan: qwenProfile.plan,
        region: qwenProfile.region,
      }, auditContext);
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
    auditContext?: QwenCredentialAuditContext,
  ): ProviderSecretStatus {
    const vendor = assertVendorProvider(provider);
    if (vendor === 'qwen' && (userId === null || userId === undefined)) {
      throw new AppError('Alibaba Token Plan has no operator-wide credential slot.', {
        code: 'QWEN_SHARED_CREDENTIAL_FORBIDDEN',
        statusCode: 403,
      });
    }
    withProviderSecretsStore(() => {
      if (userId === null || userId === undefined) deleteSharedVendorKey(vendor);
      else deleteProviderKey(userId, vendor);
    });
    if (vendor === 'qwen') {
      auditQwenCredential('qwen_credential_deleted', userId, { configured: false }, auditContext);
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

  /**
   * T-1906 / ADR-200 S7: whether this member can run `qwen-plan/*` models
   * through OpenCode. `status` is 'ok' | 'missing_key' | 'legacy_profile' (the
   * same codes a refused launch carries); `enabled` mirrors the
   * NASSAJ_OPENCODE_QWEN_PLAN kill switch. Never returns the key.
   */
  getQwenPlanStatus(userId: string | number | null | undefined): {
    enabled: boolean;
    status: 'ok' | 'missing_key' | 'legacy_profile';
  } {
    return {
      enabled: isQwenPlanEnabled(),
      status: qwenPlanProfileVerdict(getQwenProfileForUser(userId)),
    };
  },

  /**
   * ADR-200 §8: one member's own current vendor slot keys, for redaction only.
   * opencode-redaction-secrets.ts composes them with auth.json and grants.
   */
  getVendorRedactionSecrets(userId: string | number | null | undefined): string[] {
    return readVendorRedactionSecrets(userId);
  },

  /**
   * ADR-200 S8: one member's OWN Moonshot (`kimi`) or DeepSeek key for an
   * OpenCode spawn-vendor turn — no credential grant, no operator-wide slot.
   * Server-side runtime use only; never returned to a client or logged.
   */
  getOwnVendorKey(
    userId: string | number | null | undefined,
    slot: 'kimi' | 'deepseek',
  ): string | null {
    if (userId === null || userId === undefined || userId === '') return null;
    return resolveSlotKey(userId, slot, { sharedFallback: false })?.key ?? null;
  },

  /** Returns the parsed personal Qwen profile for server-side runtime use only. */
  getQwenProfile(userId: string | number | null | undefined): QwenCredentialProfile | null {
    return getQwenProfileForUser(userId);
  },
};

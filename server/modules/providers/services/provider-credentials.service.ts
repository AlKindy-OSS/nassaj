/**
 * provider-credentials.service — T-866/B1: single dispatch point for the
 * `/:provider/api-key` routes. It generalizes the old vendor-only path into
 * three cases, resolved per provider:
 *
 *   1. facet    — the provider exposes an IProviderCredentialWriter
 *                 (claude/codex/opencode): delegate to it. The key is written
 *                 into that provider's OWN credential surface inside the user's
 *                 resolved (isolated) tree.
 *   2. vendor   — kimi/deepseek/glm/qwen: keep the encrypted-secrets-store
 *                 path (providerSecretsService) — these hosted HTTP APIs read no
 *                 provider config file.
 *   3. none     — no facet, not a vendor (hermes/cursor/antigravity):
 *                 400 TERMINAL_ONLY (configure by logging in from the terminal).
 *
 * The service owns the business rules; the route stays a thin transport +
 * authorization adapter. Every result is existence-only `{ provider,
 * configured }` — the key value is never returned or logged.
 *
 * ADR-200 S4 (in-flag): this is the SINGLE choke point of the link-mode billing
 * guard. Every Claude/Codex key write and delete — fan-out, company route,
 * legacy route — passes through `harnessLinkModeService`, which refuses a key
 * for a subscription-mode harness with 409 `LINK_MODE_SUBSCRIPTION` under a
 * per-(user, harness) lock. With the flag off it is a pass-through.
 *
 * Authorization shape (enforced by the route via `requiresElevatedRole`): a
 * write is "shared-scoped" — it touches the OPERATOR's credentials rather than
 * an isolated per-user tree — exactly when the provider is NOT isolated per the
 * provider-sharing policy. Those writes are restricted to owner/admin; isolated
 * writes are per-user (userId comes from the caller's token only).
 */

import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { harnessLinkModeService } from '@/modules/providers/services/harness-link-mode.runtime.js';
import { backupBeforeFirstWrite } from '@/modules/providers/services/vendor-key-backup.guard.js';
import {
  createKeyedLock,
  isLinkModeHarness,
  type KeyWriteOptions,
} from '@/modules/providers/services/harness-link-mode.service.js';
// Namespace import on purpose (same reason as provider-secrets.service): many
// test files mock the database barrel with a partial export set.
import * as database from '@/modules/database/index.js';
import {
  providerSecretsService,
  type QwenCredentialAuditContext,
} from '@/modules/providers/services/provider-secrets.service.js';
import { isProviderIsolated } from '@/services/provider-sharing.js';
import { isUnifiedVendorKeysEnabled, isVendorSecretProvider } from '@/services/isolation/provider-secrets-store.js';
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

/**
 * G1 M-4 (out of flag): the stored `claude setup-token` is removed only by this
 * explicit target. Key deletes never touch it (C2) and `.credentials.json` is
 * never touched at all. Audited; the route applies the write-permission gate.
 */
const SETUP_TOKEN_TARGET = 'setup_token';

async function deleteSetupToken(
  userId: string | number | null | undefined,
  provider: string,
  writer: IProviderCredentialWriter,
  auditContext?: QwenCredentialAuditContext,
): Promise<ProviderCredentialStatus> {
  const remove = writer.deleteSubscriptionToken?.bind(writer);
  if (provider !== 'claude' || !remove) {
    throw new AppError('Only Claude stores a setup token.', { code: 'INVALID_CREDENTIAL_TARGET', statusCode: 400 });
  }
  const result = await harnessLinkModeService.withHarnessLock(userId, 'claude', () => remove(userId));
  const auditUserId = Number(userId);
  database.auditLogDb?.record('claude_setup_token_deleted', {
    userId: Number.isInteger(auditUserId) && auditUserId > 0 ? auditUserId : undefined,
    metadata: { provider: 'claude', target: SETUP_TOKEN_TARGET },
    ipAddress: auditContext?.ipAddress ?? undefined,
    userAgent: auditContext?.userAgent ?? undefined,
  });
  return result;
}

/** ADR-200 S6: per-(user, provider) lock for credential files outside the link-mode lock (OpenCode). */
const withFileLock = createKeyedLock();

function fileLockKey(userId: string | number | null | undefined, provider: string): string {
  return `${userId === null || userId === undefined || userId === '' ? '__operator__' : String(userId)}:${provider}`;
}

/**
 * The gate every facet key write passes (ADR-200 §2, §3): the backup before a
 * first write, then the link-mode choke point and its (user, harness) lock for
 * Claude and Codex, or, in-flag, a per-(user, provider) lock for the others.
 * Flag off: a pass-through, exactly as before.
 */
async function gateKeyWrite<T>(
  userId: string | number | null | undefined,
  provider: string,
  key: string,
  options: KeyWriteOptions,
  work: () => Promise<T>,
): Promise<T> {
  await backupBeforeFirstWrite(userId, provider);
  if (isLinkModeHarness(provider)) return harnessLinkModeService.guardKeyWrite(userId, provider, key, options, work);
  return isUnifiedVendorKeysEnabled() ? withFileLock(fileLockKey(userId, provider), work) : work();
}

/** The delete twin of {@link gateKeyWrite}; a key delete keeps the link mode (D6). */
async function gateKeyDelete<T>(
  userId: string | number | null | undefined,
  provider: string,
  work: () => Promise<T>,
): Promise<T> {
  await backupBeforeFirstWrite(userId, provider);
  if (isLinkModeHarness(provider)) return harnessLinkModeService.guardKeyDelete(userId, provider, work);
  return isUnifiedVendorKeysEnabled() ? withFileLock(fileLockKey(userId, provider), work) : work();
}

/**
 * ADR-200 G2 (B-1570): the same (user, harness) lock the key gates take, with
 * no backup and no link-mode check, for work that rewrites a credential file
 * on its own terms (the §3 backup restore). Flag off: no lock, as the gates.
 */
async function withCredentialFileLock<T>(
  userId: string | number | null | undefined,
  provider: string,
  work: () => Promise<T>,
): Promise<T> {
  if (isLinkModeHarness(provider)) return harnessLinkModeService.withHarnessLock(userId, provider, work);
  return isUnifiedVendorKeysEnabled() ? withFileLock(fileLockKey(userId, provider), work) : work();
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
   * Vendors default 'isolated'. Qwen is additionally hard-pinned to isolated
   * by provider-sharing because Coding Plan is personal-only (ADR-101).
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
    authenticatedPrincipal?: unknown,
    auditContext?: QwenCredentialAuditContext,
    // G1: the most restrictive origin unless a caller says otherwise.
    options: KeyWriteOptions = { origin: 'legacy_route' },
  ): Promise<ProviderCredentialStatus> {
    const writer = resolveWriter(provider);
    if (writer) {
      if (typeof apiKey !== 'string' || apiKey.trim() === '') {
        throw new AppError('API key is required and must not be empty.', {
          code: 'INVALID_API_KEY',
          statusCode: 400,
        });
      }
      const key = apiKey.trim();
      return gateKeyWrite(userId, provider, key, options,
        () => writer.setApiKey(userId, key, target, authenticatedPrincipal));
    }
    if (isVendorSecretProvider(provider)) {
      const result = providerSecretsService.setKey(userId, provider, apiKey, auditContext);
      return { provider: result.provider as LLMProvider, configured: result.configured };
    }
    throw terminalOnly(provider);
  },

  async deleteKey(
    userId: string | number | null | undefined,
    provider: string,
    target?: string,
    auditContext?: QwenCredentialAuditContext,
  ): Promise<ProviderCredentialStatus> {
    const writer = resolveWriter(provider);
    if (writer && target === SETUP_TOKEN_TARGET) {
      await backupBeforeFirstWrite(userId, provider);
      return deleteSetupToken(userId, provider, writer, auditContext);
    }
    if (writer) return gateKeyDelete(userId, provider, () => writer.deleteApiKey(userId, target));
    if (isVendorSecretProvider(provider)) {
      const result = providerSecretsService.deleteKey(userId, provider, auditContext);
      return { provider: result.provider as LLMProvider, configured: result.configured };
    }
    throw terminalOnly(provider);
  },

  /**
   * ADR-200 S6: runs fan-out work under the same gate as `setKey` (backup, link
   * mode, lock). Inside it use {@link credentialWriter}: calling `setKey` there
   * would wait on the lock it already holds.
   */
  withKeyWriteGate: gateKeyWrite,

  /** ADR-200 S6: the delete twin of `withKeyWriteGate`. */
  withKeyDeleteGate: gateKeyDelete,

  /** ADR-200 G2: the gates' (user, harness) lock alone; see {@link withCredentialFileLock}. */
  withCredentialFileLock,

  /** The raw writer facet of a provider, or null; for work already inside a gate. */
  credentialWriter(provider: string): IProviderCredentialWriter | null {
    return resolveWriter(provider);
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

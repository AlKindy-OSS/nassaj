/**
 * vendor-key-fanout.runtime — ADR-200 S6: the production wiring of the vendor
 * key fan-out (credential gates and writers, AES store, members, scope). Kept
 * apart from the service so its tests inject plain fakes.
 */

// Namespace import on purpose (same reason as harness-link-mode.runtime): many
// test files mock the database barrel with a partial export set.
import * as database from '@/modules/database/index.js';
import * as store from '@/services/isolation/provider-secrets-store.js';
import { withProviderSecretsStore } from '@/services/isolation/provider-secrets-store.errors.js';
import { isProviderIsolated } from '@/services/provider-sharing.js';
import type { IProviderCredentialWriter } from '@/shared/interfaces.js';
import { AppError } from '@/shared/utils.js';

import { CANONICAL_VENDOR_SECRET_PREFIX } from '../../../../shared/vendors.js';

import { providerCredentialsService } from './provider-credentials.service.js';
import { providerSecretsService } from './provider-secrets.service.js';
import { listSweepMemberIds } from './vendor-key-sweep-members.js';
import {
  createVendorKeyFanoutService,
  type CanonicalSecretPort,
  type ProjectionPort,
} from './vendor-key-fanout.service.js';

/** The raw writer facet with its key reader; a provider without one cannot be projected into. */
function projectionWriter(provider: string): IProviderCredentialWriter & Required<Pick<IProviderCredentialWriter, 'readApiKey'>> {
  const writer = providerCredentialsService.credentialWriter(provider);
  if (!writer?.readApiKey) {
    throw new AppError(`Provider "${provider}" has no projectable credential file.`, { code: 'TERMINAL_ONLY', statusCode: 400 });
  }
  return writer as IProviderCredentialWriter & Required<Pick<IProviderCredentialWriter, 'readApiKey'>>;
}

/**
 * `replaceForeignKey: true` skips only S4's record-based foreign check: inside
 * the gate the fan-out decides ownership from the ledger itself (§2). The mode
 * refusal (409 `LINK_MODE_SUBSCRIPTION`) still applies.
 */
const projections: ProjectionPort = {
  withWriteGate: (userId, provider, key, work) => providerCredentialsService.withKeyWriteGate(
    userId, provider, key, { origin: 'fanout', replaceForeignKey: true }, work,
  ),
  withDeleteGate: (userId, provider, work) => providerCredentialsService.withKeyDeleteGate(userId, provider, work),
  read: (userId, provider, target) => projectionWriter(provider).readApiKey(userId, target),
  write: async (userId, provider, key, target, principal) => {
    await projectionWriter(provider).setApiKey(userId, key, target, principal);
  },
  remove: async (userId, provider, target) => {
    await projectionWriter(provider).deleteApiKey(userId, target);
  },
};

function canonicalId(secretId: string): string | null {
  return secretId.startsWith(CANONICAL_VENDOR_SECRET_PREFIX) ? secretId.slice(CANONICAL_VENDOR_SECRET_PREFIX.length) : null;
}

function unverifiedSecret(): AppError {
  return new AppError('The vendor key could not be verified after saving.', {
    code: 'VENDOR_KEY_WRITE_UNVERIFIED', statusCode: 500,
  });
}

/**
 * A `vendor:*` record goes straight to the store; a legacy slot (kimi, glm,
 * qwen, deepseek) through providerSecretsService, which keeps its own rules
 * (the Qwen profile and audit row). Both are re-read after the write (L4).
 */
const secrets: CanonicalSecretPort = {
  write(userId, secretId, key, auditContext) {
    const vendorId = canonicalId(secretId);
    if (vendorId) {
      withProviderSecretsStore(() => store.setCanonicalVendorKey(userId, vendorId, key));
      if (store.getCanonicalVendorKey(userId, vendorId) !== key.trim()) throw unverifiedSecret();
      return;
    }
    providerSecretsService.setKey(userId, secretId, key, auditContext);
    if (!providerSecretsService.getStatus(userId, secretId).configured) throw unverifiedSecret();
  },
  remove(userId, secretId, auditContext) {
    const vendorId = canonicalId(secretId);
    if (vendorId) withProviderSecretsStore(() => store.deleteCanonicalVendorKey(userId, vendorId));
    else providerSecretsService.deleteKey(userId, secretId, auditContext);
  },
  readState(userId, secretId) {
    const read = store.readVendorKeyState(userId, secretId) as
      { state: 'absent' } | { state: 'unreadable' } | { state: 'ok'; value: string };
    return read.state === 'ok' ? read : { state: read.state };
  },
};

function toAuditUserId(userId: string | number): number | undefined {
  const id = Number(userId);
  return Number.isInteger(id) && id > 0 ? id : undefined;
}

export const vendorKeyFanoutService = createVendorKeyFanoutService({
  isEnabled: () => store.isUnifiedVendorKeysEnabled(),
  fingerprint: (value, keyVersion) => store.projectionFingerprint(value, keyVersion),
  keyVersion: store.PROJECTION_FINGERPRINT_KEY_VERSION,
  now: () => new Date(),
  listMemberIds: listSweepMemberIds,
  isOwnScope: (provider) => isProviderIsolated(provider),
  requiresElevatedRole: (provider) => providerCredentialsService.requiresElevatedRole(provider),
  projections,
  secrets,
  audit: (userId, action, metadata, context) => {
    database.auditLogDb?.record(action, {
      userId: toAuditUserId(userId),
      metadata,
      ipAddress: context?.ipAddress ?? undefined,
      userAgent: context?.userAgent ?? undefined,
    });
  },
});

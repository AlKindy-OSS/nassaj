import { existsSync } from 'node:fs';

// eslint-disable-next-line boundaries/dependencies -- this file is the grant production composition root.
import { getConnection, getDatabasePath } from '@/modules/database/connection.js';
// eslint-disable-next-line boundaries/dependencies -- schema boot belongs to the production composition root.
import { migrateConnectorAuthSchema } from '@/modules/database/connector-auth.migration.js';
// eslint-disable-next-line boundaries/dependencies -- persistence remains behind the grant adapter.
import { createConnectorAuthDb } from '@/modules/database/repositories/connector-auth.db.js';
import { connectorsDb } from '@/modules/database/index.js';
import { getNamespacedSecret } from '@/services/isolation/provider-secrets-store.js';

import { runLocalUpdateBackground } from '../../services/update-writer-lease.js';
import { providerAuthSpecFor } from '../../../shared/connector-auth-registry.js';

import { probeConnectorApiKeyCandidate } from './connector-api-key-probe.js';
import { ConnectorPolicyOperation } from './connector-policy-v2.js';
import { assertConnectorProviderEffectEnabled } from './connector-substrate-only.production.js';
import { createConnectorCredentialRetentionService } from './connector-credential-retention.js';
import {
  FileConnectorAuthKeyring,
  createConnectorAuthKeyringFile,
  decryptConnectorVaultSecret,
} from './connector-auth-vault.crypto.js';
import {
  createConnectorGrantDualReader,
  createConnectorUserGrantService,
  assertConnectorGrantSubjectIdentity,
  connectorRuntimePolicyFor,
  consumeAuthorizedConnectorGrantMaterial,
  createAuthorizedOAuthGrantMaterialReference,
  resolveConnectorGrantFanout,
  type ConnectorGrantEligibleBody,
  type ConnectorGrantMaterialReference,
} from './connector-user-grant.service.js';

type Runtime = Readonly<{
  grants: ReturnType<typeof createConnectorUserGrantService>;
  dualReader: ReturnType<typeof createConnectorGrantDualReader>;
  repository: ReturnType<typeof createConnectorAuthDb>;
  installationId: string;
  keyring: FileConnectorAuthKeyring;
}>;

let runtime: Runtime | null = null;

/** Refresh decision shared by every V2 OAuth consumer; raw token bytes never leave the callback. */
export const productionOAuthBundleNeedsRefresh = (bytes: Buffer, now = Date.now()): boolean => {
  let parsed: { expiresAt?: unknown; refreshToken?: unknown };
  try { parsed = JSON.parse(bytes.toString('utf8')) as typeof parsed; }
  catch { throw new Error('connector_oauth_material_corrupt'); }
  return typeof parsed.expiresAt === 'number' && parsed.expiresAt - 60_000 <= now
    && typeof parsed.refreshToken === 'string' && parsed.refreshToken.length > 0;
};

/** Exact connector/account binding check for untrusted MCP child coordinates. */
export const connectorGrantBindingMatches = (
  binding: Readonly<{ grantId: string }> | null,
  expectedGrantId: string,
): boolean => binding?.grantId === expectedGrantId;

/** Refreshes OAuth material, then closes the race by revalidating its exact connector binding. */
export const refreshThenRevalidateConnectorGrantBinding = async (input: Readonly<{
  grantId: string;
  refresh: () => Promise<void>;
  readBinding: () => Readonly<{ grantId: string }> | null;
}>): Promise<void> => {
  await input.refresh();
  if (!connectorGrantBindingMatches(input.readBinding(), input.grantId)) {
    throw new Error('connector_oauth_binding_mismatch');
  }
};

/** Pure launch boundary: M1/legacy references cannot enter the new placement path. */
export const isM2PlacementMaterialReference = (
  reference: ConnectorGrantMaterialReference | null,
): boolean => reference?.kind === 'v2' && reference.provenance === 'm2';

/** Official boot hook; cleanup does not wait for a connector distribution request. */
export const runConnectorCredentialRetentionAtStartup = (): Readonly<{ removedCandidates: number }> => {
  const database = getConnection();
  migrateConnectorAuthSchema(database);
  const retention = createConnectorCredentialRetentionService(createConnectorAuthDb(database));
  let removedCandidates = 0;
  for (let batch = 0; batch < 10; batch += 1) {
    const result = retention.runOnce(100);
    removedCandidates += result.removedCandidates;
    if (result.removedCandidates < 100) break;
  }
  if (!retentionTimer) {
    retentionTimer = setInterval(() => {
      void runLocalUpdateBackground('connector-retention', () => retention.runOnce(100))
        .catch(() => { /* next bounded tick retries */ });
    }, 15 * 60 * 1_000);
    retentionTimer.unref();
  }
  return Object.freeze({ removedCandidates });
};

let retentionTimer: NodeJS.Timeout | null = null;

const buildRuntime = (): Runtime => {
  if (runtime) return runtime;
  const database = getConnection();
  migrateConnectorAuthSchema(database);
  const repository = createConnectorAuthDb(database);
  createConnectorCredentialRetentionService(repository).runOnce();
  const installationId = repository.getOrCreateInstallation();
  const keyringPath = `${getDatabasePath()}.connector-auth-keyring.json`;
  const keyring = existsSync(keyringPath)
    ? new FileConnectorAuthKeyring(keyringPath)
    : createConnectorAuthKeyringFile(keyringPath);
  const grants = createConnectorUserGrantService({
    installationId, repository, keyring, env: process.env,
    testApiKeyCandidate: probeConnectorApiKeyCandidate,
  });
  const legacy = {
    readCopy(userId: number, serviceId: string) {
      const connector = connectorsDb.listEnabledForUser(userId).find(candidate =>
        candidate.service === serviceId && candidate.authMode === 'key'
        && candidate.credentialMode === 'per_member' && candidate.ownerUserId === userId,
      );
      if (!connector) return null;
      const secret = getNamespacedSecret(userId, 'connector', connector.id);
      return secret === null ? null : {
        secret: Buffer.from(secret, 'utf8'),
        provenance: `connector:${connector.id}:revision:${connector.sourceRevision}`,
      };
    },
  };
  const dualReader = createConnectorGrantDualReader({
    installationId, repository, keyring, legacy, env: process.env,
    migrateLegacy: async input => {
      await grants.putPersonalApiKey(input.userId, {
        serviceId: input.serviceId, apiKey: input.secret.toString('utf8'),
        providerSubject: `legacy:${input.fingerprint}`, accountLabel: 'Default',
        legacyProvenance: input.provenance,
      });
    },
  });
  runtime = Object.freeze({ grants, dualReader, repository, installationId, keyring });
  return runtime;
};

const resolveProductionMaterial = async (
  current: Runtime,
  userId: number,
  serviceId: string,
  expected?: Readonly<{ grantId: string; secretRef?: string }>,
): Promise<ConnectorGrantMaterialReference | null> => {
  const spec = providerAuthSpecFor(serviceId);
  if (!spec) return null;
  if (spec.method === 'api_key') {
    if (!expected?.grantId) return null;
    const reference = await current.dualReader.resolve(userId, serviceId, expected.grantId);
    // The actual API-key writer still creates M1 material. New distribution is
    // M2-only; M1 can be migrated but cannot bypass bundle verification.
    return isM2PlacementMaterialReference(reference) ? reference : null;
  }
  const profile = current.repository.listProfiles(current.installationId)
    .find(candidate => candidate.providerId === spec.profileId && candidate.status === 'ready');
  if (!profile) return null;
  const material = current.repository.readActiveOAuthGrantMaterial(
    current.installationId, userId, profile.profileId, serviceId,
    connectorRuntimePolicyFor(serviceId, process.env),
    expected?.grantId,
  );
  if (material.state === 'corrupt') throw new Error('connector_oauth_grant_corrupt');
  if (material.state === 'ineligible') throw new Error(`connector_oauth_grant_ineligible:${material.reason}`);
  if (material.state !== 'ready') return null;
  if (expected?.secretRef && material.secretRef !== expected.secretRef) {
    throw new Error('connector_oauth_material_revision_changed');
  }
  assertConnectorGrantSubjectIdentity(material, current.installationId, current.keyring);
  return createAuthorizedOAuthGrantMaterialReference({
    userId, serviceId, grantId: material.grantId, secretRef: material.secretRef,
    readBundle: () => decryptConnectorVaultSecret(material.envelope, {
      vaultSecretId: material.secretRef, installationId: current.installationId,
      providerId: material.providerId, subjectType: 'grant', subjectId: material.grantId,
      profileId: material.profileId, userId, fieldPurpose: 'oauth_token_bundle',
    }, current.keyring),
  });
};

/** Exact runtime OAuth material reader for DB-aware built-in MCP servers. */
export const withProductionOAuthTokenBundle = async <T>(input: Readonly<{
  connectorId: string; userId: number; serviceId: string; grantId: string; secretRef: string;
  consume: (bundle: Buffer) => T | Promise<T>;
}>): Promise<Awaited<T>> => {
  const current = buildRuntime();
  const binding = current.repository.readOAuthConnectorGrantBinding(
    input.connectorId, current.installationId, input.userId, input.serviceId,
  );
  if (!connectorGrantBindingMatches(binding, input.grantId)) {
    throw new Error('connector_oauth_binding_mismatch');
  }
  const spec = providerAuthSpecFor(input.serviceId);
  if (!spec) throw new Error('connector_provider_unknown');
  assertConnectorProviderEffectEnabled({ operation: ConnectorPolicyOperation.CredentialUse,
    providerId: spec.profileId, serviceId: input.serviceId, userId: input.userId,
    grantId: input.grantId });
  const reference = await resolveProductionMaterial(current, input.userId, input.serviceId, {
    grantId: input.grantId,
  });
  if (!reference) throw new Error('connector_oauth_material_missing');
  const first = await consumeAuthorizedConnectorGrantMaterial(reference, async bundle => {
    const bytes = bundle.shape === 'oauth_token_bundle'
      ? bundle.fields.get('oauth_token_bundle') ?? null
      : null;
    if (!bytes) throw new Error('connector_oauth_material_incomplete');
    if (productionOAuthBundleNeedsRefresh(bytes)) {
      return Object.freeze({ refresh: true as const });
    }
    return Object.freeze({ refresh: false as const, value: await input.consume(bytes) });
  });
  if (!first.refresh) return first.value;
  const { refreshProductionConnectorOAuthGrant } = await import('./connector-oauth-v2.routes.js');
  await refreshThenRevalidateConnectorGrantBinding({
    grantId: input.grantId,
    refresh: () => refreshProductionConnectorOAuthGrant({
      connectorId: input.connectorId, userId: input.userId,
      serviceId: input.serviceId, grantId: input.grantId,
    }),
    readBinding: () => current.repository.readOAuthConnectorGrantBinding(
      input.connectorId, current.installationId, input.userId, input.serviceId,
    ),
  });
  const refreshed = await resolveProductionMaterial(current, input.userId, input.serviceId, {
    grantId: input.grantId,
  });
  if (!refreshed) throw new Error('connector_oauth_refresh_material_missing');
  return consumeAuthorizedConnectorGrantMaterial(refreshed, bundle => {
    const bytes = bundle.shape === 'oauth_token_bundle'
      ? bundle.fields.get('oauth_token_bundle') ?? null
      : null;
    if (!bytes) throw new Error('connector_oauth_material_incomplete');
    return input.consume(bytes);
  });
};

/**
 * Temporal placement capability. Material can only be consumed inside this
 * callback after the central policy/identity gate has resolved it; plaintext
 * buffers are zeroed before control returns to the caller.
 */
export const withProductionConnectorGrantCapability = async <T>(
  connectorId: string,
  userId: number,
  serviceId: string,
  consume: (input: Readonly<{
    reference: ConnectorGrantMaterialReference;
    credential: Buffer | null;
  }>) => T | Promise<T>,
): Promise<Awaited<T> | null> => {
  const current = buildRuntime();
  const spec = providerAuthSpecFor(serviceId);
  const apiKey = spec?.method === 'api_key';
  const binding = apiKey
    ? current.repository.readApiKeyConnectorGrantBinding(
      connectorId, current.installationId, userId, serviceId,
    )
    : current.repository.readOAuthConnectorGrantBinding(
      connectorId, current.installationId, userId, serviceId,
    );
  if (!binding) return null;
  if (!spec) throw new Error('connector_provider_unknown');
  assertConnectorProviderEffectEnabled({ operation: ConnectorPolicyOperation.CredentialUse,
    providerId: spec.profileId, serviceId, userId, grantId: binding.grantId });
  const reference = await resolveProductionMaterial(
    current, userId, serviceId, binding ? { grantId: binding.grantId } : undefined,
  );
  if (!reference) return null;
  return consumeAuthorizedConnectorGrantMaterial(reference, async bundle => {
    const credential = bundle.shape === 'single_api_key'
      ? bundle.fields.get('api_key') ?? null
      : null;
    if (reference.credentialShape === 'single_api_key' && credential === null) {
      throw new Error('connector_grant_material_incomplete');
    }
    return await consume({ reference, credential });
  });
};

/** Production bridge used by placement; legacy bytes remain untouched and are never returned. */
export const resolveProductionConnectorGrantFanout = async (
  connectorId: string,
  userId: number,
  serviceId: string,
  bodies: readonly ConnectorGrantEligibleBody[],
) => {
  const current = buildRuntime();
  const spec = providerAuthSpecFor(serviceId);
  const apiKey = spec?.method === 'api_key';
  const binding = apiKey
    ? current.repository.readApiKeyConnectorGrantBinding(
      connectorId, current.installationId, userId, serviceId,
    )
    : current.repository.readOAuthConnectorGrantBinding(
      connectorId, current.installationId, userId, serviceId,
    );
  if (!binding) return Object.freeze([]);
  if (!spec) throw new Error('connector_provider_unknown');
  assertConnectorProviderEffectEnabled({ operation: ConnectorPolicyOperation.PlacementWrite,
    providerId: spec.profileId, serviceId, userId, grantId: binding.grantId });
  return resolveConnectorGrantFanout({
    userId, serviceId, bodies,
    resolve: () => resolveProductionMaterial(
      current, userId, serviceId, binding ? { grantId: binding.grantId } : undefined,
    ),
  });
};

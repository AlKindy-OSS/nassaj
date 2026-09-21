import { existsSync } from 'node:fs';

import express from 'express';

// eslint-disable-next-line boundaries/dependencies -- production composition resolves the database location here.
import { getConnection, getDatabasePath } from '@/modules/database/connection.js';
// eslint-disable-next-line boundaries/dependencies -- this is the sole production composition root for the auth-profile writer.
import { migrateConnectorAuthSchema } from '@/modules/database/connector-auth.migration.js';
// eslint-disable-next-line boundaries/dependencies -- raw persistence stays behind this production adapter.
import { createConnectorAuthDb } from '@/modules/database/repositories/connector-auth.db.js';

import { isProviderAuthRegistryEnabled,
  providerAuthSpecFor } from '../../../shared/connector-auth-registry.js';

import { probeConnectorApiKeyCandidate } from './connector-api-key-probe.js';
import {
  ConnectorProfileManagementError,
  createConnectorProfileManagementService,
} from './connector-auth-profile-management.js';
import {
  FileConnectorAuthKeyring,
  createConnectorAuthKeyringFile,
} from './connector-auth-vault.crypto.js';
import {
  authorizedOwnerOperation,
  createConnectorOwnerReadGate,
  createConnectorOwnerOperationGate,
  type ConnectorOwnerOperation,
} from './connector-owner-operation-gate.js';
import { configureConnectorOwnerAuthSessionProduction } from './connector-owner-auth-session.js';
import { executeConnectorPolicyV2LifecycleWrite,
  resolveConnectorRuntimeInstallationOrigin,
  assertConnectorProviderEffectEnabled,
  connectorProviderProfileOperationCertified } from './connector-substrate-only.production.js';
import { ConnectorPolicyOperation } from './connector-policy-v2.js';

type Repository = ReturnType<typeof createConnectorAuthDb>;
type Service = ReturnType<typeof createConnectorProfileManagementService>;
type ProfileRuntime = Readonly<{
  installationId: string;
  canonicalOrigin: string;
  repository: Repository;
  service: Service;
}>;

let productionRuntime: ProfileRuntime | null = null;

/** Read-only access for sibling HTTP composition; never creates installation state. */
export const connectorAuthProfileRuntime = (): ProfileRuntime | null => productionRuntime;

const buildProductionRuntime = (): ProfileRuntime => {
  if (productionRuntime) return productionRuntime;
  const database = getConnection();
  migrateConnectorAuthSchema(database);
  const repository = createConnectorAuthDb(database);
  const installationId = repository.getOrCreateInstallation();
  const resolvedOrigin = resolveConnectorRuntimeInstallationOrigin();
  if (!resolvedOrigin || resolvedOrigin.installationId !== installationId) {
    throw new Error('connector_installation_origin_unavailable');
  }
  const canonicalOrigin = resolvedOrigin.canonicalOrigin;
  const keyringPath = `${getDatabasePath()}.connector-auth-keyring.json`;
  const keyring = existsSync(keyringPath)
    ? new FileConnectorAuthKeyring(keyringPath)
    : createConnectorAuthKeyringFile(keyringPath);
  const service = createConnectorProfileManagementService({
    installation: {
      installationId,
      canonicalOrigin,
      callbackUrl: resolvedOrigin.callbackUrl,
    },
    repository,
    keyring,
    env: process.env,
    // Provider-specific probes are intentionally fail-closed until their
    // conformance adapters are certified; staged secrets remain inert.
    testByoCandidate: async () => { throw new Error('connector_profile_candidate_probe_unavailable'); },
    testApiKeyCandidate: async candidate => { await probeConnectorApiKeyCandidate(candidate); },
    providerCertified: connectorProviderProfileOperationCertified,
  });
  configureConnectorOwnerAuthSessionProduction({ repository, installationId, canonicalOrigin,
    executeWrite: executeConnectorPolicyV2LifecycleWrite });
  productionRuntime = Object.freeze({ installationId, canonicalOrigin, repository, service });
  return productionRuntime;
};

/** Lazy Policy V2 owner composition; no legacy environment feature flag controls it. */
export const connectorAuthProfileRuntimeForOwnerSetup = (): ProfileRuntime => buildProductionRuntime();

const profileFailure = (res: express.Response, error: unknown): void => {
  const code = error instanceof ConnectorProfileManagementError ? error.message : '';
  const status = code.endsWith('_provider_not_supported') || code.endsWith('_candidate_invalid') ? 400
    : code.endsWith('_not_found') ? 404
      : code.endsWith('_owner_verification_failed') ? 403
        : code.endsWith('_write_in_progress') ? 409
          : code.endsWith('_provider_not_certified') ? 409
            : code.endsWith('_candidate_test_failed') ? 422
              : 500;
  res.status(status).json({
    error: status === 500 ? 'Connector profile operation failed.' : 'Connector profile request was rejected.',
    code: code || 'CONNECTOR_PROFILE_OPERATION_FAILED',
  });
};

type RuntimeFactory = () => ProfileRuntime;

const routeParameter = (value: string | string[]): string => Array.isArray(value) ? '' : value;

const exactProfileEffect = (req: express.Request, expectedMethod: 'byo_app'|'dcr_pkce'|'api_key') => {
  const providerId = routeParameter(req.params.providerId);
  const serviceId = typeof req.body?.serviceId === 'string' ? req.body.serviceId : providerId;
  const spec = providerAuthSpecFor(serviceId);
  if (!spec || spec.profileId !== providerId || spec.method !== expectedMethod) {
    throw new ConnectorProfileManagementError('connector_profile_candidate_invalid');
  }
  return { providerId, serviceId };
};

/** Feature-gated production HTTP adapter; no raw repository writer escapes it. */
export const createConnectorAuthProfileRoutes = (
  runtimeFactory: RuntimeFactory = buildProductionRuntime,
): express.Router => {
  const routes = express.Router();
  // Boot contract: when enabled, schema/keyring/runtime composition completes
  // synchronously now. DDL failure therefore aborts startup, never a request.
  const eagerRuntime = isProviderAuthRegistryEnabled() ? runtimeFactory() : null;

  const runtimeForRequest = (res: express.Response): ProfileRuntime | null => {
    if (!isProviderAuthRegistryEnabled()) {
      res.status(404).json({ error: 'Not found.', code: 'CONNECTOR_AUTH_REGISTRY_DISABLED' });
      return null;
    }
    if (!eagerRuntime) {
      res.status(503).json({
        error: 'Connector authentication is unavailable.',
        code: 'CONNECTOR_AUTH_BOOTSTRAP_UNAVAILABLE',
      });
      return null;
    }
    return eagerRuntime;
  };

  const operation = (
    operationName: ConnectorOwnerOperation,
    action: (runtime: ProfileRuntime, req: express.Request, res: express.Response) => Promise<void>,
  ): express.RequestHandler => (req, res) => {
    const runtime = runtimeForRequest(res);
    if (!runtime) return;
    createConnectorOwnerOperationGate({
      repository: runtime.repository,
      installationId: runtime.installationId,
      canonicalOrigin: runtime.canonicalOrigin,
      operation: operationName,
    })(req, res, () => {
      void action(runtime, req, res).catch(error => profileFailure(res, error));
    });
  };

  routes.get('/', (req, res) => {
    const runtime = runtimeForRequest(res);
    if (!runtime) return;
    createConnectorOwnerReadGate({
      repository: runtime.repository, installationId: runtime.installationId,
    })(req, res, () => {
      void runtime.service.list()
        .then(profiles => res.json({ schemaVersion: 1, profiles }))
        .catch(error => profileFailure(res, error));
    });
  });
  routes.put('/:providerId/byo', operation('upsert_byo', async (runtime, req, res) => {
    const effect = exactProfileEffect(req, 'byo_app');
    assertConnectorProviderEffectEnabled({ operation: ConnectorPolicyOperation.ProfileConfigure,
      ...effect });
    const profile = await runtime.service.upsertByo(authorizedOwnerOperation(res), {
      providerId: routeParameter(req.params.providerId) as 'google-workspace' | 'canva',
      clientId: req.body?.clientId,
      clientSecret: req.body?.clientSecret,
    });
    res.json({ profile });
  }));
  routes.post('/:providerId/dcr', operation('register_dcr', async (runtime, req, res) => {
    const effect = exactProfileEffect(req, 'dcr_pkce');
    assertConnectorProviderEffectEnabled({ operation: ConnectorPolicyOperation.ProfileConfigure,
      ...effect });
    res.status(201).json({
      profile: await runtime.service.registerDcr(
        authorizedOwnerOperation(res), routeParameter(req.params.providerId),
      ),
    });
  }));
  routes.put('/:providerId/api-key', operation('upsert_shared_api_key', async (runtime, req, res) => {
    const effect = exactProfileEffect(req, 'api_key');
    // B-848 (mirrors B-845 / ADR-138 §ج decision 1): CredentialVerify is a
    // read-only gate that denies with profile_unready until a ready api_key
    // profile row exists, but the only creator lives inside
    // upsertInstallationApiKey — after the gate — so the first shared-key save on
    // a clean install always 500s. Run ProfileConfigure parity first (it
    // short-circuits profileReady), materialise the ready profile, then assert
    // CredentialVerify. The gate stays write-free.
    assertConnectorProviderEffectEnabled({ operation: ConnectorPolicyOperation.ProfileConfigure,
      ...effect });
    runtime.service.ensureApiKeyProfile(effect.providerId);
    assertConnectorProviderEffectEnabled({ operation: ConnectorPolicyOperation.CredentialVerify,
      ...effect });
    const profile = await runtime.service.upsertInstallationApiKey(authorizedOwnerOperation(res), {
      providerId: routeParameter(req.params.providerId),
      apiKey: req.body?.apiKey,
      ownership: req.body?.ownership,
    });
    res.json({ profile });
  }));
  routes.delete('/:providerId', operation('disable', async (runtime, req, res) => {
    res.json({
      profile: await runtime.service.disable(
        authorizedOwnerOperation(res), routeParameter(req.params.providerId),
      ),
    });
  }));
  return routes;
};

export default createConnectorAuthProfileRoutes();

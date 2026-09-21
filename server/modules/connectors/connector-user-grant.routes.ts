import { existsSync } from 'node:fs';

import express from 'express';

// eslint-disable-next-line boundaries/dependencies -- grant production composition owns its DB boot.
import { getConnection, getDatabasePath } from '@/modules/database/connection.js';
// eslint-disable-next-line boundaries/dependencies -- additive grant migration must complete at composition.
import { migrateConnectorAuthSchema } from '@/modules/database/connector-auth.migration.js';
// eslint-disable-next-line boundaries/dependencies -- raw grant persistence stays behind this adapter.
import { createConnectorAuthDb } from '@/modules/database/repositories/connector-auth.db.js';
import { connectorsDb } from '@/modules/database/index.js';

// eslint-disable-next-line boundaries/no-unknown -- shared HTTP protection used by connector writes.
import { createRateLimiter } from '../../middleware/rate-limit.js';
import { providerAuthSpecFor } from '../../../shared/connector-auth-registry.js';

import {
  CONNECTOR_GRANTS_V2_FLAG,
  ConnectorUserGrantError,
  createConnectorUserGrantService,
} from './connector-user-grant.service.js';
import { probeConnectorApiKeyCandidate } from './connector-api-key-probe.js';
import { createConnectorProfileManagementService } from './connector-auth-profile-management.js';
import {
  FileConnectorAuthKeyring,
  createConnectorAuthKeyringFile,
} from './connector-auth-vault.crypto.js';
import { assertConnectorProviderEffectEnabled, executeConnectorPolicyV2SynchronousWrite,
  resolveConnectorRuntimeInstallationOrigin } from './connector-substrate-only.production.js';
import { ConnectorPolicyOperation } from './connector-policy-v2.js';
import {
  authorizedOwnerOperation,
  consumeAuthorizedOwnerOperation,
  createConnectorOwnerOperationGate,
  type ConnectorOwnerOperation,
} from './connector-owner-operation-gate.js';
import { isClaudeSubscriptionToken } from '../../../shared/claudeSubscriptionToken.js';

type Runtime = Readonly<{
  installationId: string;
  canonicalOrigin: string;
  repository: ReturnType<typeof createConnectorAuthDb>;
  grants: ReturnType<typeof createConnectorUserGrantService>;
  profiles: ReturnType<typeof createConnectorProfileManagementService>;
  getConnector?: typeof connectorsDb.get;
  // T-1540: the provider-effect gate is a security assertion, not an optional
  // hook. Production always binds it (see buildRuntime), so it is required here;
  // a runtime that reaches a write path without it is a wiring bug, not a
  // silently skippable check.
  assertProviderEffect: typeof assertConnectorProviderEffectEnabled;
}>;

const enabled = (): boolean => process.env[CONNECTOR_GRANTS_V2_FLAG] === '1';
let productionRuntime: Runtime | null = null;

const buildRuntime = (): Runtime => {
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
  const testApiKeyCandidate = probeConnectorApiKeyCandidate;
  const grants = createConnectorUserGrantService({
    installationId, repository, keyring, env: process.env, testApiKeyCandidate,
  });
  const profiles = createConnectorProfileManagementService({
    installation: { installationId, canonicalOrigin, callbackUrl: resolvedOrigin.callbackUrl },
    repository, keyring, env: process.env,
    testByoCandidate: async () => { throw new Error('connector_profile_candidate_probe_unavailable'); },
    testApiKeyCandidate: async candidate => { await testApiKeyCandidate(candidate); },
  });
  productionRuntime = Object.freeze({
    installationId, canonicalOrigin, repository, grants, profiles,
    getConnector: connectorsDb.get.bind(connectorsDb),
    assertProviderEffect: assertConnectorProviderEffectEnabled,
  });
  return productionRuntime;
};

const caller = (req: express.Request) => {
  const user = (req as express.Request & { user?: { id?: number; userId?: number; role?: string } }).user;
  const id = user?.id ?? user?.userId;
  return Number.isSafeInteger(id) && Number(id) > 0 ? { id: Number(id), role: user?.role } : null;
};

const fail = (res: express.Response, error: unknown): void => {
  const code = error instanceof ConnectorUserGrantError ? error.message
    : error instanceof Error && error.message.startsWith('connector_profile_') ? error.message
      : 'connector_grant_operation_failed';
  const status = code.includes('not_found') ? 404
    : code.includes('disabled') ? 404
      : code.includes('unsupported') || code.includes('invalid') || code.includes('required') ? 400
        : code.includes('candidate') ? 422
          : code.includes('verification') ? 403
            : code.includes('progress') || code.includes('stale') ? 409 : 500;
  res.status(status).json({ error: 'Connector grant request failed.', code });
};

/**
 * B-1252: a connector key is the one credential this server SENDS to a third
 * party (the verify probe puts it in a request header), so a personal Claude
 * subscription token pasted here by mistake must be refused before any effect.
 * Answers 400 and returns true when the request carried one.
 */
const refusedSubscriptionToken = (req: express.Request, res: express.Response): boolean => {
  const fields = req.body?.credentialFields;
  const candidates = [req.body?.apiKey,
    ...(fields && typeof fields === 'object' ? Object.values(fields as Record<string, unknown>) : [])];
  if (!candidates.some(isClaudeSubscriptionToken)) return false;
  res.status(400).json({ error: 'Connector grant request failed.', code: 'subscription_token_forbidden_target' });
  return true;
};

const writeLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 10,
  message: 'Too many connector grant changes. Try again shortly.',
  code: 'CONNECTOR_GRANT_RATE_LIMITED',
});

export const createConnectorUserGrantRoutes = (
  runtimeFactory: () => Runtime = buildRuntime,
): express.Router => {
  const routes = express.Router();
  const eagerRuntime = enabled() ? runtimeFactory() : null;
  let deletionRuntime: Runtime | null = eagerRuntime;

  const runtimeFor = (res: express.Response, allowDisabled = false): Runtime | null => {
    if (!enabled() && !allowDisabled) {
      res.status(404).json({ error: 'Not found.', code: 'CONNECTOR_GRANTS_DISABLED' });
      return null;
    }
    if (allowDisabled && !deletionRuntime) {
      try { deletionRuntime = runtimeFactory(); } catch { deletionRuntime = null; }
    }
    const runtime = allowDisabled ? deletionRuntime : eagerRuntime;
    if (!runtime) {
      res.status(503).json({ error: 'Connector grants are unavailable.', code: 'CONNECTOR_GRANTS_UNAVAILABLE' });
      return null;
    }
    return runtime;
  };

  const write = (
    operation: ConnectorOwnerOperation,
    ownerOnly: boolean,
    action: (runtime: Runtime, req: express.Request, res: express.Response, userId: number) => Promise<void>,
    allowDisabled = false,
  ): express.RequestHandler => (req, res) => {
    const runtime = runtimeFor(res, allowDisabled);
    const user = caller(req);
    if (!runtime || !user) {
      if (runtime) res.status(401).json({ error: 'Authentication required.', code: 'AUTH_REQUIRED' });
      return;
    }
    writeLimiter(req, res, () => createConnectorOwnerOperationGate({
      repository: runtime.repository, installationId: runtime.installationId,
      canonicalOrigin: runtime.canonicalOrigin, operation, ownerOnly,
    })(req, res, () => {
      void action(runtime, req, res, user.id).catch(error => fail(res, error));
    }));
  };

  routes.get('/', (req, res) => {
    const runtime = runtimeFor(res);
    const user = caller(req);
    if (!runtime || !user) {
      if (runtime) res.status(401).json({ error: 'Authentication required.', code: 'AUTH_REQUIRED' });
      return;
    }
    const service = typeof req.query.service === 'string' ? req.query.service : undefined;
    try {
      res.json({ grants: runtime.grants.list(user.id, service) });
    } catch (error) {
      fail(res, error);
    }
  });

  const personalApiKey = write(
    'upsert_personal_api_key', false, async (runtime, req, res, userId) => {
      consumeAuthorizedOwnerOperation(authorizedOwnerOperation(res), 'upsert_personal_api_key', {
        repository: runtime.repository, installationId: runtime.installationId,
      });
      const serviceId = Array.isArray(req.params.serviceId) ? '' : req.params.serviceId;
      const connectorId = typeof req.body?.connectorId === 'string' ? req.body.connectorId : '';
      const connector = connectorId
        ? (runtime.getConnector ?? connectorsDb.get.bind(connectorsDb))(connectorId)
        : null;
      if (!connector || connector.ownerUserId !== userId || connector.service !== serviceId
        || connector.authMode !== 'key' || connector.credentialMode !== 'per_member') {
        throw new ConnectorUserGrantError('connector_grant_connector_selection_invalid');
      }
      const spec = providerAuthSpecFor(serviceId);
      if (!spec || spec.method !== 'api_key') {
        throw new ConnectorUserGrantError('connector_grant_connector_selection_invalid');
      }
      const connectorLabel = connector.accountLabel.normalize('NFKC').trim().replace(/\s+/gu, ' ');
      const requestedLabel = typeof req.body?.accountLabel === 'string'
        ? req.body.accountLabel.normalize('NFKC').trim().replace(/\s+/gu, ' ')
        : connectorLabel;
      if (!connectorLabel || requestedLabel !== connectorLabel) {
        throw new ConnectorUserGrantError('connector_grant_connector_selection_invalid');
      }
      // B-845: run ProfileConfigure parity first. `profileReady` short-circuits
      // to true for ProfileConfigure, so this validates foundation/pack/kills
      // without a profile row, then we materialise the ready api_key profile so
      // the read-only CredentialVerify gate no longer denies with profile_unready
      // on a clean install (ADR-138 §ج/decision 1). The gate stays write-free.
      runtime.assertProviderEffect({ operation: ConnectorPolicyOperation.ProfileConfigure,
        providerId: spec.profileId, serviceId, userId });
      runtime.grants.ensureApiKeyProfile(serviceId);
      runtime.assertProviderEffect({ operation: ConnectorPolicyOperation.CredentialVerify,
        providerId: spec.profileId, serviceId, userId });
      if (refusedSubscriptionToken(req, res)) return;
      const grant = await runtime.grants.putPersonalApiKey(userId, {
        serviceId,
        apiKey: req.body?.apiKey,
        credentialFields: req.body?.credentialFields,
        acceptStoredUnverified: req.body?.acceptStoredUnverified,
        accountLabel: connectorLabel,
        providerSubject: req.body?.providerSubject,
        isDefault: req.body?.isDefault,
      });
      if (!executeConnectorPolicyV2SynchronousWrite(() => runtime.repository.bindApiKeyConnectorGrant({
        connectorId, installationId: runtime.installationId, userId, serviceId,
        grantId: grant.grantId,
      }))) throw new ConnectorUserGrantError('connector_grant_binding_failed');
      res.json({ grant, connectorId });
    },
  );

  const sharedApiKey = write(
    'upsert_shared_api_key', true, async (runtime, req, res, userId) => {
      const serviceId = Array.isArray(req.params.serviceId) ? '' : req.params.serviceId;
      const spec = providerAuthSpecFor(serviceId);
      if (!spec || spec.method !== 'api_key') {
        throw new ConnectorUserGrantError('connector_grant_connector_selection_invalid');
      }
      runtime.assertProviderEffect({ operation: ConnectorPolicyOperation.CredentialVerify,
        providerId: spec.profileId, serviceId, userId });
      if (refusedSubscriptionToken(req, res)) return;
      const profile = await runtime.profiles.upsertInstallationApiKey(authorizedOwnerOperation(res), {
        providerId: spec.profileId,
        apiKey: req.body?.apiKey,
        ownership: 'installation_shared',
      });
      res.json({ profile });
    },
  );

  routes.put('/:serviceId/api-key', (req, res, next) => {
    const ownership = req.body?.ownership ?? 'personal';
    if (ownership === 'personal') return personalApiKey(req, res, next);
    if (ownership === 'installation_shared') {
      if (caller(req)?.role !== 'owner') {
        res.status(400).json({ error: 'Connector grant request failed.',
          code: 'connector_grant_ownership_invalid' });
        return;
      }
      return sharedApiKey(req, res, next);
    }
    res.status(400).json({
      error: 'Connector grant request failed.', code: 'connector_grant_ownership_invalid',
    });
  });

  routes.post('/:grantId/reverify', write(
    'upsert_personal_api_key', false, async (runtime, req, res, userId) => {
      consumeAuthorizedOwnerOperation(authorizedOwnerOperation(res), 'upsert_personal_api_key', {
        repository: runtime.repository, installationId: runtime.installationId,
      });
      const grantId = Array.isArray(req.params.grantId) ? '' : req.params.grantId;
      const grant = await runtime.grants.reverifyStoredApiKey(userId, grantId);
      res.json({ grant });
    },
  ));

  routes.delete('/:grantId', write(
    'revoke_personal_grant', false, async (runtime, req, res, userId) => {
      consumeAuthorizedOwnerOperation(authorizedOwnerOperation(res), 'revoke_personal_grant', {
        repository: runtime.repository, installationId: runtime.installationId,
      });
      runtime.grants.revoke(userId, Array.isArray(req.params.grantId) ? '' : req.params.grantId);
      res.status(202).json({ status: 'revoked', remoteRevocation: 'deferred' });
    }, true,
  ));
  return routes;
};

export default createConnectorUserGrantRoutes();

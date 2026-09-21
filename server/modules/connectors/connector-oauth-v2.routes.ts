import { existsSync } from 'node:fs';

import express from 'express';

// eslint-disable-next-line boundaries/dependencies -- OAuth composition owns its DB boot.
import { getConnection, getDatabasePath } from '@/modules/database/connection.js';
// eslint-disable-next-line boundaries/dependencies -- additive OAuth migration completes at composition.
import { migrateConnectorAuthSchema } from '@/modules/database/connector-auth.migration.js';
// eslint-disable-next-line boundaries/dependencies -- raw OAuth persistence stays behind this adapter.
import { createConnectorAuthDb } from '@/modules/database/repositories/connector-auth.db.js';
import { connectorsDb } from '@/modules/database/index.js';

import { providerAuthSpecFor } from '../../../shared/connector-auth-registry.js';
// eslint-disable-next-line boundaries/no-unknown -- shared HTTP protection used by connector writes.
import { createRateLimiter } from '../../middleware/rate-limit.js';

import {
  FileConnectorAuthKeyring,
  createConnectorAuthKeyringFile,
} from './connector-auth-vault.crypto.js';
import { createCertifiedConnectorOidcVerifier } from './connector-certified-oidc.js';
import { safeFetchProviderJson } from './connector-auth-safe-fetch.js';
import { assertConnectorProviderEffectEnabled,
  resolveConnectorRuntimeInstallationOrigin } from './connector-substrate-only.production.js';
import { ConnectorPolicyOperation } from './connector-policy-v2.js';
import {
  CONNECTOR_OAUTH_V2_FLAG,
  ConnectorOAuthEngineError,
  createConnectorOAuthEngine,
} from './connector-oauth-engine.js';
import {
  authorizedOwnerOperation,
  consumeAuthorizedOwnerOperation,
  createConnectorOwnerOperationGate,
  type ConnectorOwnerOperation,
} from './connector-owner-operation-gate.js';

type Runtime = Readonly<{
  installationId: string;
  canonicalOrigin: string;
  repository: ReturnType<typeof createConnectorAuthDb>;
  engine: ReturnType<typeof createConnectorOAuthEngine>;
  fanout: (result: Readonly<{
    userId: number; serviceId: string; grantId: string; connectorId?: string;
  }>) => Promise<boolean>;
}>;

let productionRuntime: Runtime | null = null;

const enabled = (): boolean => process.env[CONNECTOR_OAUTH_V2_FLAG] === '1';

const buildRuntime = (): Runtime => {
  if (productionRuntime) return productionRuntime;
  const database = getConnection();
  migrateConnectorAuthSchema(database);
  const repository = createConnectorAuthDb(database);
  const installationId = repository.getOrCreateInstallation();
  const resolvedOrigin = resolveConnectorRuntimeInstallationOrigin();
  if (!resolvedOrigin || resolvedOrigin.installationId !== installationId) {
    throw new ConnectorOAuthEngineError('connector_installation_origin_unavailable');
  }
  const canonicalOrigin = resolvedOrigin.canonicalOrigin;
  const keyringPath = `${getDatabasePath()}.connector-auth-keyring.json`;
  const keyring = existsSync(keyringPath)
    ? new FileConnectorAuthKeyring(keyringPath)
    : createConnectorAuthKeyringFile(keyringPath);
  const engine = createConnectorOAuthEngine({
    installationId,
    callbackUrl: resolvedOrigin.callbackUrl,
    repository,
    keyring,
    env: process.env,
    verifyIdentity: async ({ spec, idToken, clientId, nonce }) => {
      if (spec.method !== 'byo_app' || spec.identity.method !== 'oidc') {
        throw new ConnectorOAuthEngineError('connector_oauth_identity_contract_unavailable');
      }
      const claims = await createCertifiedConnectorOidcVerifier({ spec, clientId })
        .verifyIdToken(idToken, nonce);
      if (typeof claims.sub !== 'string' || claims.sub.length === 0 || claims.sub.length > 512) {
        throw new ConnectorOAuthEngineError('connector_oauth_subject_missing');
      }
      return { subject: claims.sub };
    },
    revokeRemote: async ({ spec, token, clientId, clientSecret }) => {
      if (spec.method !== 'byo_app' || !spec.endpoints.revocation) return;
      const body = Buffer.from(new URLSearchParams({ token }).toString());
      const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
      if (spec.profileId === 'canva' && clientSecret) {
        headers.authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
      }
      try {
        await safeFetchProviderJson({
          spec, endpoint: 'revocation', method: 'POST', headers, body, responseMode: 'discard',
        });
      } finally { body.fill(0); }
    },
    assertCallbackEffect: effect => assertConnectorProviderEffectEnabled({
      operation: ConnectorPolicyOperation.OauthStart, ...effect,
    }),
  });
  const fanout: Runtime['fanout'] = async result => {
    const matching = connectorsDb.listEnabledForUser(result.userId).filter(connector =>
      connector.authMode === 'oauth' && connector.credentialMode === 'per_member'
      && connector.ownerUserId === result.userId && connector.service === result.serviceId,
    ).filter(connector => result.connectorId === undefined || connector.id === result.connectorId);
    // Never bind "latest" when account selection is ambiguous.
    if (matching.length !== 1) return false;
    if (!repository.bindOAuthConnectorGrant({
      connectorId: matching[0]!.id, installationId, userId: result.userId,
      serviceId: result.serviceId, grantId: result.grantId,
    })) return false;
    const { reconcileConnectorPlacements } = await import('./connector-placement-composition.js');
    const placement = await reconcileConnectorPlacements(matching[0]!.id, result.userId, process.env);
    return placement.state === 'verified';
  };
  productionRuntime = Object.freeze({ installationId, canonicalOrigin, repository, engine, fanout });
  return productionRuntime;
};

const callerId = (req: express.Request): number | null => {
  const user = (req as express.Request & { user?: { id?: number; userId?: number } }).user;
  const id = user?.id ?? user?.userId;
  return Number.isSafeInteger(id) && Number(id) > 0 ? Number(id) : null;
};

const routeService = (value: string | string[]): string => Array.isArray(value) ? '' : value;

const fail = (res: express.Response, error: unknown): void => {
  const code = error instanceof ConnectorOAuthEngineError ? error.message : 'connector_oauth_operation_failed';
  const status = code.includes('disabled') || code.includes('unsupported') ? 404
    : code.includes('missing') ? 422
      : code.includes('busy') || code.includes('stale') || code.includes('swap') ? 409
        : code.includes('invalid') || code.includes('unknown') || code.includes('corrupt') ? 400 : 500;
  res.status(status).json({ error: 'Connector account operation failed.', code });
};

const limiter = createRateLimiter({
  windowMs: 60_000,
  max: 10,
  message: 'Too many connector account requests. Try again shortly.',
  code: 'CONNECTOR_OAUTH_RATE_LIMITED',
});

export const createConnectorOAuthV2Routes = (
  runtimeFactory: () => Runtime = buildRuntime,
): express.Router => {
  const routes = express.Router();
  const eagerRuntime = enabled() ? runtimeFactory() : null;

  const write = (
    operation: ConnectorOwnerOperation,
    action: (runtime: Runtime, req: express.Request, res: express.Response, userId: number) => Promise<void>,
  ): express.RequestHandler => (req, res) => {
    if (!enabled()) {
      res.status(404).json({ error: 'Not found.', code: 'CONNECTOR_OAUTH_DISABLED' });
      return;
    }
    const userId = callerId(req);
    if (!eagerRuntime || userId === null) {
      res.status(eagerRuntime ? 401 : 503).json({
        error: eagerRuntime ? 'Authentication required.' : 'Connector authentication is unavailable.',
        code: eagerRuntime ? 'AUTH_REQUIRED' : 'CONNECTOR_OAUTH_UNAVAILABLE',
      });
      return;
    }
    limiter(req, res, () => createConnectorOwnerOperationGate({
      repository: eagerRuntime.repository,
      installationId: eagerRuntime.installationId,
      canonicalOrigin: eagerRuntime.canonicalOrigin,
      operation,
      ownerOnly: false,
    })(req, res, () => {
      void action(eagerRuntime, req, res, userId).catch(error => fail(res, error));
    }));
  };

  routes.post('/:serviceId/start', write('oauth_start', async (runtime, req, res, userId) => {
    const serviceId = routeService(req.params.serviceId);
    const spec = providerAuthSpecFor(serviceId);
    if (!spec) throw new ConnectorOAuthEngineError('connector_oauth_provider_not_supported');
    assertConnectorProviderEffectEnabled({ operation: ConnectorPolicyOperation.OauthStart,
      providerId: spec.profileId, serviceId, userId });
    const authority = authorizedOwnerOperation(res);
    consumeAuthorizedOwnerOperation(authority, 'oauth_start', {
      repository: runtime.repository, installationId: runtime.installationId,
    });
    const connectorId = typeof req.body?.connectorId === 'string' ? req.body.connectorId : '';
    const connector = connectorId ? connectorsDb.get(connectorId) : null;
    if (!connector || connector.ownerUserId !== userId || connector.service !== serviceId
      || connector.authMode !== 'oauth' || connector.credentialMode !== 'per_member') {
      throw new ConnectorOAuthEngineError('connector_oauth_connector_selection_invalid');
    }
    const binding = runtime.repository.readOAuthConnectorGrantBinding(
      connectorId, runtime.installationId, userId, serviceId,
    );
    res.json(await runtime.engine.start({
      userId,
      sessionId: authority.sessionId,
      serviceId,
      connectorId,
      accountLabel: connector.accountLabel || `Account ${connectorId.slice(-16)}`,
      ...(binding ? { grantId: binding.grantId } : {}),
    }));
  }));

  routes.post('/:serviceId/refresh', write('oauth_refresh', async (runtime, req, res, userId) => {
    consumeAuthorizedOwnerOperation(authorizedOwnerOperation(res), 'oauth_refresh', {
      repository: runtime.repository, installationId: runtime.installationId,
    });
    const serviceId = routeService(req.params.serviceId);
    const connectorId = typeof req.body?.connectorId === 'string' ? req.body.connectorId : '';
    const binding = connectorId ? runtime.repository.readOAuthConnectorGrantBinding(
      connectorId, runtime.installationId, userId, serviceId,
    ) : null;
    if (!binding) throw new ConnectorOAuthEngineError('connector_oauth_connector_selection_invalid');
    const spec = providerAuthSpecFor(serviceId);
    if (!spec) throw new ConnectorOAuthEngineError('connector_oauth_provider_not_supported');
    assertConnectorProviderEffectEnabled({ operation: ConnectorPolicyOperation.TokenRefresh,
      providerId: spec.profileId, serviceId, userId, grantId: binding.grantId });
    res.json(await runtime.engine.refresh(userId, serviceId, binding.grantId));
  }));

  routes.delete('/:serviceId', write('oauth_revoke', async (runtime, req, res, userId) => {
    consumeAuthorizedOwnerOperation(authorizedOwnerOperation(res), 'oauth_revoke', {
      repository: runtime.repository, installationId: runtime.installationId,
    });
    const serviceId = routeService(req.params.serviceId);
    const connectorId = typeof req.body?.connectorId === 'string' ? req.body.connectorId : '';
    const binding = connectorId ? runtime.repository.readOAuthConnectorGrantBinding(
      connectorId, runtime.installationId, userId, serviceId,
    ) : null;
    if (!binding) throw new ConnectorOAuthEngineError('connector_oauth_connector_selection_invalid');
    res.json(await runtime.engine.revoke(userId, serviceId, binding.grantId));
  }));
  return routes;
};

export const createConnectorOAuthV2Callback = (
  runtimeFactory: () => Runtime = buildRuntime,
): express.RequestHandler => {
  const eagerRuntime = enabled() ? runtimeFactory() : null;
  return (req, res, next) => {
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    if (!state.startsWith('v2.')) {
      next();
      return;
    }
    if (!enabled() || !eagerRuntime) {
      const canonicalOrigin = resolveConnectorRuntimeInstallationOrigin()?.canonicalOrigin;
      if (!canonicalOrigin) {
        res.status(503).end();
        return;
      }
      res.redirect(303, `${canonicalOrigin}/?settings=connectors&connectorOAuth=unavailable`);
      return;
    }
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    if (typeof req.query.error === 'string' || !code) {
      res.redirect(303, `${eagerRuntime.canonicalOrigin}/?settings=connectors&connectorOAuth=failed`);
      return;
    }
    void eagerRuntime.engine.callback({ state, code })
      .then(async result => {
        const linked = await eagerRuntime.fanout(result);
        res.redirect(303, `${eagerRuntime.canonicalOrigin}/?settings=connectors&connectorOAuth=${
          linked ? 'linked' : 'distributionFailed'
        }`);
      })
      .catch(() => res.redirect(
        303, `${eagerRuntime.canonicalOrigin}/?settings=connectors&connectorOAuth=failed`,
      ));
  };
};

/** Internal exact-account refresh used by V2 MCP consumers before token expiry. */
export const refreshProductionConnectorOAuthGrant = async (input: Readonly<{
  connectorId: string; userId: number; serviceId: string; grantId: string;
}>): Promise<void> => {
  if (!enabled()) throw new ConnectorOAuthEngineError('connector_oauth_disabled');
  const current = buildRuntime();
  const binding = current.repository.readOAuthConnectorGrantBinding(
    input.connectorId, current.installationId, input.userId, input.serviceId,
  );
  if (!binding || binding.grantId !== input.grantId) {
    throw new ConnectorOAuthEngineError('connector_oauth_binding_mismatch');
  }
  const spec = providerAuthSpecFor(input.serviceId);
  if (!spec) throw new ConnectorOAuthEngineError('connector_oauth_provider_not_supported');
  assertConnectorProviderEffectEnabled({ operation: ConnectorPolicyOperation.TokenRefresh,
    providerId: spec.profileId, serviceId: input.serviceId, userId: input.userId,
    grantId: input.grantId });
  await current.engine.refresh(input.userId, input.serviceId, input.grantId);
};

export default createConnectorOAuthV2Routes();

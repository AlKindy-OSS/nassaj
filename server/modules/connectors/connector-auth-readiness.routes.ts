import express from 'express';

import {
  PROVIDER_AUTH_SPECS,
  isProviderAuthRegistryEnabled,
  providerAuthReadiness,
  type ProviderAuthSpec,
} from '../../../shared/connector-auth-registry.js';

import type { ManagedConnectorProfile } from './connector-auth-profile-management.js';
import { connectorAuthServiceCapability } from './connector-auth-public-capabilities.js';
import { connectorAuthProfileRuntime } from './connector-auth-profile.routes.js';
import { CONNECTOR_OAUTH_CALLBACK_PATH } from './connector-auth-security.js';
import { connectorRuntimeLiveOrigin } from './connector-substrate-only.production.js';
import { connectorOwnerSessionOrigin } from './connector-owner-auth-session.js';
import { validatedConnectorCsrfToken } from './connector-owner-operation-gate.js';

type ProfileReader = Readonly<{
  listProfiles(installationId: string): readonly ManagedConnectorProfile[] | Promise<readonly ManagedConnectorProfile[]>;
  readOwnerAuthSession(input: Readonly<{
    sessionTokenHash: string; installationId: string; userId: number; nowMs: number;
  }>): Readonly<{ sessionId: string; csrfTokenHash: string; authTime: number; expiresAt: number }> | null;
}>;

type ReadinessRuntime = Readonly<{
  canonicalOrigin: string;
  /**
   * Origin the recent-auth cookies were issued under (the step-up source: the
   * persisted origin, else the pre-origin environment proposal). The CSRF token
   * is validated against it so the first-time origin wizard receives its token
   * before any origin is persisted. Defaults to canonicalOrigin.
   */
  sessionOrigin?: string | null;
  installationId: string | null;
  repository: ProfileReader | null;
}>;

type ReadinessDependencies = Readonly<{
  runtime: () => ReadinessRuntime;
  env?: Readonly<Record<string, string | undefined>>;
  now?: () => number;
}>;

type AuthedRequest = express.Request & { user?: { id?: number; userId?: number; role?: string } };

const authenticatedUser = (req: express.Request): { userId: number; owner: boolean } | null => {
  const user = (req as AuthedRequest).user;
  const userId = user?.id ?? user?.userId;
  return Number.isSafeInteger(userId) && Number(userId) > 0
    ? { userId: Number(userId), owner: user?.role === 'owner' }
    : null;
};

const profileStatus = (
  profile: ManagedConnectorProfile | null,
): ManagedConnectorProfile['status'] | 'not_configured' => {
  const status = profile?.status;
  return status === 'pending' || status === 'ready' || status === 'disabled' || status === 'error'
    ? status
    : 'not_configured';
};

const readinessDto = (
  spec: ProviderAuthSpec,
  profile: ManagedConnectorProfile | null,
  owner: boolean,
  callbackUrl: string,
  env: Readonly<Record<string, string | undefined>>,
) => {
  const status = profileStatus(profile);
  const readiness = providerAuthReadiness(spec, env, status === 'ready');
  const setup = owner && spec.method === 'byo_app'
    && spec.identity.method !== 'unavailable' && readiness !== 'unsupported'
    ? { callbackUrl, appRegistrationUrl: spec.endpoints.appRegistration }
    : undefined;
  return Object.freeze({
    providerId: spec.profileId,
    services: [...spec.services],
    authMethod: spec.method,
    readiness,
    configured: status === 'ready',
    status,
    serviceCapabilities: spec.services.map(serviceId => {
      const capability = connectorAuthServiceCapability(serviceId, env);
      if (!capability) throw new Error('connector_auth_capability_missing');
      return capability;
    }),
    ...(setup ? { setup } : {}),
  });
};

// The origin is read per request (T-1939 6B): a PUT /origin change applies to
// readiness, CSRF validation and the callback URL without a restart.
const productionRuntime = (): ReadinessRuntime => {
  const runtime = connectorAuthProfileRuntime();
  return {
    canonicalOrigin: connectorRuntimeLiveOrigin() ?? '',
    sessionOrigin: connectorOwnerSessionOrigin(),
    installationId: runtime?.installationId ?? null,
    repository: runtime?.repository ?? null,
  };
};

/** Authenticated, secret-free installation readiness for every member. */
export const createConnectorAuthReadinessRoutes = (
  dependencies: ReadinessDependencies = { runtime: productionRuntime },
): express.Router => {
  const routes = express.Router();
  routes.get('/', (req, res) => {
    res.set('Cache-Control', 'no-store');
    void (async () => {
      const caller = authenticatedUser(req);
      if (!caller) {
        res.status(401).json({ error: 'Authentication required.', code: 'AUTH_REQUIRED' });
        return;
      }
      const runtime = dependencies.runtime();
      const requestOrigin = req.get('origin');
      if (requestOrigin && requestOrigin !== runtime.canonicalOrigin) {
        res.status(403).json({ error: 'Request origin was rejected.', code: 'CONNECTOR_ORIGIN_REJECTED' });
        return;
      }
      const env = dependencies.env ?? process.env;
      const enabled = isProviderAuthRegistryEnabled(env);
      if (enabled && (!runtime.repository || !runtime.installationId)) {
        res.status(503).json({
          error: 'Connector authentication is unavailable.',
          code: 'CONNECTOR_AUTH_BOOTSTRAP_UNAVAILABLE',
        });
        return;
      }
      const stored = enabled
        ? await runtime.repository!.listProfiles(runtime.installationId!)
        : [];
      const csrfToken = runtime.repository && runtime.installationId
        ? validatedConnectorCsrfToken(
          req,
          runtime.repository,
          runtime.installationId,
          caller.userId,
          runtime.sessionOrigin !== undefined ? runtime.sessionOrigin : (runtime.canonicalOrigin || null),
          dependencies.now?.() ?? Date.now(),
        )
        : null;
      const byProvider = new Map(stored.map(profile => [profile.providerId, profile]));
      const callbackUrl = `${runtime.canonicalOrigin}${CONNECTOR_OAUTH_CALLBACK_PATH}`;
      res.json({
        schemaVersion: 1,
        csrfToken,
        recentAuthRequired: csrfToken === null,
        profiles: PROVIDER_AUTH_SPECS.map(spec => readinessDto(
          spec,
          byProvider.get(spec.profileId) ?? null,
          caller.owner,
          callbackUrl,
          env,
        )),
      });
    })().catch(() => {
      if (!res.headersSent) {
        res.status(500).json({
          error: 'Connector readiness is unavailable.',
          code: 'CONNECTOR_AUTH_READINESS_FAILED',
        });
      }
    });
  });
  return routes;
};

export default createConnectorAuthReadinessRoutes();

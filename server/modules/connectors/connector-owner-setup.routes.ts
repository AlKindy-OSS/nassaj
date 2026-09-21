/** HTTP adapter for the owner-only installation setup section. */

import { createHash, timingSafeEqual } from 'node:crypto';

import express from 'express';

import { ConnectorOwnerSetupError, type ConnectorOwnerSetupService } from './connector-owner-setup.service.js';
import { authorizedOwnerOperation } from './connector-owner-operation-gate.js';

type Identity = Readonly<{ userId: number; role: string }>;
type RecentSession = Readonly<{ installationId: string; userId: number; authTimeMs: number;
  expiresAtMs: number; csrfTokenHash: string }>;
type Dependencies = Readonly<{ service: ConnectorOwnerSetupService; installationId: string;
  resolveIdentity: (req: express.Request) => Identity|null;
  readRecentSession: (req: express.Request) => RecentSession|null; now?: () => number;
  profileOperationGate?: express.RequestHandler }>;

const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => Boolean(
  value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value as Record<string, unknown>).sort().join(',') === [...keys].sort().join(','),
);
const safeHashEqual = (token: unknown, digest: string): boolean => {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/u.test(token) || !/^[a-f0-9]{64}$/u.test(digest)) return false;
  return timingSafeEqual(Buffer.from(createHash('sha256').update(token).digest('hex')), Buffer.from(digest));
};
const ifMatch = (req: express.Request): number|null => {
  const match = /^"(0|[1-9][0-9]{0,15})"$/u.exec(req.get('if-match') ?? '');
  const revision = match ? Number(match[1]) : Number.NaN;
  return Number.isSafeInteger(revision) ? revision : null;
};
const idempotencyKey = (req: express.Request): string|null => {
  const key = req.get('idempotency-key');
  return typeof key === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(key) ? key : null;
};
const owner = (deps: Dependencies, req: express.Request, res: express.Response): Identity|null => {
  const identity = deps.resolveIdentity(req);
  if (!identity || identity.role !== 'owner') { res.status(404).json({ code: 'CONNECTOR_SETUP_NOT_FOUND' }); return null; }
  return identity;
};

/** Builds routes without mounting any provider activation or I/O adapter. */
export const createConnectorOwnerSetupRoutes = (deps: Dependencies): express.Router => {
  const router = express.Router();
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.get('/', (req, res) => {
    if (!owner(deps, req, res)) return;
    try { res.json(deps.service.status()); }
    catch { res.status(503).json({ code: 'CONNECTOR_SETUP_UNAVAILABLE' }); }
  });

  const write = (shape: (body: unknown) => boolean,
    expectedFromBody: (body: Record<string, unknown>) => number|null,
    effect: (body: Record<string, unknown>, context: Parameters<ConnectorOwnerSetupService['setOrigin']>[1],
      res: express.Response) => unknown|Promise<unknown>,
  ): express.RequestHandler => async (req, res) => {
    const identity = owner(deps, req, res); if (!identity) return;
    if (!shape(req.body)) { res.status(422).json({ code: 'CONNECTOR_SETUP_BODY_INVALID' }); return; }
    const revision = ifMatch(req); const key = idempotencyKey(req);
    if (revision === null) { res.status(428).json({ code: 'CONNECTOR_SETUP_IF_MATCH_REQUIRED' }); return; }
    if (!key) { res.status(400).json({ code: 'CONNECTOR_SETUP_IDEMPOTENCY_KEY_REQUIRED' }); return; }
    const bodyRevision = expectedFromBody(req.body as Record<string, unknown>);
    if (bodyRevision !== null && revision !== bodyRevision) {
      res.status(412).json({ code: 'CONNECTOR_SETUP_REVISION_MISMATCH' }); return;
    }
    const nowMs = deps.now?.() ?? Date.now(); const session = deps.readRecentSession(req);
    const status = deps.service.status();
    const proposed = typeof (req.body as Record<string, unknown>).canonicalOrigin === 'string'
      ? String((req.body as Record<string, unknown>).canonicalOrigin) : null;
    const expectedOrigin = status.origin?.canonicalOrigin ?? proposed;
    if (!session || session.installationId !== deps.installationId || session.userId !== identity.userId
      || session.authTimeMs > nowMs || nowMs - session.authTimeMs > 300_000 || session.expiresAtMs <= nowMs
      || req.get('origin') !== expectedOrigin || !safeHashEqual(req.get('x-csrf-token'), session.csrfTokenHash)) {
      res.status(403).json({ code: 'CONNECTOR_SETUP_RECENT_AUTH_OR_CSRF_REQUIRED' }); return;
    }
    try {
      res.json(await effect(req.body as Record<string, unknown>, { ownerUserId: identity.userId,
        idempotencyKey: key, expectedRevision: revision, requestOrigin: expectedOrigin!,
        authTimeMs: session.authTimeMs, expiresAtMs: Math.min(session.expiresAtMs, nowMs + 30_000), nowMs }, res));
    } catch (error) {
      if (error instanceof ConnectorOwnerSetupError) { res.status(error.status).json({ code: error.code }); return; }
      res.status(503).json({ code: 'CONNECTOR_SETUP_UNAVAILABLE' });
    }
  };

  router.put('/origin', write(
    body => exact(body, ['canonicalOrigin', 'expectedOriginRevision'])
      && typeof body.canonicalOrigin === 'string' && Number.isSafeInteger(body.expectedOriginRevision),
    body => Number(body.expectedOriginRevision), (body, context) => deps.service.setOrigin(body as never, context),
  ));
  router.post('/trust/import', write(
    body => exact(body, ['bundle', 'expectedTrustBundleRevision']) && Number.isSafeInteger(body.expectedTrustBundleRevision),
    body => Number(body.expectedTrustBundleRevision), (body, context) => deps.service.importTrust(body as never, context),
  ));
  router.post('/packs/import', write(
    body => exact(body, ['envelope']), _body => null,
    (body, context) => deps.service.importPack(body as never, context),
  ));
  router.put('/activations', write(
    body => exact(body, ['expectedRecordRevision', 'globalPackDigest', 'changes'])
      && Number.isSafeInteger(body.expectedRecordRevision) && typeof body.globalPackDigest === 'string'
      && Array.isArray(body.changes),
    body => Number(body.expectedRecordRevision), (body, context) => deps.service.setActivations(body as never, context),
  ));
  router.post('/profiles/:providerId/verify', (req, res, next) => {
    if (req.body?.method === 'api_key') {
      res.status(422).json({ code: 'CONNECTOR_PROFILE_NOT_REQUIRED' }); return;
    }
    if (!deps.profileOperationGate) { res.status(503).json({ code: 'CONNECTOR_PROFILE_SETUP_UNAVAILABLE' }); return; }
    deps.profileOperationGate(req, res, next);
  }, write(
    body => exact(body, ['method']) && body.method === 'dcr_pkce'
      || exact(body, ['method', 'clientId', 'clientSecret']) && body.method === 'byo_app'
        && typeof body.clientId === 'string' && typeof body.clientSecret === 'string',
    _body => null, async (body, context, res) => {
      if (body.method === 'api_key') throw new ConnectorOwnerSetupError('CONNECTOR_PROFILE_NOT_REQUIRED', 422);
      const providerId = String(res.req.params.providerId ?? '');
      if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(providerId)) {
        throw new ConnectorOwnerSetupError('CONNECTOR_PROFILE_PROVIDER_INVALID', 422);
      }
      return deps.service.verifyProfile(providerId, body as never, context, authorizedOwnerOperation(res));
    },
  ));
  return router;
};

/** Owner-authenticated transport for new-installation connector provisioning. */

import { createHash, timingSafeEqual } from 'node:crypto';

import express from 'express';

import type { ConnectorInstallationOriginResolver } from './connector-installation-origin-resolver.js';
import { ConnectorProvisioningService } from './connector-provisioning.service.js';

type Dependencies = Readonly<{ service: ConnectorProvisioningService; installationId: string;
  origins: ConnectorInstallationOriginResolver; resolveIdentity: (req: express.Request) => { userId: number; role: string }|null;
  readRecentSession: (req: express.Request) => { installationId: string; userId: number; authTimeMs: number;
    expiresAtMs: number; csrfTokenHash: string }|null; now?: () => number }>;

const secureEqual = (value: unknown, digest: string): boolean => {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value) || !/^[a-f0-9]{64}$/u.test(digest)) return false;
  return timingSafeEqual(Buffer.from(createHash('sha256').update(value).digest('hex')), Buffer.from(digest));
};
const idempotencyKey = (req: express.Request): string|null => {
  const value = req.get('idempotency-key');
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(value) ? value : null;
};
const current = (req: express.Request, res: express.Response): boolean => {
  const check = (req as express.Request & { assertCurrentIdentity?: () => boolean }).assertCurrentIdentity;
  if (check?.() !== false) return true;
  res.status(409).json({ code: 'IDENTITY_CHANGED' });
  return false;
};

/** The endpoint accepts no origin, pack, proof, or registration material from the browser. */
export const createConnectorProvisioningRoutes = (deps: Dependencies): express.Router => {
  const router = express.Router();
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.post('/', async (req, res) => {
    const identity = deps.resolveIdentity(req); const key = idempotencyKey(req); const body = req.body as unknown;
    if (!identity || identity.role !== 'owner') { res.status(404).json({ code: 'CONNECTOR_PROVISIONING_NOT_FOUND' }); return; }
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body as object).sort().join(',') !== 'providerId'
      || typeof (body as { providerId?: unknown }).providerId !== 'string') {
      res.status(422).json({ code: 'CONNECTOR_PROVISIONING_BODY_INVALID' }); return;
    }
    if (!key) { res.status(400).json({ code: 'CONNECTOR_PROVISIONING_IDEMPOTENCY_KEY_REQUIRED' }); return; }
    const nowMs = deps.now?.() ?? Date.now(); const session = deps.readRecentSession(req);
    const origin = deps.origins.resolve(deps.installationId);
    if (!origin || !session || session.installationId !== deps.installationId || session.userId !== identity.userId
      || session.authTimeMs > nowMs || nowMs - session.authTimeMs > 300_000 || session.expiresAtMs <= nowMs
      || req.get('origin') !== origin.canonicalOrigin || !secureEqual(req.get('x-csrf-token'), session.csrfTokenHash)) {
      res.status(403).json({ code: 'CONNECTOR_PROVISIONING_RECENT_AUTH_OR_CSRF_REQUIRED' }); return;
    }
    try {
      if (!current(req, res)) return;
      res.status(202).json(await deps.service.start((body as { providerId: string }).providerId, key));
    }
    catch (error) {
      const code = error instanceof Error ? error.message : '';
      const excluded = code === 'connector_provisioning_provider_excluded';
      const conflict = code === 'connector_provisioning_existing_installation' || code === 'connector_provisioning_idempotency_conflict';
      res.status(excluded ? 422 : conflict ? 409 : 503).json({
        code: excluded ? 'CONNECTOR_PROVISIONING_PROVIDER_EXCLUDED'
          : code === 'connector_provisioning_existing_installation' ? 'CONNECTOR_PROVISIONING_NEW_INSTALL_REQUIRED'
            : code === 'connector_provisioning_idempotency_conflict' ? 'CONNECTOR_PROVISIONING_IDEMPOTENCY_CONFLICT'
              : 'CONNECTOR_PROVISIONING_UNAVAILABLE',
      });
    }
  });
  router.get('/:provisioningId', (req, res) => {
    const identity = deps.resolveIdentity(req);
    if (!identity || identity.role !== 'owner') { res.status(404).json({ code: 'CONNECTOR_PROVISIONING_NOT_FOUND' }); return; }
    const attempt = deps.service.read(req.params.provisioningId);
    if (!attempt) { res.status(404).json({ code: 'CONNECTOR_PROVISIONING_NOT_FOUND' }); return; }
    res.json(attempt);
  });
  return router;
};

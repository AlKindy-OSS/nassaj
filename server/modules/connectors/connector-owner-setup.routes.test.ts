import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import { createConnectorOwnerOperationGate } from './connector-owner-operation-gate.js';
import { createConnectorOwnerSetupRoutes } from './connector-owner-setup.routes.js';
import type { ConnectorOwnerSetupService } from './connector-owner-setup.service.js';

const NOW = 1_800_000_000_000; const ORIGIN = 'https://nassaj.example'; const CSRF = 'c'.repeat(64);
const status = { schemaVersion: 1 as const, readyForAccountLinking: false,
  resumableStep: 'trust' as const, checks: [], origin: { installationId: 'install-1',
    canonicalOrigin: ORIGIN, callbackUrl: `${ORIGIN}/connectors/oauth/callback`, originRevision: 1 },
  trustBundleRevision: 0, activePack: null, activationRecordRevision: 0 };

const run = async (role: string, request: (base: string) => Promise<Response>) => {
  const calls: unknown[] = [];
  const service = { status: () => status, setOrigin: (...args: unknown[]) => { calls.push(args); return { ok: true }; },
    importTrust: () => ({ ok: true }), importPack: () => ({ ok: true }), setActivations: () => ({ ok: true }) };
  const app = express(); app.use(express.json()); app.use((req, _res, next) => {
    (req as express.Request & { fixtureRole?: string }).fixtureRole = role; next();
  });
  app.use('/api/connectors/v2/owner/setup', createConnectorOwnerSetupRoutes({
    service: service as unknown as ConnectorOwnerSetupService, installationId: 'install-1', now: () => NOW,
    resolveIdentity: req => ({ userId: 7, role: (req as express.Request & { fixtureRole: string }).fixtureRole }),
    readRecentSession: () => ({ installationId: 'install-1', userId: 7, authTimeMs: NOW - 1,
      expiresAtMs: NOW + 30_000, csrfTokenHash: createHash('sha256').update(CSRF).digest('hex') }),
  }));
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve); server.once('error', reject);
  });
  try { return { response: await request(`http://127.0.0.1:${(server.address() as AddressInfo).port}`), calls }; }
  finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
};

test('owner status is hidden as 404 from every non-owner and contains no secret material', async () => {
  for (const role of ['admin', 'user', '']) {
    const { response } = await run(role, base => fetch(`${base}/api/connectors/v2/owner/setup`));
    assert.equal(response.status, 404);
  }
  const { response } = await run('owner', base => fetch(`${base}/api/connectors/v2/owner/setup`));
  assert.equal(response.status, 200); assert.equal((await response.text()).includes('secret'), false);
});

test('writes require exact body, If-Match, idempotency, origin, recent auth, and CSRF', async () => {
  const url = '/api/connectors/v2/owner/setup/origin';
  const request = (headers: Record<string,string>, body: unknown) => run('owner', base => fetch(`${base}${url}`, {
    method: 'PUT', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }));
  assert.equal((await request({}, { canonicalOrigin: ORIGIN, expectedOriginRevision: 1 })).response.status, 428);
  assert.equal((await request({ 'if-match': '"1"' },
    { canonicalOrigin: ORIGIN, expectedOriginRevision: 1 })).response.status, 400);
  const headers = { 'if-match': '"1"', 'idempotency-key': 'request-123', origin: ORIGIN,
    'x-csrf-token': CSRF };
  assert.equal((await request(headers, { canonicalOrigin: ORIGIN,
    expectedOriginRevision: 1, extra: true })).response.status, 422);
  const accepted = await request(headers, { canonicalOrigin: ORIGIN, expectedOriginRevision: 1 });
  assert.equal(accepted.response.status, 200); assert.equal(accepted.calls.length, 1);
});

test('profile verify accepts exact DCR/BYO shapes and rejects API-key setup before I/O', async () => {
  const calls: unknown[] = [];
  const profileStatus = { ...status, activationCandidates: [] };
  const service = { status: () => profileStatus,
    verifyProfile: async (...args: unknown[]) => { calls.push(args); return { providerId: 'google-workspace',
      profileState: 'ready', profileRevision: 1, setupRevision: 1 }; } };
  const operationRepository = {
    readOwnerAuthSession: () => ({ sessionId: 'session-1', csrfTokenHash: createHash('sha256')
      .update(CSRF).digest('hex'), authTime: NOW - 1, expiresAt: NOW + 30_000 }),
    issueOwnerOperation: () => ({ sessionId: 'session-1', authTime: NOW - 1, expiresAt: NOW + 30_000 }),
    consumeOwnerOperation: () => true,
  };
  const app = express(); app.use(express.json()); app.use((req, _res, next) => {
    (req as express.Request & { user?: unknown }).user = { id: 7, role: 'owner' }; next();
  });
  app.use('/api/connectors/v2/owner/setup', createConnectorOwnerSetupRoutes({
    service: service as unknown as ConnectorOwnerSetupService, installationId: 'install-1', now: () => NOW,
    resolveIdentity: () => ({ userId: 7, role: 'owner' }),
    readRecentSession: () => ({ installationId: 'install-1', userId: 7, authTimeMs: NOW - 1,
      expiresAtMs: NOW + 30_000, csrfTokenHash: createHash('sha256').update(CSRF).digest('hex') }),
    profileOperationGate: (req, res, next) => createConnectorOwnerOperationGate({
      repository: operationRepository, installationId: 'install-1', canonicalOrigin: ORIGIN,
      operation: req.body?.method === 'dcr_pkce' ? 'register_dcr' : 'upsert_byo', now: () => NOW,
    })(req, res, next),
  }));
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (providerId: string, body: unknown) => fetch(
    `${base}/api/connectors/v2/owner/setup/profiles/${providerId}/verify`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'if-match': '"0"', 'idempotency-key': 'profile-123',
        origin: ORIGIN, 'x-csrf-token': CSRF,
        cookie: `nassaj_connector_recent_auth=${'a'.repeat(64)}` }, body: JSON.stringify(body) });
  try {
    assert.equal((await request('github', { method: 'api_key' })).status, 422);
    assert.equal(calls.length, 0);
    const dcr = await request('notion', { method: 'dcr_pkce' });
    assert.equal(dcr.status, 200); assert.equal(calls.length, 1);
    const malformed = await request('google-workspace', { method: 'byo_app', clientId: 'id' });
    assert.equal(malformed.status, 422); assert.equal(calls.length, 1);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

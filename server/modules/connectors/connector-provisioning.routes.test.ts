import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import { createConnectorProvisioningRoutes } from './connector-provisioning.routes.js';
import type { ConnectorProvisioningService } from './connector-provisioning.service.js';

const NOW = 1_800_000_000_000;
const ORIGIN = 'https://nassaj.example.test';
const CSRF = 'c'.repeat(64);

const run = async (request: (base: string) => Promise<Response>,
  start = async (_providerId: string, _idempotencyKey: string) => ({ provisioningId: 'provisioning-1', state: 'manual_recovery' })) => {
  const starts: Array<[string, string]> = [];
  const service = { start: async (providerId: string, idempotencyKey: string) => {
    starts.push([providerId, idempotencyKey]); return start(providerId, idempotencyKey);
  }, read: () => null };
  const app = express(); app.use(express.json());
  app.use('/provisioning', createConnectorProvisioningRoutes({ service: service as unknown as ConnectorProvisioningService,
    installationId: 'install-1', origins: { resolve: () => ({ canonicalOrigin: ORIGIN, originRevision: 3,
      callbackUrl: `${ORIGIN}/connectors/oauth/callback` }) } as never,
    resolveIdentity: () => ({ userId: 7, role: 'owner' }), now: () => NOW,
    readRecentSession: () => ({ installationId: 'install-1', userId: 7, authTimeMs: NOW - 1,
      expiresAtMs: NOW + 30_000, csrfTokenHash: createHash('sha256').update(CSRF).digest('hex') }),
  }));
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve); server.once('error', reject);
  });
  try { return { response: await request(`http://127.0.0.1:${(server.address() as AddressInfo).port}`), starts }; }
  finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
};

test('provisioning rejects an origin mismatch before it starts any durable attempt', async () => {
  const { response, starts } = await run(base => fetch(`${base}/provisioning`, { method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://attacker.example.test',
      'idempotency-key': 'origin-mismatch-123', 'x-csrf-token': CSRF }, body: JSON.stringify({ providerId: 'notion' }) }));
  assert.equal(response.status, 403); assert.deepEqual(await response.json(), { code: 'CONNECTOR_PROVISIONING_RECENT_AUTH_OR_CSRF_REQUIRED' });
  assert.deepEqual(starts, []);
});

test('provisioning requires exact request shape and a valid idempotency key before service invocation', async () => {
  const request = (headers: Record<string, string>, body: unknown) => run(base => fetch(`${base}/provisioning`, { method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-csrf-token': CSRF, ...headers }, body: JSON.stringify(body) }));
  const malformed = await request({ 'idempotency-key': 'valid-key-123' }, { providerId: 'notion', origin: ORIGIN });
  assert.equal(malformed.response.status, 422); assert.deepEqual(malformed.starts, []);
  const missingKey = await request({}, { providerId: 'notion' });
  assert.equal(missingKey.response.status, 400); assert.deepEqual(missingKey.starts, []);
  const accepted = await request({ 'idempotency-key': 'valid-key-123' }, { providerId: 'notion' });
  assert.equal(accepted.response.status, 202); assert.deepEqual(accepted.starts, [['notion', 'valid-key-123']]);
});

test('provisioning maps existing-installation and cross-provider idempotency conflicts to 409', async () => {
  for (const [error, code] of [
    ['connector_provisioning_existing_installation', 'CONNECTOR_PROVISIONING_NEW_INSTALL_REQUIRED'],
    ['connector_provisioning_idempotency_conflict', 'CONNECTOR_PROVISIONING_IDEMPOTENCY_CONFLICT'],
  ]) {
    const { response, starts } = await run(base => fetch(`${base}/provisioning`, { method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-csrf-token': CSRF, 'idempotency-key': 'conflict-key-123' },
      body: JSON.stringify({ providerId: 'linear' }) }), async () => { throw new Error(error); });
    assert.equal(response.status, 409); assert.deepEqual(await response.json(), { code });
    assert.deepEqual(starts, [['linear', 'conflict-key-123']]);
  }
});

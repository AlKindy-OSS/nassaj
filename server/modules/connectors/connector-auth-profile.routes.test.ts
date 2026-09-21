import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import test from 'node:test';

import Database from 'better-sqlite3';
import express from 'express';

// eslint-disable-next-line boundaries/dependencies -- route integration uses the real additive schema.
import { migrateConnectorAuthSchema } from '../database/connector-auth.migration.js';
// eslint-disable-next-line boundaries/dependencies -- route integration proves the production repository contract.
import { createConnectorAuthDb } from '../database/repositories/connector-auth.db.js';

import { createConnectorProfileManagementService } from './connector-auth-profile-management.js';
import { createConnectorAuthProfileRoutes } from './connector-auth-profile.routes.js';

const token = 'd'.repeat(64);
const csrfToken = 'a'.repeat(64);

const request = async (app: express.Express, headers: Record<string, string> = {}) => {
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    return await fetch(`http://127.0.0.1:${address.port}/auth-profiles`, { headers });
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
};

test('profile HTTP adapter stays unreachable while the global rollout flag is off', async () => {
  const previous = process.env.NASSAJ_CONNECTOR_AUTH_REGISTRY_V1;
  delete process.env.NASSAJ_CONNECTOR_AUTH_REGISTRY_V1;
  let composed = false;
  const app = express();
  app.use('/auth-profiles', createConnectorAuthProfileRoutes(() => {
    composed = true;
    throw new Error('must not compose');
  }));
  try {
    const response = await request(app);
    assert.equal(response.status, 404);
    assert.equal((await response.json() as { code: string }).code, 'CONNECTOR_AUTH_REGISTRY_DISABLED');
    assert.equal(composed, false);
  } finally {
    if (previous === undefined) delete process.env.NASSAJ_CONNECTOR_AUTH_REGISTRY_V1;
    else process.env.NASSAJ_CONNECTOR_AUTH_REGISTRY_V1 = previous;
  }
});

test('enabled runtime boots synchronously and propagates migration failure before handlers', () => {
  const previous = process.env.NASSAJ_CONNECTOR_AUTH_REGISTRY_V1;
  process.env.NASSAJ_CONNECTOR_AUTH_REGISTRY_V1 = '1';
  try {
    let calls = 0;
    assert.throws(() => createConnectorAuthProfileRoutes(() => {
      calls += 1;
      throw new Error('ddl failed');
    }), /ddl failed/);
    assert.equal(calls, 1);
  } finally {
    if (previous === undefined) delete process.env.NASSAJ_CONNECTOR_AUTH_REGISTRY_V1;
    else process.env.NASSAJ_CONNECTOR_AUTH_REGISTRY_V1 = previous;
  }
});

test('profile list needs an owner session but no Origin and performs no nonce write', async () => {
  const previous = process.env.NASSAJ_CONNECTOR_AUTH_REGISTRY_V1;
  process.env.NASSAJ_CONNECTOR_AUTH_REGISTRY_V1 = '1';
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  database.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT); INSERT INTO users VALUES (7, 'owner')");
  migrateConnectorAuthSchema(database);
  const repository = createConnectorAuthDb(database);
  const installationId = repository.getOrCreateInstallation();
  repository.recordOwnerAuthSession({
    sessionId: randomUUID(),
    installationId,
    sessionTokenHash: createHash('sha256').update(token).digest('hex'),
    csrfTokenHash: createHash('sha256').update(csrfToken).digest('hex'),
    userId: 7,
    authMethod: 'password',
    authTimeMs: Date.now(),
    expiresAtMs: Date.now() + 60_000,
  });
  const service = createConnectorProfileManagementService({
    installation: {
      installationId,
      canonicalOrigin: 'https://nassaj.example',
      callbackUrl: 'https://nassaj.example/connectors/oauth/callback',
    },
    repository,
    keyring: { activeKekVersion: () => 1, readKek: () => Buffer.alloc(32, 1) },
    env: { NASSAJ_CONNECTOR_AUTH_REGISTRY_V1: '1' },
    testByoCandidate: async () => undefined,
    testApiKeyCandidate: async () => undefined,
  });
  try {
    const app = express();
    app.use((req, _res, next) => {
      (req as express.Request & { user: unknown }).user = { id: 7, role: 'owner' };
      next();
    });
    let bootCalls = 0;
    const routes = createConnectorAuthProfileRoutes(() => {
      bootCalls += 1;
      return { installationId, canonicalOrigin: 'https://nassaj.example', repository, service };
    });
    assert.equal(bootCalls, 1, 'composition runs before a request is accepted');
    app.use('/auth-profiles', routes);
    const response = await request(app, {
      cookie: `nassaj_connector_recent_auth=${token}`,
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { profiles: unknown[] };
    assert.ok(body.profiles.length > 10);
    const issued = database.prepare(
      'SELECT count(*) AS count FROM connector_owner_operation_nonces',
    ).get() as { count: number };
    assert.equal(issued.count, 0);
  } finally {
    database.close();
    if (previous === undefined) delete process.env.NASSAJ_CONNECTOR_AUTH_REGISTRY_V1;
    else process.env.NASSAJ_CONNECTOR_AUTH_REGISTRY_V1 = previous;
  }
});

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import test from 'node:test';

import Database from 'better-sqlite3';
import express from 'express';

// eslint-disable-next-line boundaries/dependencies -- route integration uses the real additive schema.
import { migrateConnectorAuthSchema } from '../database/connector-auth.migration.js';
// eslint-disable-next-line boundaries/dependencies -- route integration proves user-scoped persistence.
import { createConnectorAuthDb } from '../database/repositories/connector-auth.db.js';
// eslint-disable-next-line boundaries/no-unknown -- test derives the certified api_key spec.
import { providerAuthSpecFor } from '../../../shared/connector-auth-registry.js';

import { createConnectorProfileManagementService } from './connector-auth-profile-management.js';
import { ConnectorPolicyOperation } from './connector-policy-v2.js';
import { createConnectorUserGrantRoutes } from './connector-user-grant.routes.js';
import { createConnectorUserGrantService } from './connector-user-grant.service.js';

const SESSION = '6'.repeat(64);
const CSRF = '7'.repeat(64);
const ORIGIN = 'https://nassaj.example';
const keyring = {
  activeKekVersion: () => 1,
  readKek: () => Buffer.alloc(32, 6),
  activeHmacKeyVersion: () => 1,
  readHmacKey: () => Buffer.alloc(32, 7),
};

const call = async (app: express.Express, body: unknown, service = 'github') => {
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    return await fetch(`http://127.0.0.1:${address.port}/grants/${service}/api-key`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json', origin: ORIGIN,
        cookie: `nassaj_connector_recent_auth=${SESSION}`, 'x-csrf-token': CSRF,
      },
      body: JSON.stringify(body),
    });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
};

const remove = async (app: express.Express, grantId: string) => {
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    return await fetch(`http://127.0.0.1:${address.port}/grants/${grantId}`, {
      method: 'DELETE',
      headers: {
        origin: ORIGIN, cookie: `nassaj_connector_recent_auth=${SESSION}`,
        'x-csrf-token': CSRF,
      },
    });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
};

test('grant routes are flag-closed before production composition', async () => {
  const previous = process.env.NASSAJ_CONNECTOR_GRANTS_V2;
  delete process.env.NASSAJ_CONNECTOR_GRANTS_V2;
  let composed = false;
  const app = express();
  app.use(express.json());
  app.use('/grants', createConnectorUserGrantRoutes(() => {
    composed = true;
    throw new Error('must remain inert');
  }));
  try {
    const response = await call(app, { apiKey: 'never' });
    assert.equal(response.status, 404);
    assert.equal(composed, false);
  } finally {
    if (previous === undefined) delete process.env.NASSAJ_CONNECTOR_GRANTS_V2;
    else process.env.NASSAJ_CONNECTOR_GRANTS_V2 = previous;
  }
});

test('API-key selection is bound to the connector account and a non-owner cannot select installation sharing', async () => {
  const previous = { ...process.env };
  Object.assign(process.env, {
    NASSAJ_CONNECTOR_GRANTS_V2: '1',
    NASSAJ_CONNECTOR_AUTH_REGISTRY_V1: '1',
    NASSAJ_CONNECTOR_AUTH_CERT_GITHUB: '1',
    NASSAJ_CONNECTOR_GRANT_CERT_GITHUB: '1',
  });
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  database.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT); INSERT INTO users VALUES (7, 'member')");
  migrateConnectorAuthSchema(database);
  const repository = createConnectorAuthDb(database);
  const installationId = repository.getOrCreateInstallation();
  repository.recordOwnerAuthSession({
    sessionId: randomUUID(), installationId,
    sessionTokenHash: createHash('sha256').update(SESSION).digest('hex'),
    csrfTokenHash: createHash('sha256').update(CSRF).digest('hex'),
    userId: 7, authMethod: 'password', authTimeMs: Date.now(), expiresAtMs: Date.now() + 60_000,
  });
  const grants = createConnectorUserGrantService({
    installationId, repository, keyring, env: process.env,
    testApiKeyCandidate: async () => ({ providerSubject: 'provider-user-7', identityKind: 'user' }),
  });
  const profiles = createConnectorProfileManagementService({
    installation: { installationId, canonicalOrigin: ORIGIN, callbackUrl: `${ORIGIN}/connectors/oauth/callback` },
    repository, keyring, env: process.env,
    testByoCandidate: async () => undefined, testApiKeyCandidate: async () => undefined,
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { user: unknown }).user = { id: 7, role: 'user' };
    next();
  });
  app.use('/grants', createConnectorUserGrantRoutes(() => ({
    installationId, canonicalOrigin: ORIGIN, repository, grants, profiles,
    // T-1540: the gate is now mandatory. This case exercises selection binding
    // and ownership, not the effect policy, so a permissive gate keeps the focus.
    assertProviderEffect: () => undefined,
    getConnector: (id: string) => ({
      id, service: id.startsWith('salla-') ? 'salla' : 'github', ownerUserId: 7,
      authMode: 'key', credentialMode: 'per_member', accountLabel: 'Work',
    }) as never,
  })));
  try {
    const mismatched = await call(app, {
      connectorId: 'github-work-u7', apiKey: 'must-not-be-written', accountLabel: 'Personal',
    });
    assert.equal(mismatched.status, 400);
    assert.equal((await mismatched.json() as { code: string }).code, 'connector_grant_connector_selection_invalid');
    assert.equal(grants.list(7, 'github').length, 0);
    // B-1252: a connector key is sent to the third party by the verify probe, so
    // a personal Claude subscription token is refused before any effect.
    const subscriptionToken = `  sk-ant-oat01-${'x'.repeat(40)}\n`;
    const refused = await call(app, {
      connectorId: 'github-work-u7', apiKey: subscriptionToken, accountLabel: 'Work',
    });
    assert.equal(refused.status, 400);
    const refusedBody = await refused.text();
    assert.equal((JSON.parse(refusedBody) as { code: string }).code, 'subscription_token_forbidden_target');
    assert.ok(!refusedBody.includes('sk-ant'), 'the refusal never echoes the token');
    assert.equal(grants.list(7, 'github').length, 0, 'nothing was stored');
    const personal = await call(app, {
      connectorId: 'github-work-u7', apiKey: 'personal-key', accountLabel: 'Work',
    });
    assert.equal(personal.status, 200);
    assert.equal((await personal.json() as { grant: { ownership: string } }).grant.ownership, 'personal');
    assert.ok(repository.readApiKeyConnectorGrantBinding(
      'github-work-u7', installationId, 7, 'github',
    ));
    Object.assign(process.env, {
      NASSAJ_CONNECTOR_AUTH_CERT_SALLA: '1', NASSAJ_CONNECTOR_GRANT_CERT_SALLA: '1',
    });
    const missingOptIn = await call(app, {
      connectorId: 'salla-work-u7', apiKey: 'must-not-store', accountLabel: 'Work',
    }, 'salla');
    assert.equal(missingOptIn.status, 400);
    assert.equal((await missingOptIn.json() as { code: string }).code,
      'connector_grant_unverified_opt_in_required');
    assert.equal(grants.list(7, 'salla').length, 0);
    const inert = await call(app, {
      connectorId: 'salla-work-u7', apiKey: 'stored-only', accountLabel: 'Work',
      acceptStoredUnverified: true,
    }, 'salla');
    assert.equal(inert.status, 200);
    const inertBody = await inert.json() as { grant: { credentialStatus: string } };
    assert.equal(inertBody.grant.credentialStatus, 'stored_unverified');
    assert.equal(repository.readApiKeyConnectorGrantBinding(
      'salla-work-u7', installationId, 7, 'salla',
    ), null, 'pending binding is durable but remains unreadable to runtime');
    assert.equal((database.prepare(
      'SELECT count(*) AS count FROM connector_api_key_connector_bindings WHERE connector_id = ?',
    ).get('salla-work-u7') as { count: number }).count, 1);
    const shared = await call(app, { apiKey: 'shared-key', ownership: 'installation_shared' });
    assert.equal(shared.status, 400);
    assert.equal((await shared.json() as { code: string }).code, 'connector_grant_ownership_invalid');
    const active = grants.list(7, 'github');
    assert.equal(active.length, 1);
    delete process.env.NASSAJ_CONNECTOR_GRANTS_V2;
    const coldApp = express();
    coldApp.use(express.json());
    coldApp.use((req, _res, next) => {
      (req as express.Request & { user: unknown }).user = { id: 7, role: 'user' };
      next();
    });
    coldApp.use('/grants', createConnectorUserGrantRoutes(() => ({
      installationId, canonicalOrigin: ORIGIN, repository, grants, profiles,
      // T-1540: deletion never reaches the gate, but the field is now required.
      assertProviderEffect: () => undefined,
    })));
    const removed = await remove(coldApp, active[0]!.grantId);
    assert.equal(removed.status, 202, 'deletion remains available when creation flags are off');
    assert.equal((database.prepare(
      'SELECT status FROM connector_user_grants WHERE grant_id = ?',
    ).get(active[0]!.grantId) as { status: string }).status, 'revoked');
  } finally {
    database.close();
    for (const key of [
      'NASSAJ_CONNECTOR_GRANTS_V2', 'NASSAJ_CONNECTOR_AUTH_REGISTRY_V1',
      'NASSAJ_CONNECTOR_AUTH_CERT_GITHUB',
      'NASSAJ_CONNECTOR_GRANT_CERT_GITHUB',
      'NASSAJ_CONNECTOR_AUTH_CERT_SALLA', 'NASSAJ_CONNECTOR_GRANT_CERT_SALLA',
    ]) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

// B-845: on a clean install (zero profile rows) the routing layer asserted the
// read-only CredentialVerify effect BEFORE any api_key profile row existed, so
// the gate denied with `profile_unready` and the first key save returned 500.
// This gate double reproduces the real readiness rule from
// connector-substrate-only.production.ts (profileReady short-circuits true only
// for ProfileConfigure) and connector-local-activation.ts:250 (profile_unready).
const faithfulProfileGate = (database: Database.Database, installationId: string) =>
  (effect: { operation: ConnectorPolicyOperation; providerId: string }): void => {
    if (effect.operation === ConnectorPolicyOperation.ProfileConfigure) return;
    const profile = database.prepare(
      'SELECT status FROM connector_auth_profiles WHERE installation_id = ? AND provider_id = ?',
    ).get(installationId, effect.providerId) as { status: string } | undefined;
    if (!profile || profile.status !== 'ready') {
      throw new Error('connector_activation_denied:profile_unready');
    }
  };

const setupGithubGrant = () => {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  database.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT); INSERT INTO users VALUES (7, 'member')");
  migrateConnectorAuthSchema(database);
  const repository = createConnectorAuthDb(database);
  const installationId = repository.getOrCreateInstallation();
  repository.recordOwnerAuthSession({
    sessionId: randomUUID(), installationId,
    sessionTokenHash: createHash('sha256').update(SESSION).digest('hex'),
    csrfTokenHash: createHash('sha256').update(CSRF).digest('hex'),
    userId: 7, authMethod: 'password', authTimeMs: Date.now(), expiresAtMs: Date.now() + 60_000,
  });
  const grants = createConnectorUserGrantService({
    installationId, repository, keyring, env: process.env,
    testApiKeyCandidate: async () => ({ providerSubject: 'provider-user-7', identityKind: 'user' }),
  });
  const profiles = createConnectorProfileManagementService({
    installation: { installationId, canonicalOrigin: ORIGIN, callbackUrl: `${ORIGIN}/connectors/oauth/callback` },
    repository, keyring, env: process.env,
    testByoCandidate: async () => undefined, testApiKeyCandidate: async () => undefined,
  });
  const labels: Record<string, string> = { 'github-work-u7': 'Work', 'github-personal-u7': 'Personal' };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { user: unknown }).user = { id: 7, role: 'user' };
    next();
  });
  app.use('/grants', createConnectorUserGrantRoutes(() => ({
    installationId, canonicalOrigin: ORIGIN, repository, grants, profiles,
    assertProviderEffect: faithfulProfileGate(database, installationId),
    getConnector: (id: string) => ({
      id, service: 'github', ownerUserId: 7, authMode: 'key',
      credentialMode: 'per_member', accountLabel: labels[id] ?? 'Work',
    }) as never,
  })));
  return { database, repository, installationId, grants, app };
};

test('B-845: first api-key save on a clean install succeeds and materialises the ready profile', async () => {
  const previous = { ...process.env };
  Object.assign(process.env, {
    NASSAJ_CONNECTOR_GRANTS_V2: '1', NASSAJ_CONNECTOR_AUTH_REGISTRY_V1: '1',
    NASSAJ_CONNECTOR_AUTH_CERT_GITHUB: '1', NASSAJ_CONNECTOR_GRANT_CERT_GITHUB: '1',
  });
  const { database, installationId, grants, app } = setupGithubGrant();
  try {
    assert.equal((database.prepare('SELECT count(*) AS c FROM connector_auth_profiles')
      .get() as { c: number }).c, 0, 'clean install starts with zero profile rows');
    // The old ordering denied CredentialVerify before any profile row existed.
    assert.throws(() => faithfulProfileGate(database, installationId)({
      operation: ConnectorPolicyOperation.CredentialVerify, providerId: 'github',
    }), /profile_unready/);

    const saved = await call(app, {
      connectorId: 'github-work-u7', apiKey: 'github-pat', accountLabel: 'Work',
    });
    assert.equal(saved.status, 200, 'first key save must not 500 with profile_unready');
    const profile = database.prepare(
      "SELECT status FROM connector_auth_profiles WHERE provider_id = 'github'",
    ).get() as { status: string } | undefined;
    assert.equal(profile?.status, 'ready', 'ProfileConfigure parity created the ready row');
    assert.equal(grants.list(7, 'github').length, 1, 'the grant persisted');
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});

test('B-845: racing first-savers converge on exactly one ready profile row', () => {
  const previous = { ...process.env };
  Object.assign(process.env, {
    NASSAJ_CONNECTOR_GRANTS_V2: '1', NASSAJ_CONNECTOR_AUTH_REGISTRY_V1: '1',
    NASSAJ_CONNECTOR_AUTH_CERT_GITHUB: '1', NASSAJ_CONNECTOR_GRANT_CERT_GITHUB: '1',
  });
  const { database, repository, installationId, grants } = setupGithubGrant();
  try {
    // First saver wins the insert. `ensureApiKeyProfile` derives origin and
    // catalog revision from the certified spec exactly as the routed save does.
    grants.ensureApiKeyProfile('github');
    const first = database.prepare(
      "SELECT profile_id AS id, status FROM connector_auth_profiles WHERE provider_id = 'github'",
    ).get() as { id: string; status: string };
    assert.equal(first.status, 'ready');
    // A racer that also passed the "no ready profile yet" check attempts its own
    // INSERT with a different profile_id; ON CONFLICT DO NOTHING keeps the first
    // row untouched and returns it, so no duplicate provider profile can appear.
    const spec = providerAuthSpecFor('github')!;
    const racer = repository.ensureApiKeyGrantProfile!({
      profileId: randomUUID(), installationId, providerId: spec.profileId,
      canonicalOrigin: new URL(spec.expectedIssuer).origin,
      catalogRevision: spec.source.catalogRevision,
    });
    assert.equal(racer.profileId, first.id, 'the racing insert adopts the winning row');
    assert.equal((database.prepare(
      "SELECT count(*) AS c FROM connector_auth_profiles WHERE provider_id = 'github'",
    ).get() as { c: number }).c, 1, 'ON CONFLICT DO NOTHING keeps a single provider profile');
    // Idempotent re-entry through the service is a no-op read.
    grants.ensureApiKeyProfile('github');
    assert.equal((database.prepare(
      "SELECT count(*) AS c FROM connector_auth_profiles WHERE provider_id = 'github'",
    ).get() as { c: number }).c, 1);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, test } from 'node:test';

import express from 'express';

import {
  CONNECTOR_AUTH_REGISTRY_FLAG,
  PROVIDER_AUTH_SPECS,
} from '../../../shared/connector-auth-registry.js';

import type { ManagedConnectorProfile } from './connector-auth-profile-management.js';
import { createConnectorAuthReadinessRoutes } from './connector-auth-readiness.routes.js';
import { createConnectorOwnerOperationGate } from './connector-owner-operation-gate.js';

const ORIGIN = 'https://nassaj.example';
const INSTALLATION_ID = '11111111-1111-4111-8111-111111111111';
const CSRF = 'a'.repeat(64);
const RECENT = 'c'.repeat(64);
const servers: Array<ReturnType<express.Express['listen']>> = [];

const profile = (
  providerId: string,
  status: ManagedConnectorProfile['status'] = 'ready',
): ManagedConnectorProfile => ({
  profileId: `22222222-2222-4222-8222-${providerId.padEnd(12, '0').slice(0, 12)}`,
  installationId: INSTALLATION_ID,
  providerId,
  canonicalOrigin: ORIGIN,
  status,
  catalogRevision: 'test',
  secretRef: null,
  secretRevision: null,
  version: 1,
  secretRefs: {},
});

const enabledEnv = (...providerIds: string[]): Record<string, string> => {
  const env: Record<string, string> = { [CONNECTOR_AUTH_REGISTRY_FLAG]: '1' };
  for (const providerId of providerIds) {
    const spec = PROVIDER_AUTH_SPECS.find(item => item.profileId === providerId);
    assert.ok(spec);
    env[spec.certification.featureFlag] = '1';
  }
  return env;
};

const request = async (input: Readonly<{
  role?: string;
  noUser?: boolean;
  origin?: string;
  cookie?: string | null;
  sessionActive?: boolean;
  runtimeAvailable?: boolean;
  env?: Readonly<Record<string, string | undefined>>;
  profiles?: readonly ManagedConnectorProfile[];
  onList?: (installationId: string) => void;
}> = {}) => {
  const app = express();
  app.use((req, _res, next) => {
    if (!input.noUser) {
      (req as express.Request & { user?: { id: number; role: string } }).user = {
        id: 7,
        role: input.role ?? 'user',
      };
    }
    next();
  });
  app.use('/api/connectors/auth-readiness', createConnectorAuthReadinessRoutes({
    env: input.env ?? enabledEnv('google-workspace', 'github', 'slack', 'salla', 'canva'),
    runtime: () => ({
      canonicalOrigin: ORIGIN,
      installationId: input.runtimeAvailable === false ? null : INSTALLATION_ID,
      repository: input.runtimeAvailable === false ? null : {
        listProfiles: (installationId) => {
          input.onList?.(installationId);
          return input.profiles ?? [];
        },
        readOwnerAuthSession: ({ sessionTokenHash }) => input.sessionActive !== false
          && sessionTokenHash === createHash('sha256').update(RECENT).digest('hex')
          ? {
            sessionId: 'session',
            csrfTokenHash: createHash('sha256').update(CSRF).digest('hex'),
            authTime: 1,
            expiresAt: Number.MAX_SAFE_INTEGER,
          }
          : null,
      },
    }),
  }));
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const headers: Record<string, string> = {};
  if (input.origin) headers.origin = input.origin;
  const cookie = input.cookie === undefined
    ? `nassaj_connector_recent_auth=${RECENT}; nassaj_connector_csrf=${CSRF}`
    : input.cookie;
  if (cookie) headers.cookie = cookie;
  const response = await fetch(
    `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/connectors/auth-readiness`,
    { headers },
  );
  return {
    response,
    body: await response.json() as Record<string, unknown>,
  };
};

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

test('member receives grouped secret-free readiness without owner setup', async () => {
  let queriedInstallation = '';
  const { response, body } = await request({
    role: 'user',
    profiles: [profile('google-workspace'), profile('unknown-provider')],
    onList: installationId => { queriedInstallation = installationId; },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(body.schemaVersion, 1);
  assert.equal(body.csrfToken, CSRF);
  assert.equal(body.recentAuthRequired, false);
  assert.equal(queriedInstallation, INSTALLATION_ID, 'the repository is scoped to this installation');
  const profiles = body.profiles as Array<Record<string, unknown>>;
  const google = profiles.filter(item => item.providerId === 'google-workspace');
  assert.equal(google.length, 1, 'Google Calendar, Drive and Gmail share one profile');
  assert.deepEqual(google[0].services, ['google-calendar', 'google-drive', 'gmail']);
  assert.equal(google[0].configured, true);
  assert.equal(google[0].readiness, 'ready');
  const capabilities = google[0].serviceCapabilities as Array<Record<string, unknown>>;
  assert.deepEqual(capabilities.map(capability => capability.serviceId), [
    'google-calendar', 'google-drive', 'gmail',
  ]);
  assert.ok(capabilities.every(capability => capability.credentialInputSchema === null));
  assert.equal('setup' in google[0], false);
  assert.equal(profiles.some(item => item.providerId === 'unknown-provider'), false);
  const serialized = JSON.stringify(body);
  for (const forbidden of ['clientSecret', 'tokenEndpoint', 'authorizationEndpoint', 'diagnostics']) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test('owner alone receives safe BYO setup and readiness follows profile state', async () => {
  const pending = await request({ role: 'owner', profiles: [profile('google-workspace', 'pending')] });
  const pendingGoogle = (pending.body.profiles as Array<Record<string, unknown>>)
    .find(item => item.providerId === 'google-workspace')!;
  assert.equal(pendingGoogle.readiness, 'owner_setup_required');
  assert.deepEqual(pendingGoogle.setup, {
    callbackUrl: `${ORIGIN}/connectors/oauth/callback`,
    appRegistrationUrl: 'https://console.cloud.google.com/apis/credentials',
  });

  const ready = await request({ role: 'owner', profiles: [profile('google-workspace')] });
  const readyGoogle = (ready.body.profiles as Array<Record<string, unknown>>)
    .find(item => item.providerId === 'google-workspace')!;
  assert.equal(readyGoogle.readiness, 'ready');
  assert.equal(readyGoogle.configured, true);
});

test('flags and certifications fail closed, including Canva and uncertified API probes', async () => {
  const enabled = await request();
  const profiles = enabled.body.profiles as Array<Record<string, unknown>>;
  assert.equal(profiles.find(item => item.providerId === 'canva')?.readiness, 'unsupported');
  assert.equal(profiles.find(item => item.providerId === 'github')?.readiness, 'ready');
  assert.equal(profiles.find(item => item.providerId === 'slack')?.readiness, 'ready');
  assert.equal(profiles.find(item => item.providerId === 'salla')?.readiness, 'temporarily_unavailable');
  assert.equal(profiles.find(item => item.providerId === 'notion')?.readiness, 'unsupported');

  let listCalled = false;
  const disabled = await request({ env: {}, onList: () => { listCalled = true; } });
  assert.equal(listCalled, false, 'flag-off readiness does not touch profile storage');
  assert.ok((disabled.body.profiles as Array<Record<string, unknown>>)
    .every(item => item.readiness === 'unsupported'));
});

test('missing, corrupt, logged-out, and rotated recent-auth cookies never mint or reveal CSRF', async () => {
  const cases = [
    await request({ cookie: null }),
    await request({ cookie: `nassaj_connector_recent_auth=${RECENT}; nassaj_connector_csrf=${'b'.repeat(64)}` }),
    await request({ sessionActive: false }),
    await request({ cookie: `nassaj_connector_recent_auth=${'d'.repeat(64)}; nassaj_connector_csrf=${CSRF}` }),
  ];
  for (const result of cases) {
    assert.equal(result.response.status, 200);
    assert.equal(result.body.csrfToken, null);
    assert.equal(result.body.recentAuthRequired, true);
    assert.equal(result.response.headers.get('set-cookie'), null);
  }
});

test('unauthenticated and cross-origin requests receive neither DTO nor CSRF cookie', async () => {
  const unauthenticated = await request({ noUser: true });
  assert.equal(unauthenticated.response.status, 401);
  assert.equal(unauthenticated.response.headers.get('cache-control'), 'no-store');
  assert.equal(unauthenticated.response.headers.get('set-cookie'), null);
  assert.equal('profiles' in unauthenticated.body, false);

  const crossOrigin = await request({ origin: 'https://attacker.example' });
  assert.equal(crossOrigin.response.status, 403);
  assert.equal(crossOrigin.response.headers.get('cache-control'), 'no-store');
  assert.equal(crossOrigin.response.headers.get('set-cookie'), null);
  assert.equal('profiles' in crossOrigin.body, false);

  const unavailable = await request({ runtimeAvailable: false });
  assert.equal(unavailable.response.status, 503);
  assert.equal(unavailable.response.headers.get('cache-control'), 'no-store');
});

test('a login-established CSRF pair returned by readiness passes the unchanged write gate', async () => {
  const csrfHash = createHash('sha256').update(CSRF).digest('hex');
  const recentHash = createHash('sha256').update(RECENT).digest('hex');
  const repository = {
    listProfiles: () => [],
    readOwnerAuthSession: ({ sessionTokenHash }: { sessionTokenHash: string }) =>
      sessionTokenHash === recentHash
        ? { sessionId: 'login-session', csrfTokenHash: csrfHash, authTime: 1, expiresAt: Number.MAX_SAFE_INTEGER }
        : null,
    issueOwnerOperation: () => ({
      sessionId: 'login-session', authTime: 1, expiresAt: Number.MAX_SAFE_INTEGER,
    }),
  };
  const app = express();
  app.use((req, _res, next) => {
    (req as express.Request & { user?: { id: number; role: string } }).user = { id: 7, role: 'user' };
    next();
  });
  app.use('/api/connectors/auth-readiness', createConnectorAuthReadinessRoutes({
    env: enabledEnv('github'),
    runtime: () => ({ canonicalOrigin: ORIGIN, installationId: INSTALLATION_ID, repository }),
  }));
  app.post('/api/connectors/protected', createConnectorOwnerOperationGate({
    repository: { ...repository, consumeOwnerOperation: () => true },
    installationId: INSTALLATION_ID,
    canonicalOrigin: ORIGIN,
    operation: 'upsert_personal_api_key',
    ownerOnly: false,
  }), (_req, res) => res.status(204).end());
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const cookie = `nassaj_connector_recent_auth=${RECENT}; nassaj_connector_csrf=${CSRF}`;
  const readiness = await fetch(`${baseUrl}/api/connectors/auth-readiness`, { headers: { cookie } });
  const readinessBody = await readiness.json() as { csrfToken: string | null };
  assert.equal(readinessBody.csrfToken, CSRF);
  const write = await fetch(`${baseUrl}/api/connectors/protected`, {
    method: 'POST',
    headers: { cookie, origin: ORIGIN, 'x-csrf-token': readinessBody.csrfToken! },
  });
  assert.equal(write.status, 204);
});

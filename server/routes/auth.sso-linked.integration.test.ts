/**
 * ADR-H20 S6 with the real auth router, middleware and SQLite (ADR-194
 * amendment A2): the 24 h sliding idle of SSO device sessions (N8), the owner
 * tier gate on privileged REST actions (N2), the sid binding across a refresh
 * (N5) and the end_session URL on sign-out (N4). The OIDC router is a double;
 * the mock OpenID Provider serves discovery for the end_session endpoint.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test, { after, before, beforeEach, mock } from 'node:test';
import { pathToFileURL } from 'node:url';

import express from 'express';
import jwt from 'jsonwebtoken';

import {
  closeConnection, getConnection, initializeDatabase, revokedTokenSidsDb, ssoDeviceSessionsDb, userDb,
} from '../modules/database/index.js';
import { hashPassword } from '../services/password.service.js';
import { createMockOpenIdProvider } from '../services/__tests__/mock-openid-provider.js';

const url = (spec: string) => pathToFileURL(path.resolve(import.meta.dirname, spec)).href;
const PASSWORD = 'correct horse battery staple';
const HOUR_MS = 60 * 60_000;
process.env.NASSAJ_PROVIDER_SECRETS_KEY = crypto.randomBytes(32).toString('base64');

mock.module(url('../modules/connectors/connector-owner-auth-session.js'), {
  namedExports: {
    recordConnectorOwnerAuthentication: () => {},
    clearConnectorOwnerAuthentication: () => {},
  },
});
mock.module(url('./oidc.js'), { defaultExport: express.Router() });

let server: Server;
let origin: string;
let passwordHash: string;
let sequence = 0;
let ipSequence = 0;
let authenticateWebSocket: (token: string | null) => { tokenSid?: string } | null;
let mintToken: (user: unknown, options: { sid: string }) => string;
let ownerStepUpRequired: (principal: { role?: string; refreshSid?: string | null }) => boolean;
let constants: { TOKEN_TTL_MS: number; REFRESH_GRACE_MAX_HOURS: number; MAX_SESSION_TOKEN_LIFETIME_MS: number };
let setNetwork: (overrides: unknown) => void;
let resetSso: () => void;
let writeSsoRow: (db: unknown, overrides?: Record<string, unknown>) => unknown;
let updateSettings: (patch: unknown, actor: { userId: number }) => unknown;
const previousFlag = process.env.MULTI_ACCOUNT_SWITCHING;

before(async () => {
  assert.ok(process.env.DATABASE_PATH, 'Use the isolated node test runner');
  process.env.MULTI_ACCOUNT_SWITCHING = 'false';
  await initializeDatabase();
  passwordHash = await hashPassword(PASSWORD);
  const { default: router } = await import('./auth.js');
  const middleware = await import('../middleware/auth.js');
  const deviceSessions = await import('../services/sso-device-session.service.js');
  authenticateWebSocket = middleware.authenticateWebSocket as typeof authenticateWebSocket;
  ownerStepUpRequired = deviceSessions.ownerStepUpRequired;
  mintToken = middleware.generateToken as typeof mintToken;
  constants = {
    TOKEN_TTL_MS: middleware.TOKEN_TTL_MS,
    REFRESH_GRACE_MAX_HOURS: middleware.REFRESH_GRACE_MAX_HOURS,
    MAX_SESSION_TOKEN_LIFETIME_MS: deviceSessions.MAX_SESSION_TOKEN_LIFETIME_MS,
  };
  ({ setSsoNetworkOverridesForTests: setNetwork } = await import('../services/sso-oidc-runtime.service.js'));
  ({ resetSsoConfigCacheForTests: resetSso } = await import('../services/sso-config.service.js'));
  ({ writeSsoRow } = await import('../services/__tests__/sso-config-fixture.js') as never);
  ({ updateSsoLinkedSettings: updateSettings } = await import('../services/sso-linked-settings.service.js'));
  const ok = (_req: unknown, res: express.Response) => { res.json({ ok: true }); };
  const app = express();
  app.use(express.json());
  app.use('/api/auth', router);
  app.get('/api/probe', middleware.authenticateToken, ok);
  app.all('/api/settings/sample', middleware.authenticateToken, ok);
  app.post('/api/system/pending/1/execute', middleware.authenticateToken, ok);
  app.get('/api/terminals', middleware.authenticateToken, ok);
  app.post('/api/projects/p1/files', middleware.authenticateToken, ok);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  closeConnection();
  if (previousFlag === undefined) delete process.env.MULTI_ACCOUNT_SWITCHING;
  else process.env.MULTI_ACCOUNT_SWITCHING = previousFlag;
});

beforeEach(() => {
  getConnection().exec(`DELETE FROM sso_device_sessions; DELETE FROM sso_device_session_idp_sids;
    DELETE FROM sso_oidc_config; DELETE FROM app_config WHERE key LIKE 'sso.%';`);
  resetSso();
});

const freshIp = () => `198.51.100.${++ipSequence}`;

function account(role: 'user' | 'owner' = 'user') {
  return userDb.createUser(`h20_user_${++sequence}`, passwordHash, role);
}

function call(method: string, route: string, token: string, body?: unknown) {
  return fetch(`${origin}${route}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`, 'cf-connecting-ip': freshIp(),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function passwordLogin(user: { username: string }) {
  const res = await fetch(`${origin}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': freshIp() },
    body: JSON.stringify({ username: user.username, password: PASSWORD }),
  });
  assert.equal(res.status, 200);
  return (await res.json()).token as string;
}

const sidOf = (token: string) => (jwt.decode(token) as { sid: string }).sid;

/** Turns a password session into an SSO device session (what the OIDC callback binds). */
function bindSso(token: string, userId: number, {
  ownerTier = false, lastSeenAgoMs = 0, privilegedUntil = null as number | null, idpSid = `V1_${crypto.randomUUID()}`,
} = {}) {
  const refreshSid = sidOf(token);
  const nowMs = Date.now();
  ssoDeviceSessionsDb.bind({
    refreshSid, userId, issuer: 'https://idp.example', idpSid, loginHint: null, ownerTier, privilegedUntil,
    nowMs, pruneAfter: nowMs + 30 * 24 * HOUR_MS,
  });
  if (lastSeenAgoMs) {
    getConnection().prepare('UPDATE sso_device_sessions SET last_seen_at = ? WHERE refresh_sid = ?')
      .run(nowMs - lastSeenAgoMs, refreshSid);
  }
  return { refreshSid, idpSid };
}

// ---------------------------------------------------------------------------
// N8: sliding 24 h idle, no absolute cap
// ---------------------------------------------------------------------------

test('N8: 24 h idle ends an SSO session (REST 401 sso_session_expired, WS, refresh); a password session never idles', async () => {
  const user = account();
  const idle = await passwordLogin(user);
  bindSso(idle, user.id, { lastSeenAgoMs: 24 * HOUR_MS + 60_000 });
  const res = await call('GET', '/api/probe', idle);
  assert.equal(res.status, 401);
  assert.equal((await res.json()).code, 'sso_session_expired');
  assert.equal(authenticateWebSocket(idle), null);
  assert.equal((await call('POST', '/api/auth/refresh', idle, {})).status, 401, 'never renewed once idle');

  const passwordOnly = await passwordLogin(user);
  assert.equal((await call('GET', '/api/probe', passwordOnly)).status, 200, 'no binding, no idle rule');
});

test('N8: continuous use past 24 h never signs out — each use slides the idle clock', async () => {
  const user = account();
  const token = await passwordLogin(user);
  const { refreshSid } = bindSso(token, user.id, { lastSeenAgoMs: 23 * HOUR_MS });
  getConnection().prepare('UPDATE sso_device_sessions SET created_at = ? WHERE refresh_sid = ?')
    .run(Date.now() - 47 * HOUR_MS, refreshSid);
  assert.equal((await call('GET', '/api/probe', token)).status, 200);
  const touched = ssoDeviceSessionsDb.get(refreshSid)!;
  assert.ok(Date.now() - touched.last_seen_at < 5_000, 'use renewed the clock');
  getConnection().prepare('UPDATE sso_device_sessions SET last_seen_at = ? WHERE refresh_sid = ?')
    .run(Date.now() - 23 * HOUR_MS, refreshSid);
  assert.equal((await call('GET', '/api/probe', token)).status, 200, '70 h after sign-in, still in');
});

test('N8: the idle clock is written at most once per 5 minutes', async () => {
  const user = account();
  const token = await passwordLogin(user);
  const { refreshSid } = bindSso(token, user.id, { lastSeenAgoMs: 60_000 });
  const before = ssoDeviceSessionsDb.get(refreshSid)!.last_seen_at;
  assert.equal((await call('GET', '/api/probe', token)).status, 200);
  assert.equal(ssoDeviceSessionsDb.get(refreshSid)!.last_seen_at, before, 'inside the throttle: no write');
});

test('N5: idp_sid survives every refresh — the binding is keyed by the device session', async () => {
  const user = account();
  const token = await passwordLogin(user);
  const { refreshSid, idpSid } = bindSso(token, user.id);
  const refreshed = (await (await call('POST', '/api/auth/refresh', token, {})).json()).token as string;
  assert.equal(sidOf(refreshed), refreshSid);
  assert.deepEqual(ssoDeviceSessionsDb.findByIdpSid('https://idp.example', idpSid).map((row) => row.refresh_sid), [refreshSid]);
  assert.equal((await call('GET', '/api/probe', refreshed)).status, 200);
});

test('pruning can never revive an idle token: a row outlives every token of its session', () => {
  assert.ok(constants.MAX_SESSION_TOKEN_LIFETIME_MS
    >= constants.TOKEN_TTL_MS + constants.REFRESH_GRACE_MAX_HOURS * HOUR_MS);
});

// ---------------------------------------------------------------------------
// N2: the owner tier gate on REST
// ---------------------------------------------------------------------------

test('N2: an owner no-click SSO session reads freely; privileged writes and the terminal need the step-up', async () => {
  const owner = account('owner');
  const token = await passwordLogin(owner);
  bindSso(token, owner.id, { ownerTier: true });
  assert.equal((await call('GET', '/api/probe', token)).status, 200);
  assert.equal((await call('GET', '/api/settings/sample', token)).status, 200, 'reading settings is open');
  assert.equal((await call('POST', '/api/projects/p1/files', token, {})).status, 200, 'not a privileged action');
  for (const [method, route] of [
    ['PUT', '/api/settings/sample'], ['POST', '/api/system/pending/1/execute'], ['GET', '/api/terminals'],
  ] as const) {
    const res = await call(method, route, token, method === 'GET' ? undefined : {});
    assert.equal(res.status, 403, `${method} ${route}`);
    assert.equal((await res.json()).code, 'owner_step_up_required');
  }
  const ws = authenticateWebSocket(token);
  assert.ok(ws, 'the socket itself opens');
  assert.equal(ownerStepUpRequired({ role: 'owner', refreshSid: ws.tokenSid }), true, 'its agent turns and shell are gated');
});

test('N2: a grant on browser A opens A only; a password owner session is never gated', async () => {
  const owner = account('owner');
  const browserA = await passwordLogin(owner);
  const browserB = await passwordLogin(owner);
  bindSso(browserA, owner.id, { ownerTier: true, privilegedUntil: Date.now() + HOUR_MS });
  bindSso(browserB, owner.id, { ownerTier: true });
  assert.equal((await call('PUT', '/api/settings/sample', browserA, {})).status, 200);
  assert.equal((await call('PUT', '/api/settings/sample', browserB, {})).status, 403, 'never crosses devices');
  const passwordSession = await passwordLogin(owner);
  assert.equal((await call('PUT', '/api/settings/sample', passwordSession, {})).status, 200);
});

test('N2: an expired grant (past ~60 min) gates again', async () => {
  const owner = account('owner');
  const token = await passwordLogin(owner);
  bindSso(token, owner.id, { ownerTier: true, privilegedUntil: Date.now() - 1 });
  assert.equal((await call('PUT', '/api/settings/sample', token, {})).status, 403);
});

test('H2: a member SSO session promoted to owner is refused privileged actions until a fresh owner sign-in', async () => {
  const admin = account('owner');
  const adminToken = await passwordLogin(admin);
  const user = account();
  const token = await passwordLogin(user);
  bindSso(token, user.id);
  assert.equal((await call('PUT', '/api/settings/sample', token, {})).status, 200, 'a member is never step-up gated');
  const promoted = await call('PATCH', `/api/auth/users/${user.id}/role`, adminToken, { role: 'owner' });
  assert.equal(promoted.status, 200);
  assert.equal((await call('GET', '/api/probe', token)).status, 401, 'the role change invalidates the old token');
  // Defence in depth: a token of the SAME device session minted after the
  // promotion (the binding, owner_tier 0, stays) still cannot act as owner.
  const renewed = mintToken(userDb.getUserById(user.id), { sid: sidOf(token) });
  const res = await call('PUT', '/api/settings/sample', renewed, {});
  assert.equal(res.status, 403, 'the member-tier binding cannot carry owner privilege');
  assert.equal((await res.json()).code, 'owner_step_up_required');
  assert.equal((await call('GET', '/api/probe', renewed)).status, 200, 'reads stay open');
});

test('M2: renaming or deleting a passkey needs the step-up; registration and the step-up itself stay open', async () => {
  const owner = account('owner');
  const token = await passwordLogin(owner);
  bindSso(token, owner.id, { ownerTier: true });
  for (const [method, body] of [['PATCH', { name: 'x' }], ['DELETE', undefined]] as const) {
    const res = await call(method, '/api/auth/webauthn/credentials/1', token, body);
    assert.equal(res.status, 403, `${method} credentials`);
    assert.equal((await res.json()).code, 'owner_step_up_required');
  }
  assert.equal((await call('GET', '/api/auth/webauthn/credentials', token)).status, 200, 'listing stays open');
  for (const route of ['/api/auth/webauthn/register/options', '/api/auth/webauthn/step-up/options']) {
    const res = await call('POST', route, token, {});
    const body = await res.json().catch(() => ({})) as { code?: string };
    assert.notEqual(body.code, 'owner_step_up_required', route);
  }
});

// ---------------------------------------------------------------------------
// N4: sign-out goes on to the IdP end_session
// ---------------------------------------------------------------------------

test('N4: an SSO sign-out returns the end_session URL (client_id, allow-listed return, no id_token_hint)', async () => {
  const op = createMockOpenIdProvider();
  op.discoveryOverrides.end_session_endpoint = `${op.issuer}/oidc/v1/end_session`;
  setNetwork(op.network);
  writeSsoRow(getConnection());
  resetSso();
  const owner = account('owner');
  updateSettings({ postLogoutRedirectUri: 'https://dar.example/auth/signed-out' }, { userId: owner.id });
  const user = account();
  const token = await passwordLogin(user);
  const { refreshSid } = bindSso(token, user.id);
  const res = await call('POST', '/api/auth/logout', token, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  const endSession = new URL(body.endSessionUrl);
  assert.equal(endSession.origin + endSession.pathname, `${op.issuer}/oidc/v1/end_session`);
  assert.equal(endSession.searchParams.get('client_id'), 'nassaj-client');
  assert.equal(endSession.searchParams.get('post_logout_redirect_uri'), 'https://dar.example/auth/signed-out');
  assert.equal(endSession.searchParams.get('id_token_hint'), null);
  assert.equal(ssoDeviceSessionsDb.get(refreshSid), undefined, 'the binding ends with the sign-out');
  assert.equal(revokedTokenSidsDb.isRevoked(refreshSid, Date.now()), true);

  const passwordSession = await passwordLogin(user);
  const plain = await (await call('POST', '/api/auth/logout', passwordSession, {})).json();
  assert.equal(plain.endSessionUrl, undefined, 'a password session stays local (ADR-H20 D7)');
});

test('N1: /status exposes ssoAutoSignIn only when SSO is active and the node setting is on', async () => {
  const status = async () => (await fetch(`${origin}/api/auth/status`)).json();
  assert.equal((await status()).ssoAutoSignIn, false);
  const owner = account('owner');
  updateSettings({ autoSignIn: true }, { userId: owner.id });
  assert.equal((await status()).ssoAutoSignIn, false, 'SSO is not active');
  const op = createMockOpenIdProvider();
  setNetwork(op.network);
  writeSsoRow(getConnection());
  resetSso();
  assert.equal((await status()).ssoAutoSignIn, true);
});

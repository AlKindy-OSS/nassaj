import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { EventEmitter } from 'node:events';
import test, { after, before, mock } from 'node:test';

import express from 'express';

import { closeConnection, deviceAccountSessionsDb, initializeDatabase, userDb } from '../modules/database/index.js';
import { bindDeviceHttpResponseLifetime, connectionRevocationRegistry, SSEStreamWriter } from '../modules/account-wallet/index.js';
import { hashPassword } from '../services/password.service.js';

// Mock unrelated external authentication boundaries; exercise the real router,
// local verifier, limiter, middleware and SQLite wallet transactions together.
mock.module(new URL('./webauthn.js', import.meta.url).href, { defaultExport: express.Router() });
mock.module(new URL('./oidc.js', import.meta.url).href, { defaultExport: express.Router() });

let server: Server;
let origin: string;
let passwordHash: string;
let sequence = 0;
let authenticateWebSocketForTest: (token: string) => unknown;
let generateTokenForTest: (user: unknown) => string;
let delayedReadStarted = Promise.withResolvers<void>();
let releaseDelayedRead = Promise.withResolvers<void>();
let documentWrites = 0;
const previousFlag = process.env.MULTI_ACCOUNT_SWITCHING;
const previousOrigin = process.env.APP_ORIGIN;

before(async () => {
  assert.ok(process.env.DATABASE_PATH, 'Use the isolated node test runner');
  process.env.MULTI_ACCOUNT_SWITCHING = 'true';
  await initializeDatabase();
  passwordHash = await hashPassword('correct horse battery staple');
  const { default: router } = await import('./auth.js');
  const { authenticateToken, authenticateWebSocket, generateToken } = await import('../middleware/auth.js');
  authenticateWebSocketForTest = authenticateWebSocket;
  generateTokenForTest = generateToken;
  const app = express();
  app.use(express.json());
  app.use('/api/auth', router);
  app.get('/api/auth-test/events', authenticateToken, (request, response) => {
    response.set('Content-Type', 'text/event-stream');
    const writer = new SSEStreamWriter(response, request.user.id, request.user);
    writer.send({ type: 'ready' });
  });
  app.get('/api/auth-test/delayed-disclosure', authenticateToken, async (_request, response) => {
    delayedReadStarted.resolve();
    await releaseDelayedRead.promise;
    response.json({ privateValue: 'must-not-cross-identity-switch' });
  });
  app.post('/api/auth-test/document-write', authenticateToken, async (request, response) => {
    await Promise.resolve();
    if (request.assertCurrentIdentity?.() === false) {
      return response.status(409).json({ code: 'identity_changed' });
    }
    documentWrites += 1;
    return response.status(201).json({ success: true });
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.APP_ORIGIN = origin;
});

after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  closeConnection();
  if (previousFlag === undefined) delete process.env.MULTI_ACCOUNT_SWITCHING;
  else process.env.MULTI_ACCOUNT_SWITCHING = previousFlag;
  if (previousOrigin === undefined) delete process.env.APP_ORIGIN;
  else process.env.APP_ORIGIN = previousOrigin;
});

function fixture() {
  const id = ++sequence;
  const first = userDb.createUser(`wallet_owner_${id}`, passwordHash, 'owner');
  const email = `wallet_candidate_${id}@example.test`;
  userDb.createUser(email, passwordHash, 'user');
  const device = deviceAccountSessionsDb.create(first.id, 60_000);
  const cookie = `__Host-nassaj_device=${device.secret}`;
  const request = (route: string, options: RequestInit = {}) => fetch(`${origin}/api/auth${route}`, {
    ...options, headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', ...options.headers },
  });
  const csrf = async (action: string) => {
    const response = await request(`/accounts/csrf?action=${action}`);
    assert.equal(response.status, 200);
    return (await response.json()).csrfToken as string;
  };
  const mutationCsrf = async (method: string, path: string) => {
    const query = new URLSearchParams({ method, path });
    const response = await request(`/mutation-csrf?${query.toString()}`);
    assert.equal(response.status, 200);
    return (await response.json()).csrfToken as string;
  };
  const genericMutate = async (route: string, body: object, method = 'POST') => request(route, {
    method,
    body: JSON.stringify(body),
    headers: { 'X-CSRF-Token': await mutationCsrf(method, `/api/auth${route}`) },
  });
  const mutate = async (route: string, action: string, body: object, method = 'POST') => request(route, {
    method, body: JSON.stringify(body), headers: { 'X-CSRF-Token': await csrf(action) },
  });
  return { device, email, request, csrf, mutationCsrf, genericMutate, mutate };
}

test('wallet login requires the exact application Origin while legacy JWT login stays compatible', async () => {
  const f = fixture();
  const body = JSON.stringify({ username: f.email, password: 'correct horse battery staple' });
  const missing = await fetch(`${origin}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
  });
  assert.equal(missing.status, 403);
  assert.equal((await missing.json()).code, 'origin_rejected');
  const foreign = await fetch(`${origin}/api/auth/login`, {
    method: 'POST', headers: { Origin: 'https://attacker.example', 'Content-Type': 'application/json' }, body,
  });
  assert.equal(foreign.status, 403);
  const accepted = await fetch(`${origin}/api/auth/login`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body,
  });
  assert.equal(accepted.status, 200);
  assert.match(accepted.headers.get('set-cookie') ?? '', /__Host-nassaj_device=/u);

  process.env.MULTI_ACCOUNT_SWITCHING = 'false';
  try {
    const legacy = await fetch(`${origin}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    });
    assert.equal(legacy.status, 200);
    assert.equal(typeof (await legacy.json()).token, 'string');
  } finally { process.env.MULTI_ACCOUNT_SWITCHING = 'true'; }
});

test('local add preserves identity, exposes no credentials and rejects stale generations', async () => {
  const f = fixture();
  const response = await f.mutate('/accounts/add', 'add', {
    email: f.email, password: 'correct horse battery staple', expectedGeneration: 1,
  });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('set-cookie'), null);
  const wallet = await response.json();
  assert.equal(wallet.activeSlotId, f.device.wallet.activeSlotId);
  assert.equal(wallet.accounts.length, 2);
  assert.equal(wallet.generation, 2);
  assert.equal(wallet.token, undefined);
  for (const account of wallet.accounts) {
    assert.equal(account.userId, undefined);
    assert.equal(account.email, undefined);
    assert.equal(account.password, undefined);
  }
  const second = wallet.accounts.find((account: { isActive: boolean }) => !account.isActive);
  const stale = await f.mutate('/accounts/switch', 'switch', { slotId: second.slotId, expectedGeneration: 1 });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, 'wallet_generation_conflict');
  assert.equal(deviceAccountSessionsDb.snapshot(f.device.principal.deviceSessionId)?.activeSlotId, wallet.activeSlotId);
});

test('unknown email and wrong password have identical failures and leave the wallet unchanged', async () => {
  const f = fixture();
  const wrong = await f.mutate('/accounts/add', 'add', { email: f.email, password: 'wrong', expectedGeneration: 1 });
  const absent = await f.mutate('/accounts/add', 'add', { email: 'absent@example.test', password: 'wrong', expectedGeneration: 1 });
  assert.equal(wrong.status, 401);
  assert.equal(absent.status, 401);
  assert.deepEqual(await wrong.json(), await absent.json());
  assert.deepEqual(deviceAccountSessionsDb.snapshot(f.device.principal.deviceSessionId), f.device.wallet);
});

test('compound limiter rejects the sixth device/IP/candidate attempt', async () => {
  const f = fixture();
  for (let attempt = 0; attempt < 6; attempt++) {
    const response = await f.mutate('/accounts/add', 'add', {
      email: attempt % 2 ? ` ${f.email.toUpperCase()} ` : f.email,
      password: 'wrong', expectedGeneration: 1,
    });
    assert.equal(response.status, attempt === 5 ? 429 : 401);
    assert.equal((await response.json()).code, 'add_account_failed');
    if (attempt === 5) assert.ok(Number(response.headers.get('retry-after')) > 0);
  }
});

test('device limiter is independent from candidate and compound buckets', async () => {
  const f = fixture();
  for (let attempt = 0; attempt < 9; attempt++) {
    const response = await f.mutate('/accounts/add', 'add', {
      email: `distinct_${sequence}_${attempt}@example.test`,
      password: 'wrong', expectedGeneration: 1,
    });
    assert.equal(response.status, attempt === 8 ? 429 : 401);
    assert.equal((await response.json()).code, 'add_account_failed');
  }
});

test('candidate limiter is independent across devices', async () => {
  const candidate = `shared_candidate_${sequence}@example.test`;
  for (let attempt = 0; attempt < 9; attempt++) {
    const f = fixture();
    const response = await f.mutate('/accounts/add', 'add', {
      email: candidate, password: 'wrong', expectedGeneration: 1,
    });
    assert.equal(response.status, attempt === 8 ? 429 : 401);
    assert.equal((await response.json()).code, 'add_account_failed');
  }
});

test('every wallet mutation rejects an unrelated action token and foreign or missing origin', async () => {
  for (const [route, method, action] of [
    ['/accounts/add', 'POST', 'add'], ['/accounts/switch', 'POST', 'switch'],
    [`/accounts/slot_${'a'.repeat(20)}`, 'DELETE', `remove&slotId=slot_${'a'.repeat(20)}`],
    ['/logout', 'POST', 'logout'], ['/logout-all', 'POST', 'logout_all'],
  ]) {
    const f = fixture();
    for (const headers of [
      { 'X-CSRF-Token': await f.csrf(action === 'add' ? 'switch' : 'add') },
      { 'X-CSRF-Token': await f.csrf(action), Origin: 'https://foreign.example' },
      { 'X-CSRF-Token': await f.csrf(action), Origin: '' },
    ]) {
      const response = await f.request(route, { method, headers, body: '{"expectedGeneration":1}' });
      assert.equal(response.status, 403, `${method} ${route}`);
      assert.equal((await response.json()).code, 'csrf_or_origin_rejected');
    }
    assert.deepEqual(deviceAccountSessionsDb.snapshot(f.device.principal.deviceSessionId), f.device.wallet);
  }
});

test('device-cookie mutations require method/path token and reject it after an account switch', async () => {
  const f = fixture();
  const missing = await f.request('/me/avatar-choice', {
    method: 'PATCH', body: JSON.stringify({ color: 'rose' }),
  });
  assert.equal(missing.status, 403);
  assert.equal((await missing.json()).code, 'csrf_or_origin_rejected');

  const wrongPathToken = await f.mutationCsrf('PATCH', '/api/auth/me/username');
  const wrongPath = await f.request('/me/avatar-choice', {
    method: 'PATCH', body: JSON.stringify({ color: 'rose' }),
    headers: { 'X-CSRF-Token': wrongPathToken },
  });
  assert.equal(wrongPath.status, 403);

  const added = await f.mutate('/accounts/add', 'add', {
    email: f.email, password: 'correct horse battery staple', expectedGeneration: 1,
  });
  const wallet = await added.json();
  const staleToken = await f.mutationCsrf('PATCH', '/api/auth/me/avatar-choice');
  const second = wallet.accounts.find((account: { isActive: boolean }) => !account.isActive);
  const switched = await f.mutate('/accounts/switch', 'switch', {
    slotId: second.slotId, expectedGeneration: 2,
  });
  assert.equal(switched.status, 200);
  const stale = await f.request('/me/avatar-choice', {
    method: 'PATCH', body: JSON.stringify({ color: 'rose' }),
    headers: { 'X-CSRF-Token': staleToken },
  });
  assert.equal(stale.status, 403);
  assert.equal((await stale.json()).code, 'csrf_or_origin_rejected');
});

test('an async response cannot disclose the old account after a wallet switch', async () => {
  delayedReadStarted = Promise.withResolvers<void>();
  releaseDelayedRead = Promise.withResolvers<void>();
  const f = fixture();
  const added = await f.mutate('/accounts/add', 'add', {
    email: f.email, password: 'correct horse battery staple', expectedGeneration: 1,
  });
  const wallet = await added.json();
  const pending = fetch(`${origin}/api/auth-test/delayed-disclosure`, {
    headers: { Cookie: `__Host-nassaj_device=${f.device.secret}` },
  });
  await delayedReadStarted.promise;
  const second = wallet.accounts.find((account: { isActive: boolean }) => !account.isActive);
  const switched = await f.mutate('/accounts/switch', 'switch', {
    slotId: second.slotId, expectedGeneration: 2,
  });
  assert.equal(switched.status, 200);
  releaseDelayedRead.resolve();
  const response = await pending;
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.code, 'identity_changed');
  assert.equal(body.notStarted, false);
  assert.equal(body.effectState, 'outcome_unknown');
  assert.equal(body.privateValue, undefined);
});

test('bearer mutations remain independent of the cookie CSRF contract', async () => {
  const f = fixture();
  const user = userDb.getUserById(f.device.principal.userId);
  const response = await fetch(`${origin}/api/auth/me/avatar-choice`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${generateTokenForTest(user)}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ color: 'teal' }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).avatarUrl, 'color:teal');
});

test('direct document-style cookie writes pass through the shared mutation guard', async () => {
  const f = fixture();
  documentWrites = 0;
  const url = `${origin}/api/auth-test/document-write`;
  const headers = { Cookie: `__Host-nassaj_device=${f.device.secret}`, Origin: origin,
    'Content-Type': 'application/json' };
  const denied = await fetch(url, { method: 'POST', headers, body: '{}' });
  assert.equal(denied.status, 403);
  assert.equal(documentWrites, 0);
  const csrfResponse = await f.request(`/mutation-csrf?${new URLSearchParams({
    method: 'POST', path: '/api/auth-test/document-write',
  })}`);
  assert.equal(csrfResponse.status, 200);
  const csrfToken = (await csrfResponse.json()).csrfToken;
  const accepted = await fetch(url, {
    method: 'POST', headers: { ...headers, 'X-CSRF-Token': csrfToken }, body: '{}',
  });
  assert.equal(accepted.status, 201);
  assert.equal(documentWrites, 1);
});

test('switch closes old realtime identity; logout selects remaining account and device logout revokes cookie', async () => {
  const f = fixture();
  const added = await f.mutate('/accounts/add', 'add', {
    email: f.email, password: 'correct horse battery staple', expectedGeneration: 1,
  });
  const wallet = await added.json();
  const second = wallet.accounts.find((account: { isActive: boolean }) => !account.isActive);
  const current = deviceAccountSessionsDb.resolve(f.device.secret)!;
  const closed: unknown[] = [];
  const unregister = connectionRevocationRegistry.register({ close: (...args) => { closed.push(args); } }, current.principal);
  try {
    const switched = await f.mutate('/accounts/switch', 'switch', { slotId: second.slotId, expectedGeneration: 2 });
    assert.equal(switched.status, 200);
    assert.deepEqual(closed, [[4401, 'identity_revoked']]);
    assert.equal(connectionRevocationRegistry.isCurrent(current.principal), false);
    const logout = await f.mutate('/logout', 'logout', { expectedGeneration: 3 });
    assert.equal(logout.status, 200);
    assert.equal((await logout.json()).activeSlotId, f.device.wallet.activeSlotId);
    const all = await f.mutate('/logout-all', 'logout_all', { expectedGeneration: 4 });
    assert.equal(all.status, 204);
    assert.match(all.headers.get('set-cookie') ?? '', /__Host-nassaj_device=;/);
    assert.equal((await f.request('/accounts')).status, 401);
  } finally { unregister(); }
});

test('inactive removal is slot-bound and active removal cannot alter the wallet', async () => {
  const f = fixture();
  const added = await f.mutate('/accounts/add', 'add', {
    email: f.email, password: 'correct horse battery staple', expectedGeneration: 1,
  });
  const wallet = await added.json();
  const second = wallet.accounts.find((account: { isActive: boolean }) => !account.isActive);
  const active = wallet.activeSlotId;
  const rejected = await f.mutate(`/accounts/${active}`, `remove&slotId=${active}`, { expectedGeneration: 2 }, 'DELETE');
  assert.equal(rejected.status, 409);
  const removed = await f.mutate(`/accounts/${second.slotId}`, `remove&slotId=${second.slotId}`, { expectedGeneration: 2 }, 'DELETE');
  assert.equal(removed.status, 200);
  const remaining = await removed.json();
  assert.equal(remaining.accounts.length, 1);
  assert.equal(remaining.activeSlotId, active);
});

test('SSE receives identity_revoked and ends when the wallet generation changes', async () => {
  const f = fixture();
  const controller = new AbortController();
  try {
    const stream = await fetch(`${origin}/api/auth-test/events`, {
      // Production uses fetch streaming and need not send an SSE Accept header.
      headers: { Cookie: `__Host-nassaj_device=${f.device.secret}` },
      signal: controller.signal,
    });
    assert.equal(stream.status, 200);
    const body = stream.text();
    const added = await f.mutate('/accounts/add', 'add', {
      email: f.email, password: 'correct horse battery staple', expectedGeneration: 1,
    });
    assert.equal(added.status, 201);
    assert.equal(await body, 'data: {"type":"ready"}\n\nevent: identity_revoked\ndata: {}\n\n');
  } finally { controller.abort(); }
});

test('a device-bound HTTP stream is destroyed when its wallet generation changes', async () => {
  const f = fixture();
  const events = new EventEmitter();
  const response = {
    writableEnded: false,
    destroyed: false,
    once: (event: string, callback: () => void) => events.once(event, callback),
    destroy() { this.destroyed = true; events.emit('close'); },
  };
  assert.equal(bindDeviceHttpResponseLifetime({
    authenticationKind: 'device_session',
    deviceSessionId: f.device.principal.deviceSessionId,
    slotId: f.device.principal.slotId,
    deviceGeneration: f.device.principal.generation,
    userId: f.device.principal.userId,
    authorizationGeneration: f.device.principal.authorizationGeneration,
  }, response), true);
  const added = await f.mutate('/accounts/add', 'add', {
    email: f.email, password: 'correct horse battery staple', expectedGeneration: 1,
  });
  assert.equal(added.status, 201);
  assert.equal(response.destroyed, true);
});

test('reset login is password-change-only, then safely joins the existing wallet', async () => {
  const f = fixture();
  const target = userDb.getUserByUsername(f.email)!;
  const reset = await f.genericMutate(`/users/${target.id}/reset-password`, {});
  assert.equal(reset.status, 200);
  const { tempPassword } = await reset.json() as { tempPassword: string };

  const login = await fetch(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: {
      Cookie: `__Host-nassaj_device=${f.device.secret}`,
      Origin: origin,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ username: f.email, password: tempPassword }),
  });
  assert.equal(login.status, 200);
  const loginBody = await login.json();
  assert.equal(loginBody.passwordChangeRequired, true);
  assert.equal(loginBody.wallet, undefined);
  assert.equal(loginBody.token, undefined);
  const limitedValue = /__Host-nassaj_password_change=([^;]+)/u
    .exec(login.headers.get('set-cookie') ?? '')?.[1];
  assert.ok(limitedValue);
  const limitedCookie = `__Host-nassaj_password_change=${limitedValue}`;
  const limitedToken = decodeURIComponent(limitedValue);

  const limitedGeneral = await fetch(`${origin}/api/auth/me`, {
    headers: { Cookie: limitedCookie, Origin: origin },
  });
  assert.equal(limitedGeneral.status, 401);
  const bearerGeneral = await fetch(`${origin}/api/auth/me`, {
    headers: { Authorization: `Bearer ${limitedToken}`, Origin: origin },
  });
  assert.equal(bearerGeneral.status, 401);
  const refresh = await fetch(`${origin}/api/auth/refresh`, {
    method: 'POST', headers: { Authorization: `Bearer ${limitedToken}`, Origin: origin },
  });
  assert.equal(refresh.status, 401);
  assert.equal(authenticateWebSocketForTest(limitedToken), null);

  const existingGeneral = await fetch(`${origin}/api/auth/me`, {
    headers: {
      Cookie: `__Host-nassaj_device=${f.device.secret}; ${limitedCookie}`,
      Origin: origin,
    },
  });
  assert.equal(existingGeneral.status, 200);
  assert.equal((await existingGeneral.json()).id, f.device.principal.userId);

  const mutationTokenResponse = await fetch(`${origin}/api/auth/mutation-csrf?${new URLSearchParams({
    method: 'PATCH', path: '/api/auth/me/password',
  })}`, { headers: { Cookie: `__Host-nassaj_device=${f.device.secret}; ${limitedCookie}` } });
  assert.equal(mutationTokenResponse.status, 200);
  const mutationToken = (await mutationTokenResponse.json()).csrfToken;
  const changed = await fetch(`${origin}/api/auth/me/password`, {
    method: 'PATCH',
    headers: {
      Cookie: `__Host-nassaj_device=${f.device.secret}; ${limitedCookie}`,
      Origin: origin,
      'Content-Type': 'application/json',
      'X-CSRF-Token': mutationToken,
    },
    body: JSON.stringify({
      currentPassword: tempPassword,
      newPassword: 'permanent replacement password',
    }),
  });
  assert.equal(changed.status, 200);
  const changedBody = await changed.json();
  assert.equal(changedBody.wallet.accounts.length, 2);
  assert.equal(
    changedBody.wallet.accounts.find((account: { isActive: boolean }) => account.isActive)
      .displayName,
    f.email,
  );
  assert.equal(userDb.getRawById(target.id)?.must_change_password, 0);

  const normal = await f.request('/me');
  assert.equal(normal.status, 200);
  assert.equal((await normal.json()).id, target.id);
  const replay = await fetch(`${origin}/api/auth/me/password`, {
    method: 'PATCH',
    headers: { Cookie: limitedCookie, Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      currentPassword: 'permanent replacement password',
      newPassword: 'another replacement password',
    }),
  });
  assert.equal(replay.status, 401);
});

test('forced rotation on a fresh browser creates only a normal device cookie after password change', async () => {
  const f = fixture();
  const target = userDb.getUserByUsername(f.email)!;
  const reset = await f.genericMutate(`/users/${target.id}/reset-password`, {});
  assert.equal(reset.status, 200);
  const { tempPassword } = await reset.json();
  const login = await fetch(`${origin}/api/auth/login`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: f.email, password: tempPassword }),
  });
  assert.equal(login.status, 200);
  assert.equal((await login.json()).token, undefined);
  const limitedHeader = login.headers.get('set-cookie') ?? '';
  assert.match(limitedHeader, /HttpOnly/);
  assert.match(limitedHeader, /Secure/);
  assert.doesNotMatch(limitedHeader, /__Host-nassaj_device=/);
  const limitedCookie = limitedHeader.split(';')[0];
  const passwordBody = JSON.stringify({ currentPassword: tempPassword, newPassword: 'fresh browser password' });
  const tokenResponse = await fetch(`${origin}/api/auth/mutation-csrf?${new URLSearchParams({
    method: 'PATCH', path: '/api/auth/me/password',
  })}`, { headers: { Cookie: limitedCookie } });
  assert.equal(tokenResponse.status, 200);
  const csrfToken = (await tokenResponse.json()).csrfToken;
  const change = await fetch(`${origin}/api/auth/me/password`, {
    method: 'PATCH', headers: { Cookie: limitedCookie, Origin: origin,
      'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
    body: passwordBody,
  });
  assert.equal(change.status, 200);
  assert.equal((await change.json()).token, undefined);
  const device = /__Host-nassaj_device=([^;]+)/.exec(change.headers.get('set-cookie') ?? '')?.[1];
  assert.ok(device);
  const normal = await fetch(`${origin}/api/auth/me`, { headers: { Cookie: `__Host-nassaj_device=${device}` } });
  assert.equal(normal.status, 200);
  assert.equal((await normal.json()).id, target.id);
  const replay = await fetch(`${origin}/api/auth/me/password`, {
    method: 'PATCH', headers: { Cookie: limitedCookie, Origin: origin, 'Content-Type': 'application/json' },
    body: passwordBody,
  });
  assert.equal(replay.status, 401);
});

test('foreign slots and mixed authentication are rejected without changing either device', async () => {
  const f = fixture();
  const other = fixture();
  const response = await f.mutate('/accounts/switch', 'switch', {
    slotId: other.device.wallet.activeSlotId, expectedGeneration: 1,
  });
  assert.equal(response.status, 404);
  for (const route of ['/accounts', '/me']) {
    const ambiguous = await f.request(route, { headers: { Authorization: 'Bearer legacy-token' } });
    assert.equal(ambiguous.status, 400);
    assert.equal((await ambiguous.json()).code, 'ambiguous_authentication');
  }
  const ambiguousSse = await f.request('/me?token=legacy-token', {
    headers: { Accept: 'text/event-stream' },
  });
  assert.equal(ambiguousSse.status, 400);
  assert.equal((await ambiguousSse.json()).code, 'ambiguous_authentication');
  const malformedCookie = await fetch(`${origin}/api/auth/me`, {
    headers: { Cookie: '__Host-nassaj_device=%E0%A4%A' },
  });
  assert.equal(malformedCookie.status, 401);
  assert.equal((await malformedCookie.json()).code, 'device_session_invalid');
  const deviceRefresh = await f.request('/refresh', { method: 'POST' });
  assert.equal(deviceRefresh.status, 400);
  assert.equal((await deviceRefresh.json()).code, 'device_session_no_refresh');
  process.env.MULTI_ACCOUNT_SWITCHING = 'false';
  try {
    const user = userDb.getUserById(f.device.principal.userId);
    const legacy = await f.request('/me', {
      headers: { Authorization: `Bearer ${generateTokenForTest(user)}` },
    });
    assert.equal(legacy.status, 200);
    assert.equal((await legacy.json()).id, f.device.principal.userId);
  } finally {
    process.env.MULTI_ACCOUNT_SWITCHING = 'true';
  }
  assert.deepEqual(deviceAccountSessionsDb.snapshot(f.device.principal.deviceSessionId), f.device.wallet);
  assert.deepEqual(deviceAccountSessionsDb.snapshot(other.device.principal.deviceSessionId), other.device.wallet);
});

test('invalid credential inputs and generations fail before any wallet mutation', async () => {
  for (const payload of [
    {}, { email: null }, { email: '' }, { email: 'x'.repeat(321) },
    { email: "x' OR 1=1 --" }, { password: '' }, { password: 'x'.repeat(1025) },
    { expectedGeneration: -1 }, { expectedGeneration: 0 },
    { expectedGeneration: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    const f = fixture();
    const response = await f.mutate('/accounts/add', 'add', {
      email: f.email, password: 'wrong', expectedGeneration: 1, ...payload,
    });
    assert.equal(response.status, Object.keys(payload).length ? 400 : 401);
    assert.deepEqual(deviceAccountSessionsDb.snapshot(f.device.principal.deviceSessionId), f.device.wallet);
  }
});

test('last-account logout leaves no authenticated identity and old CSRF cannot be replayed', async () => {
  const f = fixture();
  const token = await f.csrf('logout');
  const response = await f.request('/logout', {
    method: 'POST', headers: { 'X-CSRF-Token': token }, body: '{"expectedGeneration":1}',
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).activeSlotId, null);
  assert.equal((await f.request('/me')).status, 401);
  const replay = await f.request('/logout', {
    method: 'POST', headers: { 'X-CSRF-Token': token }, body: '{"expectedGeneration":1}',
  });
  assert.equal(replay.status, 401);
});

test('concurrent adds commit only one generation and reject the losing request explicitly', async () => {
  const f = fixture();
  const token = await f.csrf('add');
  const options = {
    method: 'POST', headers: { 'X-CSRF-Token': token },
    body: JSON.stringify({ email: f.email, password: 'correct horse battery staple', expectedGeneration: 1 }),
  };
  const responses = await Promise.all([f.request('/accounts/add', options), f.request('/accounts/add', options)]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
  const loser = responses.find((response) => response.status === 409)!;
  assert.equal((await loser.json()).code, 'wallet_generation_conflict');
  const wallet = deviceAccountSessionsDb.snapshot(f.device.principal.deviceSessionId)!;
  assert.equal(wallet.generation, 2);
  assert.equal(wallet.accounts.length, 2);
  assert.equal(wallet.activeSlotId, f.device.wallet.activeSlotId);
});

test('disabled feature flag hides wallet endpoints without deleting the saved wallet', async () => {
  const f = fixture();
  process.env.MULTI_ACCOUNT_SWITCHING = 'false';
  try {
    assert.equal((await f.request('/accounts')).status, 404);
    assert.equal((await f.request('/accounts/add', { method: 'POST', body: '{}' })).status, 404);
    assert.deepEqual(deviceAccountSessionsDb.snapshot(f.device.principal.deviceSessionId), f.device.wallet);
  } finally { process.env.MULTI_ACCOUNT_SWITCHING = 'true'; }
});

test('IP quota applies even while the attacker changes both device and candidate', async () => {
  for (let attempt = 0; attempt < 101; attempt++) {
    const f = fixture();
    const response = await f.request('/accounts/add', {
      method: 'POST',
      headers: { 'X-CSRF-Token': await f.csrf('add'), 'CF-Connecting-IP': '198.51.100.73' },
      body: JSON.stringify({ email: f.email, password: '', expectedGeneration: 1 }),
    });
    assert.equal(response.status, attempt === 100 ? 429 : 400);
    if (attempt === 100) assert.equal((await response.json()).code, 'add_account_failed');
  }
});

test('disabled and reset-required candidates produce the same generic credential failure', async () => {
  for (const status of ['disabled', 'reset']) {
    const f = fixture();
    const candidate = userDb.getUserByUsername(f.email)!;
    if (status === 'disabled') userDb.setStatus(candidate.id, 'disabled');
    else userDb.resetPassword(candidate.id, passwordHash, Date.now() + 1000);
    const result = await f.mutate('/accounts/add', 'add', {
      email: f.email, password: 'correct horse battery staple', expectedGeneration: 1,
    });
    assert.equal(result.status, 401);
    assert.deepEqual(await result.json(), { error: 'Account could not be added', code: 'add_account_failed' });
    assert.deepEqual(deviceAccountSessionsDb.snapshot(f.device.principal.deviceSessionId), f.device.wallet);
  }
});

test('409 returns the winning tab active identity without replaying a stale switch', async () => {
  const f = fixture();
  const added = await f.mutate('/accounts/add', 'add', {
    email: f.email, password: 'correct horse battery staple', expectedGeneration: 1,
  });
  const wallet = await added.json();
  const second = wallet.accounts.find((account: { isActive: boolean }) => !account.isActive);
  const winning = await f.mutate('/accounts/switch', 'switch', { slotId: second.slotId, expectedGeneration: 2 });
  assert.equal(winning.status, 200);
  const stale = await f.mutate('/accounts/switch', 'switch', {
    slotId: f.device.principal.slotId, expectedGeneration: 2,
  });
  assert.equal(stale.status, 409);
  const conflict = await stale.json();
  assert.equal(conflict.code, 'wallet_generation_conflict');
  assert.equal(conflict.wallet.activeSlotId, second.slotId);
  assert.equal(conflict.wallet.generation, 3);
  assert.equal(deviceAccountSessionsDb.resolve(f.device.secret)?.principal.slotId, second.slotId);
});

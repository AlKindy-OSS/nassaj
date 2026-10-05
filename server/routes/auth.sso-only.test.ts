/**
 * T-1939 slice 2 — SSO-only local-credential gates on the auth router, with
 * every side-effecting dependency mocked (same harness as auth.login-timing).
 * The live-database path is covered in auth.account-wallet.integration.test.ts.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test, { after, mock } from 'node:test';
import { pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';

import { createSsoConfigDouble } from '../services/__tests__/sso-config-double.js';

const passThrough = (_req: unknown, _res: unknown, next: () => void) => next();
const url = (spec: string) => pathToFileURL(path.resolve(import.meta.dirname, spec)).href;

const verifyCalls: unknown[] = [];
let verifyResult = false;
let userRow: Record<string, unknown> | null = null;
const linkedUserIds = new Set<number>();
const audits: Array<{ action: string; metadata?: unknown }> = [];
const inviteCalls: string[] = [];
const sso = createSsoConfigDouble({ enforced: false, loginAvailable: false });

class MockInviteError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

mock.module(url('../services/sso-config.service.js'), { namedExports: sso.exports });
mock.module(url('../modules/database/index.js'), {
  namedExports: {
    userDb: { getUserByLoginIdentifier: () => userRow, updateLastLogin: () => {} },
    auditLogDb: { record: (action: string, data: { metadata?: unknown }) => audits.push({ action, ...data }) },
    userIdentitiesDb: { hasAnyLink: (userId: number) => linkedUserIds.has(userId) },
    invitesDb: {},
    appConfigDb: {},
    localModelServersDb: {},
  },
});
mock.module(url('../modules/account-wallet/index.js'), {
  namedExports: { AccountWalletService: class {} },
});
mock.module(url('../middleware/auth.js'), {
  namedExports: {
    generateToken: () => 'test-jwt',
    authenticateToken: (req: { user?: unknown }, _res: unknown, next: () => void) => {
      req.user = { id: 1, role: 'owner' };
      next();
    },
    requireRole: () => passThrough,
    invalidateRefreshCache: () => {},
    verifyTokenAllowingRecentExpiry: () => ({ ok: false, reason: 'invalid' }),
    REFRESH_GRACE_MS: 0,
  },
});
mock.module(url('../middleware/rate-limit.js'), {
  namedExports: { createRateLimiter: () => passThrough },
});
mock.module(url('../services/password.service.js'), {
  namedExports: {
    verifyPassword: async (hash: unknown) => {
      verifyCalls.push(hash);
      return verifyResult;
    },
    needsRehash: () => false,
    hashPassword: async () => '$argon2id$stub',
  },
});
mock.module(url('../services/invite.service.js'), {
  namedExports: {
    createInvite: async () => {
      inviteCalls.push('create');
      return { token: 'invite-token' };
    },
    acceptInvite: async () => {
      inviteCalls.push('accept');
      return { id: 30, username: 'joined', role: 'user' };
    },
    InviteError: MockInviteError,
  },
});
mock.module(url('../utils/client-ip.js'), { namedExports: { clientIp: () => '127.0.0.1' } });
mock.module(url('../modules/connectors/connector-owner-auth-session.js'), {
  namedExports: {
    recordConnectorOwnerAuthentication: () => undefined,
    clearConnectorOwnerAuthentication: () => undefined,
  },
});
mock.module(url('./webauthn.js'), { defaultExport: express.Router() });
mock.module(url('./oidc.js'), { defaultExport: express.Router() });

const { default: authRouter } = await import('./auth.js');
const app = express();
app.use(express.json());
app.use('/api/auth', authRouter);
const server: Server = app.listen(0);
await new Promise<void>((resolve) => server.once('listening', resolve));
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const post = (route: string, body: unknown) => fetch(`${baseUrl}/api/auth${route}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/** Runs with the SSO policy enforced (ADR-194 D1) or not; login availability does not matter here. */
async function withSsoPolicy(enforced: boolean, run: () => Promise<void>) {
  sso.state.enforced = enforced;
  sso.state.loginAvailable = false;
  try { await run(); } finally {
    sso.state.enforced = false;
  }
}

function reset(row: Record<string, unknown> | null, passwordOk: boolean) {
  userRow = row;
  verifyResult = passwordOk;
  verifyCalls.length = 0;
  audits.length = 0;
  inviteCalls.length = 0;
  linkedUserIds.clear();
}

const MEMBER = { id: 12, username: 'member', role: 'user', password_hash: '$argon2id$member' };
const OWNER = { id: 1, username: 'owner', role: 'owner', password_hash: '$argon2id$owner' };

test('T-1939: a linked member with the right password gets 403 sso_required, no token', async () => {
  reset(MEMBER, true);
  linkedUserIds.add(12);
  await withSsoPolicy(true, async () => {
    const res = await post('/login', { username: 'member', password: 'right' });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.code, 'sso_required');
    assert.equal(body.token, undefined);
    assert.deepEqual(verifyCalls, ['$argon2id$member'], 'the password is fully verified first');
    assert.deepEqual(audits.map((entry) => entry.action), ['sso_required_denied']);
    assert.deepEqual(audits[0]?.metadata, { entry: 'password_login' });
  });
});

test('T-1939: a wrong password on a linked member stays the generic 401 (no linkage oracle)', async () => {
  reset(MEMBER, false);
  linkedUserIds.add(12);
  await withSsoPolicy(true, async () => {
    const res = await post('/login', { username: 'member', password: 'wrong' });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: 'Invalid username or password' });
  });
});

test('T-1939: the owner (linked or not) and unlinked members keep password login', async () => {
  await withSsoPolicy(true, async () => {
    reset(OWNER, true);
    linkedUserIds.add(1);
    assert.equal((await post('/login', { username: 'owner', password: 'right' })).status, 200);
    reset(MEMBER, true);
    assert.equal((await post('/login', { username: 'member', password: 'right' })).status, 200);
  });
});

test('T-1939: SSO policy off — a linked member logs in with a password exactly as before', async () => {
  reset(MEMBER, true);
  linkedUserIds.add(12);
  await withSsoPolicy(false, async () => {
    const res = await post('/login', { username: 'member', password: 'right' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).token, 'test-jwt');
  });
});

test('T-1939: with the SSO policy enforced invites neither accept nor create local-password accounts', async () => {
  reset(null, false);
  await withSsoPolicy(true, async () => {
    const accept = await post('/invite/accept', { token: 't', username: 'newbie', password: 'password123' });
    assert.equal(accept.status, 403);
    assert.equal((await accept.json()).code, 'sso_required_for_new_accounts');
    const create = await post('/invites', { role: 'user' });
    assert.equal(create.status, 403);
    assert.equal((await create.json()).code, 'sso_required_for_new_accounts');
    assert.deepEqual(inviteCalls, [], 'the invite service is never reached');
    assert.deepEqual(audits.map((entry) => entry.metadata), [{ entry: 'invite_accept' }, { entry: 'invite_create' }]);
  });
});

test('T-1939: SSO policy off — invites are created and accepted as before', async () => {
  reset(null, false);
  await withSsoPolicy(false, async () => {
    assert.equal((await post('/invites', { role: 'user' })).status, 201);
    const accept = await post('/invite/accept', { token: 't', username: 'newbie', password: 'password123' });
    assert.equal(accept.status, 200);
    assert.equal((await accept.json()).token, 'test-jwt');
    assert.deepEqual(inviteCalls, ['create', 'accept']);
  });
});

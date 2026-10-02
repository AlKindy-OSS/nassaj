/**
 * PATCH /me/username uses the shared username policy (T-1939 slice 4, qa
 * follow-up): a case-insensitive clash with any account (any status) or a
 * reserved name is refused; the caller's own case change is allowed. The
 * database is an in-memory fake behind the real services/username-policy.js.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test, { after, beforeEach, mock } from 'node:test';
import { pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';

const passThrough = (_req: unknown, _res: unknown, next: () => void) => next();
const url = (spec: string) => pathToFileURL(path.resolve(import.meta.dirname, spec)).href;

// id → username, including a disabled account (status is irrelevant to clashes).
const usernames = new Map<number, string>();
const renames: Array<{ id: number; username: string }> = [];
const audits: string[] = [];

mock.module(url('../modules/database/index.js'), {
  namedExports: {
    userDb: {
      isUsernameTaken: (name: string, excludeUserId: number | null) => [...usernames]
        .some(([id, held]) => id !== excludeUserId && held.toLowerCase() === name.toLowerCase()),
      setUsername: (id: number, username: string) => {
        renames.push({ id, username });
        usernames.set(id, username);
      },
    },
    auditLogDb: { record: (action: string) => audits.push(action) },
    userIdentitiesDb: {},
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
      req.user = { id: 12, role: 'user', username: usernames.get(12) };
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
mock.module(url('../utils/client-ip.js'), { namedExports: { clientIp: () => '127.0.0.1' } });
mock.module(url('../modules/connectors/connector-owner-auth-session.js'), {
  namedExports: {
    recordConnectorOwnerAuthentication: () => undefined,
    clearConnectorOwnerAuthentication: () => undefined,
    // ADR-194: auth.js -> sso-config.service -> database/connection pulls the
    // connector substrate, which links these two names at import time.
    configureConnectorOwnerAuthSessionProduction: () => undefined,
    createRecentAuthOriginSource: () => () => null,
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

beforeEach(() => {
  usernames.clear();
  usernames.set(1, 'the_owner');
  usernames.set(12, 'Member_Twelve');
  usernames.set(30, 'Disabled_Sara');
  renames.length = 0;
  audits.length = 0;
});

const rename = (username: unknown) => fetch(`${baseUrl}/api/auth/me/username`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username }),
});

test('a case-insensitive clash with another account (any status) is 409, nothing written', async () => {
  for (const name of ['disabled_sara', 'DISABLED_SARA', 'The_Owner']) {
    const res = await rename(name);
    assert.equal(res.status, 409, name);
    assert.equal((await res.json()).error, 'Username already taken');
  }
  assert.deepEqual(renames, []);
});

test('reserved names are refused with the same generic 409', async () => {
  for (const name of ['admin', 'Owner', 'administrator', 'SuperUser', 'guest', 'user', 'null', 'undefined']) {
    assert.equal((await rename(name)).status, 409, name);
  }
  assert.deepEqual(renames, []);
});

test('the caller may change the case of their own name, and take a free name', async () => {
  let res = await rename('member_twelve');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { success: true, username: 'member_twelve' });
  res = await rename('fresh_name');
  assert.equal(res.status, 200);
  assert.deepEqual(renames, [{ id: 12, username: 'member_twelve' }, { id: 12, username: 'fresh_name' }]);
  assert.deepEqual(audits, ['username_changed', 'username_changed']);
});

test('the pattern is still enforced before the policy', async () => {
  for (const name of ['ab', 'with space', 'x'.repeat(33), 42]) {
    assert.equal((await rename(name)).status, 400);
  }
  assert.deepEqual(renames, []);
});

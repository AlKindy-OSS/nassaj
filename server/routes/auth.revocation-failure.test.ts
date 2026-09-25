/** B-1327 (T4): a failing live revocation never skips the audit or fails the response. */
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test, { after, mock } from 'node:test';
import { pathToFileURL } from 'node:url';

import express from 'express';

const url = (spec: string) => pathToFileURL(path.resolve(import.meta.dirname, spec)).href;
const passThrough = (req: any, _res: unknown, next: () => void) => {
  req.user ??= { id: 1, role: 'owner' };
  next();
};

const audits: string[] = [];
const revocations: unknown[] = [];
const target = { id: 7, role: 'admin', status: 'active', username: 'member' };

mock.module(url('../modules/database/index.js'), {
  namedExports: {
    userDb: {
      getRawById: (id: number) => (id === target.id ? { ...target } : null),
      getOwnerCount: () => 1,
      setRole: (_id: number, role: string) => { target.role = role; },
      setStatus: (_id: number, status: string) => { target.status = status; },
      listUsers: () => [],
    },
    deviceAccountSessionsDb: { deviceSessionIdsForUser: () => ['device-7'] },
    auditLogDb: { record: (event: string) => { audits.push(event); } },
    invitesDb: { list: () => [] },
  },
});
mock.module(url('../modules/account-wallet/index.js'), {
  namedExports: {
    AccountWalletService: class {
      revokeUser(userId: number, devices: string[], revocation: unknown): never {
        revocations.push({ userId, devices, revocation });
        throw new Error('realtime layer exploded');
      }
    },
  },
});
mock.module(url('../middleware/auth.js'), {
  namedExports: {
    generateToken: () => 'jwt',
    authenticateToken: passThrough,
    requireRole: () => passThrough,
    invalidateRefreshCache: () => {},
    verifyTokenAllowingRecentExpiry: () => ({ ok: false }),
    REFRESH_GRACE_MS: 0,
  },
});
mock.module(url('../middleware/rate-limit.js'), { namedExports: { createRateLimiter: () => passThrough } });
mock.module(url('../services/password.service.js'), {
  namedExports: { verifyPassword: async () => false, needsRehash: () => false, hashPassword: async () => 'hash' },
});
mock.module(url('../services/invite.service.js'), {
  namedExports: { createInvite: async () => ({}), acceptInvite: async () => ({}), InviteError: class extends Error {} },
});
mock.module(url('../services/isolation/provision-user-dirs.js'), {
  namedExports: { userConfigDir: () => '/var/tmp/unreachable-user-dir' },
});
mock.module(url('../utils/client-ip.js'), { namedExports: { clientIp: () => '127.0.0.1' } });
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

const patch = (route: string, body: object) => fetch(`${baseUrl}/api/auth${route}`, {
  method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

test('role downgrade and disable still answer 200 and audit when revocation throws', async () => {
  const role = await patch('/users/7/role', { role: 'user' });
  assert.equal(role.status, 200);
  const status = await patch('/users/7/status', { status: 'disabled' });
  assert.equal(status.status, 200);
  assert.deepEqual(audits, ['role_changed', 'user_disabled']);
  assert.deepEqual(revocations, [
    { userId: 7, devices: ['device-7'], revocation: { abortReason: 'role_changed', endInteractiveSessions: true } },
    { userId: 7, devices: ['device-7'], revocation: { abortReason: 'account_disabled', endInteractiveSessions: true } },
  ]);
});

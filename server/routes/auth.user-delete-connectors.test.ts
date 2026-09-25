/** User deletion must stop before connector/database/filesystem lifecycle loss. */
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

let deleteCalls = 0;
let cleanupCalls = 0;

mock.module(url('../modules/database/index.js'), {
  namedExports: {
    userDb: {
      getRawById: (id: number) => id === 7 ? { id, role: 'user', status: 'active' } : null,
      getOwnerCount: () => 1,
      deleteUser: () => { deleteCalls += 1; return true; },
      listUsers: () => [],
    },
    auditLogDb: { record: () => {} },
    invitesDb: { list: () => [] },
  },
});
mock.module(url('../modules/account-wallet/index.js'), {
  namedExports: { AccountWalletService: class { revokeDevices(): void {} revokeUser(): void {} } },
});
mock.module(url('../modules/connectors/index.js'), {
  namedExports: {
    connectorsService: {
      assertUserDeletionAllowed: () => {
        const error = new Error('Connector lifecycle required') as Error & { code?: string };
        error.code = 'CONNECTOR_LIFECYCLE_REQUIRED';
        throw error;
      },
      remove: async () => { cleanupCalls += 1; },
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
mock.module(url('../middleware/rate-limit.js'), {
  namedExports: { createRateLimiter: () => passThrough },
});
mock.module(url('../services/password.service.js'), {
  namedExports: {
    verifyPassword: async () => false,
    needsRehash: () => false,
    hashPassword: async () => 'hash',
  },
});
class MockInviteError extends Error { status = 400; }
mock.module(url('../services/invite.service.js'), {
  namedExports: {
    createInvite: async () => ({}),
    acceptInvite: async () => ({}),
    InviteError: MockInviteError,
  },
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

test('DELETE /users/:id returns stable 409 before deleting user, connector, or configs', async () => {
  const response = await fetch(`${baseUrl}/api/auth/users/7`, { method: 'DELETE' });
  assert.equal(response.status, 409);
  const body = await response.json() as { code?: string };
  assert.equal(body.code, 'CONNECTOR_LIFECYCLE_REQUIRED');
  assert.equal(deleteCalls, 0, 'the user row remains');
  assert.equal(cleanupCalls, 0, 'no connector cleanup/removal is attempted');
});

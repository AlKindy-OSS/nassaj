import assert from 'node:assert/strict';
import path from 'node:path';
import test, { after, mock } from 'node:test';
import { pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';

const url = (spec: string) => pathToFileURL(path.resolve(import.meta.dirname, spec)).href;
const passThrough = (_req: unknown, _res: unknown, next: () => void) => next();
const emptyRouter = express.Router();

let hasUsersResult = true;

// Mock only the heavy transitive deps of auth.js; oidc-config.js is the REAL
// module so /status exercises the same oidcEnabled() predicate the OIDC routes use.
mock.module(url('../modules/database/index.js'), {
  namedExports: {
    userDb: { hasUsers: async () => hasUsersResult },
    auditLogDb: { record: () => {} },
    invitesDb: {},
  },
});
mock.module(url('../middleware/auth.js'), {
  namedExports: {
    generateToken: () => 'jwt',
    authenticateToken: passThrough,
    requireRole: () => passThrough,
    invalidateRefreshCache: () => {},
    verifyTokenAllowingRecentExpiry: () => null,
    REFRESH_GRACE_MS: 0,
  },
});
mock.module(url('../middleware/rate-limit.js'), { namedExports: { createRateLimiter: () => passThrough } });
mock.module(url('../services/password.service.js'), {
  namedExports: { verifyPassword: async () => false, needsRehash: () => false, hashPassword: async () => 'h' },
});
mock.module(url('../services/invite.service.js'), {
  namedExports: { createInvite: () => {}, acceptInvite: () => {}, InviteError: class extends Error {} },
});
mock.module(url('../utils/client-ip.js'), { namedExports: { clientIp: () => '127.0.0.1' } });
mock.module(url('../services/isolation/provision-user-dirs.js'), {
  namedExports: { userConfigDir: () => '/tmp/none' },
});
mock.module(url('../modules/connectors/connector-owner-auth-session.js'), {
  namedExports: { clearConnectorOwnerAuthentication: () => {}, recordConnectorOwnerAuthentication: () => {} },
});
mock.module(url('./webauthn.js'), { defaultExport: emptyRouter });
mock.module(url('./oidc.js'), { defaultExport: emptyRouter });

// Neutral baseline; each test sets the OIDC env it needs.
delete process.env.OIDC_ENABLED;
delete process.env.OIDC_ROLE_PROJECT_ID;

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

async function status() {
  const res = await fetch(`${baseUrl}/api/auth/status`);
  assert.equal(res.status, 200);
  return res.json() as Promise<Record<string, unknown>>;
}

test('/status exposes oidcEnabled=false when OIDC is disabled', async () => {
  delete process.env.OIDC_ENABLED;
  delete process.env.OIDC_ROLE_PROJECT_ID;
  assert.deepEqual(await status(), { needsSetup: false, isAuthenticated: false, oidcEnabled: false });
});

test('/status reports oidcEnabled=false when enabled but role project id is missing/invalid (fail-closed)', async () => {
  process.env.OIDC_ENABLED = 'true';
  delete process.env.OIDC_ROLE_PROJECT_ID;
  assert.equal((await status()).oidcEnabled, false, 'missing project id');

  process.env.OIDC_ROLE_PROJECT_ID = 'has space';
  assert.equal((await status()).oidcEnabled, false, 'invalid project id');
});

test('/status reports oidcEnabled=true only when enabled AND scoped to a valid project id', async () => {
  process.env.OIDC_ENABLED = 'true';
  process.env.OIDC_ROLE_PROJECT_ID = 'proj-1';
  assert.equal((await status()).oidcEnabled, true);
});

test('/status still reflects needsSetup and leaks no other OIDC config', async () => {
  hasUsersResult = false;
  process.env.OIDC_ENABLED = 'true';
  process.env.OIDC_ROLE_PROJECT_ID = 'proj-1';
  const body = await status();
  assert.deepEqual(body, { needsSetup: true, isAuthenticated: false, oidcEnabled: true });
  assert.deepEqual(Object.keys(body).sort(), ['isAuthenticated', 'needsSetup', 'oidcEnabled']);
  hasUsersResult = true;
});

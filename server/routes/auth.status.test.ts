import assert from 'node:assert/strict';
import path from 'node:path';
import test, { after, mock } from 'node:test';
import { pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';

import { createSsoConfigDouble } from '../services/__tests__/sso-config-double.js';

const url = (spec: string) => pathToFileURL(path.resolve(import.meta.dirname, spec)).href;
const passThrough = (_req: unknown, _res: unknown, next: () => void) => next();
const emptyRouter = express.Router();

let hasUsersResult = true;
let hasUsersError = false;
const sso = createSsoConfigDouble({ enforced: false, loginAvailable: false });
let ssoStateResult = 'off';

// Mock only the heavy transitive deps of auth.js. The SSO state model has its
// own matrix tests (sso-config.service.test.ts); here only the field wiring.
mock.module(url('../services/sso-config.service.js'), {
  namedExports: { ...sso.exports, ssoState: () => ssoStateResult },
});
mock.module(url('../modules/database/index.js'), {
  namedExports: {
    userDb: { hasUsers: async () => {
      if (hasUsersError) throw new Error('status fixture failure');
      return hasUsersResult;
    } },
    auditLogDb: { record: () => {} },
    invitesDb: {},
  },
});
mock.module(url('../modules/account-wallet/index.js'), {
  namedExports: { AccountWalletService: class {} },
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

delete process.env.MULTI_ACCOUNT_SWITCHING;

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

test('/status preserves its generic error response', async () => {
  hasUsersError = true;
  const res = await fetch(`${baseUrl}/api/auth/status`);
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: 'Internal server error' });
  hasUsersError = false;
});

test('/status reports SSO off with the login button hidden', async () => {
  ssoStateResult = 'off';
  assert.deepEqual(await status(), {
    needsSetup: false,
    isAuthenticated: false,
    ssoState: 'off',
    ssoLoginAvailable: false,
    deviceAccountSessionsEnabled: false,
  });
});

test('/status exposes the exact device-account-session route gate', async () => {
  process.env.MULTI_ACCOUNT_SWITCHING = 'true';
  assert.equal((await status()).deviceAccountSessionsEnabled, true);

  process.env.MULTI_ACCOUNT_SWITCHING = 'false';
  assert.equal((await status()).deviceAccountSessionsEnabled, false);

  process.env.MULTI_ACCOUNT_SWITCHING = '1';
  assert.equal((await status()).deviceAccountSessionsEnabled, false);
  delete process.env.MULTI_ACCOUNT_SWITCHING;
});

test('/status offers SSO login only in the active state (ADR-194 D1)', async () => {
  for (const [state, available] of [['active', true], ['unavailable', false], ['paused', false], ['off', false]] as const) {
    ssoStateResult = state;
    const body = await status();
    assert.equal(body.ssoState, state);
    assert.equal(body.ssoLoginAvailable, available, state);
  }
  ssoStateResult = 'off';
});

test('/status still reflects needsSetup and leaks no other SSO config', async () => {
  hasUsersResult = false;
  ssoStateResult = 'active';
  process.env.MULTI_ACCOUNT_SWITCHING = 'true';
  const body = await status();
  assert.deepEqual(body, {
    needsSetup: true,
    isAuthenticated: false,
    ssoState: 'active',
    ssoLoginAvailable: true,
    deviceAccountSessionsEnabled: true,
  });
  assert.deepEqual(Object.keys(body).sort(), [
    'deviceAccountSessionsEnabled', 'isAuthenticated', 'needsSetup', 'ssoLoginAvailable', 'ssoState',
  ]);
  ssoStateResult = 'off';
  delete process.env.MULTI_ACCOUNT_SWITCHING;
  hasUsersResult = true;
});

import assert from 'node:assert/strict';
import path from 'node:path';
import test, { mock } from 'node:test';
import { pathToFileURL } from 'node:url';

import express from 'express';

import { createSsoConfigDouble } from '../services/__tests__/sso-config-double.js';

const url = (spec: string) => pathToFileURL(path.resolve(import.meta.dirname, spec)).href;
const passThrough = (_req: unknown, _res: unknown, next: () => void) => next();
const records: Array<{ userId: number; method: string }> = [];
const audits: Array<{ action: string; metadata?: unknown }> = [];
const linkedUserIds = new Set<number>();
let assertedUser = { id: 7, username: 'owner', role: 'owner' };
const sso = createSsoConfigDouble({ enforced: false, loginAvailable: false });

class MockWebAuthnError extends Error {}

mock.module(url('../services/sso-config.service.js'), { namedExports: sso.exports });
mock.module(url('../middleware/auth.js'), {
  namedExports: { authenticateToken: passThrough, generateToken: () => 'passkey-jwt' },
});
mock.module(url('../middleware/rate-limit.js'), {
  namedExports: { createRateLimiter: () => passThrough },
});
mock.module(url('../modules/database/index.js'), {
  namedExports: {
    auditLogDb: { record: (action: string, data: { metadata?: unknown }) => audits.push({ action, ...data }) },
    userDb: { updateLastLogin: () => undefined },
    userIdentitiesDb: { hasAnyLink: (userId: number) => linkedUserIds.has(userId) },
    webauthnCredentialsDb: {},
  },
});
mock.module(url('../utils/client-ip.js'), {
  namedExports: { clientIp: () => '127.0.0.1' },
});
mock.module(url('../services/webauthn.service.js'), {
  namedExports: {
    WebAuthnError: MockWebAuthnError,
    createAuthenticationOptions: async () => ({}),
    createRegistrationOptions: async () => ({}),
    verifyAuthentication: async () => ({
      user: assertedUser, credentialId: 'credential-1', userVerified: true, stepUpEligible: true,
    }),
    createStepUpOptions: async () => ({}),
    verifyRegistration: async () => ({}),
  },
});
mock.module(url('../services/step-up.service.js'), {
  namedExports: {
    STEP_UP_AUDIENCES: ['passkey_registration', 'connector_owner'],
    StepUpError: class extends Error {},
    verifyStepUpEvidence: async () => ({ authMethod: 'password', authTimeMs: 0 }),
  },
});
mock.module(url('../modules/connectors/connector-owner-auth-session.js'), {
  namedExports: {
    recordConnectorOwnerAuthentication: (_res: unknown, userId: number, method: string) => {
      records.push({ userId, method });
    },
  },
});

const { default: router } = await import('./webauthn.js');

test('successful WebAuthn verification records verifier-time recent authentication', async () => {
  const app = express();
  app.use(express.json());
  app.use('/webauthn', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/webauthn/login/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ response: { id: 'credential-1' } }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(records, [{ userId: 7, method: 'webauthn' }]);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

async function verifyPasskey() {
  const app = express();
  app.use(express.json());
  app.use('/webauthn', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/webauthn/login/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ response: { id: 'credential-1' } }),
    });
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

/** Runs with the SSO policy enforced (ADR-194 D1) or not. */
async function withSsoPolicy(enforced: boolean, run: () => Promise<void>) {
  sso.setActive(enforced);
  try { await run(); } finally {
    sso.setActive(false);
  }
}

test('T-1939: with the SSO policy enforced a linked member passkey is refused with sso_required, no session', async () => {
  records.length = 0;
  audits.length = 0;
  assertedUser = { id: 21, username: 'member', role: 'user' };
  linkedUserIds.add(21);
  await withSsoPolicy(true, async () => {
    const { status, body } = await verifyPasskey();
    assert.equal(status, 403);
    assert.equal(body.code, 'sso_required');
    assert.equal(body.token, undefined);
    assert.deepEqual(records, [], 'no recent-authentication record');
    assert.ok(!audits.some((entry) => entry.action === 'login_success'));
    assert.deepEqual(audits.find((entry) => entry.action === 'sso_required_denied')?.metadata,
      { entry: 'passkey_login' });
  });
});

test('T-1939: a linked owner and any user with the SSO policy off keep passkey login', async () => {
  linkedUserIds.add(7);
  linkedUserIds.add(21);
  await withSsoPolicy(true, async () => {
    assertedUser = { id: 7, username: 'owner', role: 'owner' };
    assert.equal((await verifyPasskey()).status, 200);
  });
  await withSsoPolicy(false, async () => {
    assertedUser = { id: 21, username: 'member', role: 'user' };
    const { status, body } = await verifyPasskey();
    assert.equal(status, 200);
    assert.equal(body.token, 'passkey-jwt');
  });
});

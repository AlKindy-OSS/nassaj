import assert from 'node:assert/strict';
import path from 'node:path';
import test, { mock } from 'node:test';
import { pathToFileURL } from 'node:url';

import express from 'express';

const url = (spec: string) => pathToFileURL(path.resolve(import.meta.dirname, spec)).href;
const passThrough = (_req: unknown, _res: unknown, next: () => void) => next();
const records: Array<{ userId: number; method: string }> = [];

class MockWebAuthnError extends Error {}

mock.module(url('../middleware/auth.js'), {
  namedExports: { authenticateToken: passThrough, generateToken: () => 'passkey-jwt' },
});
mock.module(url('../middleware/rate-limit.js'), {
  namedExports: { createRateLimiter: () => passThrough },
});
mock.module(url('../modules/database/index.js'), {
  namedExports: {
    auditLogDb: { record: () => undefined },
    userDb: { updateLastLogin: () => undefined },
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
      user: { id: 7, username: 'owner', role: 'owner' }, credentialId: 'credential-1',
    }),
    verifyRegistration: async () => ({}),
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

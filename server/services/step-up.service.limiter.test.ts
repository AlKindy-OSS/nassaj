/**
 * B-1407 ordering guarantee: the per-user step-up limiter counts the attempt
 * BEFORE any argon2 work, so a throttled caller costs the server nothing, and
 * refusals decided earlier (SSO-linked member, missing evidence) never reach
 * the password hash at all.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test, { mock } from 'node:test';
import { pathToFileURL } from 'node:url';

import { createSsoConfigDouble } from './__tests__/sso-config-double.js';

const url = (spec: string) => pathToFileURL(path.resolve(import.meta.dirname, spec)).href;
const verifyCalls: string[] = [];
const linked = new Set<number>();
const sso = createSsoConfigDouble({ enforced: false, loginAvailable: false });
const users = new Map<number, { id: number; role: string; must_change_password: number }>([
  [1, { id: 1, role: 'user', must_change_password: 0 }],
  [2, { id: 2, role: 'user', must_change_password: 0 }],
]);

mock.module(url('./password.service.js'), {
  namedExports: {
    verifyPassword: async (_hash: string, password: string) => {
      verifyCalls.push(password);
      return password === 'right';
    },
  },
});
mock.module(url('./sso-config.service.js'), { namedExports: sso.exports });
mock.module(url('../modules/database/index.js'), {
  namedExports: {
    userDb: {
      getUserById: (id: number) => users.get(id),
      getRawById: (id: number) => (users.has(id) ? { id, password_hash: 'h' } : undefined),
    },
    userIdentitiesDb: { hasAnyLink: (id: number) => linked.has(id) },
    webauthnCredentialsDb: {},
  },
});

const { verifyStepUpEvidence } = await import('./step-up.service.js');

const attempt = (userId: number, password: string) =>
  verifyStepUpEvidence({} as never, { id: userId }, 'passkey_registration', { method: 'password', password })
    .then(() => 'ok', (error: { code: string }) => error.code);

test('the limiter refuses the 6th attempt before argon2 runs', async () => {
  for (let index = 0; index < 5; index += 1) {
    assert.equal(await attempt(1, `wrong-${index}`), 'step_up_failed');
  }
  assert.equal(verifyCalls.length, 5);
  assert.equal(await attempt(1, 'right'), 'step_up_rate_limited');
  assert.equal(verifyCalls.length, 5, 'no argon2 verification once throttled');
  // Another user has an independent bucket.
  assert.equal(await attempt(2, 'right'), 'ok');
});

test('SSO-linked member and missing evidence are refused without touching the password hash', async () => {
  verifyCalls.length = 0;
  sso.setActive(true);
  try {
    linked.add(2);
    assert.equal(await attempt(2, 'right'), 'sso_step_up_required');
    const missing = await verifyStepUpEvidence({} as never, { id: 2 }, 'connector_owner', undefined)
      .then(() => 'ok', (error: { code: string }) => error.code);
    assert.equal(missing, 'sso_step_up_required');
  } finally {
    sso.setActive(false);
  }
  linked.delete(2);
  const none = await verifyStepUpEvidence({} as never, { id: 2 }, 'connector_owner', undefined)
    .then(() => 'ok', (error: { code: string }) => error.code);
  assert.equal(none, 'step_up_required');
  assert.deepEqual(verifyCalls, []);
});

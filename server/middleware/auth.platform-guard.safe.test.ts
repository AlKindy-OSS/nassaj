/**
 * B-186 — the acknowledged, loopback-bound platform configuration (the only one
 * the boot guard permits) plus the full guard matrix.
 *
 * Companion to auth.platform-guard.test.ts (which covers the refusal). Here the
 * module DOES load, so the exported pure guard is reachable and every branch can
 * be exercised with injected inputs. The last test documents, rather than
 * asserts as desirable, what the acknowledgement actually buys: a request with
 * NO token is still served as the first user — which is exactly why enabling the
 * flag must be a loud, deliberate act.
 *
 * Framework: node:test module mocking (--experimental-test-module-mocks).
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test, { mock } from 'node:test';
import { pathToFileURL } from 'node:url';

const url = (spec: string) => pathToFileURL(path.resolve(import.meta.dirname, spec)).href;

delete process.env.JWT_SECRET;

// The literal contract is pinned here on purpose: a silent rename of the ack
// value would otherwise let an old, already-acknowledged deployment keep booting
// (or a new one fail confusingly).
const ACK_ENV = 'PLATFORM_MODE_UNAUTHENTICATED_ACK';
const ACK_VALUE = 'i-accept-every-request-runs-as-the-first-user';

process.env[ACK_ENV] = ACK_VALUE;
process.env.HOST = '127.0.0.1';

mock.module(url('../constants/config.js'), {
  namedExports: { IS_PLATFORM: true },
});

const FIRST_USER = { id: 1, username: 'owner', role: 'owner', password_changed_at: 1000 };

mock.module(url('../modules/database/index.js'), {
  namedExports: {
    appConfigDb: { getOrCreateJwtSecret: () => 'platform-guard-safe-secret-0123456789ab' },
    userDb: { getFirstUser: () => FIRST_USER },
    auditLogDb: { record: () => {} },
  },
});

// Loads only because the acknowledgement + loopback bind are both present.
const {
  assertPlatformAuthBypassSafe,
  authenticateToken,
  PLATFORM_ACK_ENV,
  PLATFORM_ACK_VALUE,
} = await import('./auth.js');

test('B-186: the acknowledgement contract is exactly the documented env/value pair', () => {
  assert.equal(PLATFORM_ACK_ENV, ACK_ENV);
  assert.equal(PLATFORM_ACK_VALUE, ACK_VALUE);
});

test('B-186 guard: no-op when platform mode is off, whatever the env holds', () => {
  assert.doesNotThrow(() => assertPlatformAuthBypassSafe({ isPlatform: false, env: {} }));
  assert.doesNotThrow(() =>
    assertPlatformAuthBypassSafe({ isPlatform: false, env: { HOST: '0.0.0.0' } })
  );
});

test('B-186 guard: platform mode without the ack env is refused', () => {
  assert.throws(
    () => assertPlatformAuthBypassSafe({ isPlatform: true, env: { HOST: '127.0.0.1' } }),
    /Refusing to boot/
  );
});

test('B-186 guard: a near-miss ack value is refused (exact match only)', () => {
  assert.throws(
    () =>
      assertPlatformAuthBypassSafe({
        isPlatform: true,
        env: { [ACK_ENV]: 'true', HOST: '127.0.0.1' },
      }),
    /Refusing to boot/
  );
  assert.throws(
    () =>
      assertPlatformAuthBypassSafe({
        isPlatform: true,
        env: { [ACK_ENV]: `${ACK_VALUE} `, HOST: '127.0.0.1' },
      }),
    /Refusing to boot/
  );
});

test('B-186 guard: acknowledged but bound to a public interface is refused', () => {
  for (const host of ['0.0.0.0', '::', '192.168.1.10', 'nassaj.example.com']) {
    assert.throws(
      () => assertPlatformAuthBypassSafe({ isPlatform: true, env: { [ACK_ENV]: ACK_VALUE, HOST: host } }),
      /NON-loopback/,
      `HOST=${host} must be refused in platform mode`
    );
  }
});

test('B-186 guard: an UNSET HOST is refused (index.js defaults it to 0.0.0.0)', () => {
  assert.throws(
    () => assertPlatformAuthBypassSafe({ isPlatform: true, env: { [ACK_ENV]: ACK_VALUE } }),
    /NON-loopback/
  );
});

test('B-186 guard: acknowledged + loopback passes', () => {
  for (const host of ['127.0.0.1', 'localhost', '::1', '[::1]']) {
    assert.doesNotThrow(
      () => assertPlatformAuthBypassSafe({ isPlatform: true, env: { [ACK_ENV]: ACK_VALUE, HOST: host } }),
      `HOST=${host} is loopback and must pass`
    );
  }
});

test('B-186: documented residual behaviour — once acknowledged, a token-less request IS the first user', async () => {
  const req = { headers: {}, query: {} } as never as Record<string, unknown>;
  let nexted = false;
  await authenticateToken(req, { status: () => ({ json: () => {} }) }, () => {
    nexted = true;
  });
  assert.equal(nexted, true);
  assert.deepEqual(req.user, FIRST_USER);
});

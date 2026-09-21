/**
 * B-186 — platform-mode authentication bypass must fail CLOSED at boot.
 *
 * `IS_PLATFORM` makes authenticateToken / authenticateWebSocket skip JWT
 * verification entirely and resolve EVERY request — including one with no
 * Authorization header at all — to `userDb.getFirstUser()`, i.e. the owner on
 * every real install. That hands `requireRole('owner')` to anonymous callers,
 * and with it the owner-only RCE-class routes (POST
 * /api/system/pending/:id/execute, POST /api/system/update). The pre-existing
 * B-5 guard (platform-isolation-guard.service.js) only refuses the >1-active-user
 * SUBSCRIPTION-sharing shape, so a single-owner install flipped the flag and
 * served unauthenticated owner access silently.
 *
 * This file proves the module now REFUSES TO LOAD (⇒ the server refuses to boot,
 * since server/index.js imports it at load time) when platform mode is on
 * without the explicit acknowledgement. Before the fix the import resolved
 * happily — that is the red.
 *
 * The safe/acknowledged configuration is covered in
 * auth.platform-guard.safe.test.ts: an ESM module that throws while evaluating
 * is cached as errored, so a second import in THIS process could never succeed
 * and the two configurations must live in separate test files (each file runs in
 * its own child process under node --test).
 *
 * Framework: node:test module mocking (--experimental-test-module-mocks).
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test, { mock } from 'node:test';
import { pathToFileURL } from 'node:url';

const url = (spec: string) => pathToFileURL(path.resolve(import.meta.dirname, spec)).href;

// Force resolveJwtSecret down the mocked app_config path.
delete process.env.JWT_SECRET;

// The dangerous configuration: platform mode ON, no acknowledgement in the
// environment. HOST is irrelevant here — the acknowledgement gate fires first.
delete process.env.PLATFORM_MODE_UNAUTHENTICATED_ACK;

mock.module(url('../constants/config.js'), {
  namedExports: { IS_PLATFORM: true },
});

mock.module(url('../modules/database/index.js'), {
  namedExports: {
    appConfigDb: { getOrCreateJwtSecret: () => 'platform-guard-test-secret-0123456789ab' },
    // The bypass would call this for every request; if the guard failed to fire,
    // any anonymous caller would be served as this user.
    userDb: { getFirstUser: () => ({ id: 1, username: 'owner', role: 'owner' }) },
    auditLogDb: { record: () => {} },
  },
});

test('B-186: importing auth.js in platform mode WITHOUT the acknowledgement throws', async () => {
  await assert.rejects(
    () => import('./auth.js'),
    (error: Error) => {
      assert.equal(error.name, 'PlatformAuthBypassError');
      assert.match(error.message, /Refusing to boot/);
      assert.match(error.message, /PLATFORM_MODE_UNAUTHENTICATED_ACK/);
      return true;
    },
    'platform mode with no authentication must abort boot, not serve owner access to anonymous callers'
  );
});

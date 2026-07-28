/**
 * B-147 — acceptInvite must enforce the same username shape as createOidcUser.
 *
 * Before the fix acceptInvite validated only username LENGTH, so an invite could
 * mint an account whose name contained spaces, dots, slashes, or unicode — the
 * length gate alone let them through. createOidcUser (same module) already
 * applied USERNAME_PATTERN. These tests pin that acceptInvite now rejects the
 * same off-pattern names with the SAME message, and still accepts clean names.
 *
 * Framework: node:test + node:assert/strict via tsx, mirroring the sibling
 * auth-flow.integration.test.ts (a real, isolated SQLite database under a temp
 * DATABASE_PATH; the live database is never touched).
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { userDb } from '@/modules/database/repositories/users.js';

import { hashPassword } from './password.service.js';
import { createInvite, acceptInvite, createOidcUser, InviteError } from './invite.service.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'invite-username-'));
  const databasePath = path.join(tempDirectory, 'db.sqlite');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

async function seedOwnerAndInvite(): Promise<string> {
  const hash = await hashPassword('ownerpass123');
  const owner = userDb.createUser('owner', hash, 'owner');
  const { token } = await createInvite({ id: owner.id, role: 'owner' }, { role: 'user' });
  return token;
}

// Off-pattern usernames that clear the >=3-char length gate but violate the
// shape (letters/digits/underscore only, 3–32).
const OFF_PATTERN = ['bad-name', 'has space', 'dot.name', 'slash/name', 'na$me', 'naïve'];

for (const username of OFF_PATTERN) {
  test(`B-147 attack: acceptInvite rejects off-pattern username "${username}"`, async () => {
    await withIsolatedDatabase(async () => {
      const token = await seedOwnerAndInvite();

      await assert.rejects(
        () => acceptInvite({ token, username, password: 'password12' }),
        (err: unknown) =>
          err instanceof InviteError &&
          err.status === 400 &&
          /only letters, digits, and underscores/.test(err.message)
      );

      // The rejected attempt must not have created the account...
      assert.ok(!userDb.getUserByUsername(username), 'no account created for off-pattern name');
      // ...nor consumed the invite: a clean username can still accept it.
      const user = await acceptInvite({ token, username: 'clean_user', password: 'password12' });
      assert.equal(user.username, 'clean_user');
    });
  });
}

test('B-147 message parity: acceptInvite uses the identical message as createOidcUser', async () => {
  await withIsolatedDatabase(async () => {
    const hash = await hashPassword('ownerpass123');
    const owner = userDb.createUser('owner', hash, 'owner');
    const { token } = await createInvite({ id: owner.id, role: 'owner' }, { role: 'user' });

    let acceptMsg = '';
    try {
      await acceptInvite({ token, username: 'bad-name', password: 'password12' });
    } catch (err) {
      acceptMsg = (err as Error).message;
    }

    let oidcMsg = '';
    try {
      await createOidcUser({ id: owner.id, role: 'owner' }, { username: 'bad-name' });
    } catch (err) {
      oidcMsg = (err as Error).message;
    }

    assert.ok(acceptMsg.length > 0 && oidcMsg.length > 0);
    assert.equal(acceptMsg, oidcMsg, 'both account-creation paths share one message');
  });
});

test('B-147 behavior: acceptInvite accepts a pattern-valid username', async () => {
  await withIsolatedDatabase(async () => {
    const token = await seedOwnerAndInvite();

    const user = await acceptInvite({ token, username: 'good_user1', password: 'password12' });

    assert.equal(user.username, 'good_user1');
    assert.equal(user.role, 'user');
    assert.ok(userDb.getUserByUsername('good_user1'));
  });
});

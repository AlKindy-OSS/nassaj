import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { userDb } from '@/modules/database/repositories/users.js';

import { hashPassword, verifyPassword, needsRehash } from './password.service.js';
import { createInvite, acceptInvite, InviteError } from './invite.service.js';
import { ensureOwnerBootstrapped } from './bootstrap-owner.service.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'auth-flow-'));
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

// --- password service ---

test('password: argon2id hash verifies and rejects wrong password', async () => {
  const hash = await hashPassword('correct horse battery');
  assert.ok(hash.startsWith('$argon2id$'));
  assert.equal(await verifyPassword(hash, 'correct horse battery'), true);
  assert.equal(await verifyPassword(hash, 'wrong'), false);
  assert.equal(needsRehash(hash), false);
});

test('password: malformed hash never throws, returns false', async () => {
  assert.equal(await verifyPassword('not-a-hash', 'x'), false);
  assert.equal(await verifyPassword('', 'x'), false);
});

// --- bootstrap owner ---

test('bootstrap: creates owner once, idempotent on second run', async () => {
  await withIsolatedDatabase(async () => {
    const prevUser = process.env.BOOTSTRAP_OWNER_USERNAME;
    const prevPass = process.env.BOOTSTRAP_OWNER_PASSWORD;
    process.env.BOOTSTRAP_OWNER_USERNAME = 'rootowner';
    process.env.BOOTSTRAP_OWNER_PASSWORD = 'supersecret123';
    try {
      const first = await ensureOwnerBootstrapped();
      assert.equal(first.created, true);
      assert.equal(userDb.getOwnerCount(), 1);

      const second = await ensureOwnerBootstrapped();
      assert.equal(second.created, false);
      assert.equal(userDb.getOwnerCount(), 1, 'owner not duplicated');

      const owner = userDb.getUserByUsername('rootowner');
      assert.ok(owner);
      assert.equal(await verifyPassword(owner!.password_hash, 'supersecret123'), true);
    } finally {
      process.env.BOOTSTRAP_OWNER_USERNAME = prevUser;
      process.env.BOOTSTRAP_OWNER_PASSWORD = prevPass;
    }
  });
});

test('bootstrap: rejects short provided password', async () => {
  await withIsolatedDatabase(async () => {
    const prev = process.env.BOOTSTRAP_OWNER_PASSWORD;
    process.env.BOOTSTRAP_OWNER_PASSWORD = 'short';
    try {
      await assert.rejects(() => ensureOwnerBootstrapped(), /at least 12/);
    } finally {
      process.env.BOOTSTRAP_OWNER_PASSWORD = prev;
    }
  });
});

// --- invite flow ---

async function seedOwner() {
  const hash = await hashPassword('ownerpass123');
  return userDb.createUser('owner', hash, 'owner');
}

test('invite: full create → accept → login-ready user (user role)', async () => {
  await withIsolatedDatabase(async () => {
    const owner = await seedOwner();
    const { token } = await createInvite({ id: owner.id, role: 'owner' }, { role: 'user' });

    const newUser = await acceptInvite({ token, username: 'invitee', password: 'newpass1234' });
    assert.equal(newUser.role, 'user');

    const stored = userDb.getUserByUsername('invitee');
    assert.ok(stored);
    assert.equal(stored!.invited_by, owner.id);
    assert.equal(await verifyPassword(stored!.password_hash, 'newpass1234'), true);
  });
});

test('invite: accepting twice fails (consumed)', async () => {
  await withIsolatedDatabase(async () => {
    const owner = await seedOwner();
    const { token } = await createInvite({ id: owner.id, role: 'owner' }, {});
    await acceptInvite({ token, username: 'first', password: 'password12' });
    await assert.rejects(
      () => acceptInvite({ token, username: 'second', password: 'password12' }),
      (err: unknown) => err instanceof InviteError && err.status >= 400
    );
  });
});

test('invite: invalid token rejected', async () => {
  await withIsolatedDatabase(async () => {
    await assert.rejects(
      () => acceptInvite({ token: 'does-not-exist', username: 'x', password: 'password12' }),
      (err: unknown) => err instanceof InviteError && err.status === 400
    );
  });
});

test('invite: duplicate username rejected', async () => {
  await withIsolatedDatabase(async () => {
    const owner = await seedOwner();
    const { token } = await createInvite({ id: owner.id, role: 'owner' }, {});
    await assert.rejects(
      () => acceptInvite({ token, username: 'owner', password: 'password12' }),
      (err: unknown) => err instanceof InviteError && err.status === 409
    );
  });
});

test('invite: only owner may mint admin invites', async () => {
  await withIsolatedDatabase(async () => {
    await assert.rejects(
      async () => createInvite({ id: 5, role: 'admin' }, { role: 'admin' }),
      (err: unknown) => err instanceof InviteError && err.status === 403
    );
    // owner can
    const owner = await seedOwner();
    const res = await createInvite({ id: owner.id, role: 'owner' }, { role: 'admin' });
    assert.equal(res.role, 'admin');
  });
});

test('invite: rejects unknown role', async () => {
  await withIsolatedDatabase(async () => {
    const owner = await seedOwner();
    await assert.rejects(
      async () => createInvite({ id: owner.id, role: 'owner' }, { role: 'superadmin' }),
      (err: unknown) => err instanceof InviteError && err.status === 400
    );
  });
});

test('invite: short password rejected at acceptance', async () => {
  await withIsolatedDatabase(async () => {
    const owner = await seedOwner();
    const { token } = await createInvite({ id: owner.id, role: 'owner' }, {});
    await assert.rejects(
      () => acceptInvite({ token, username: 'shorty', password: 'abc' }),
      (err: unknown) => err instanceof InviteError && err.status === 400
    );
  });
});

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  deviceAccountSessionsDb,
  getConnection,
  initializeDatabase,
  invitesDb,
  userDb,
  WalletConflictError,
} from '@/modules/database/index.js';
// eslint-disable-next-line boundaries/no-unknown -- test exercises the existing password verifier through the domain injection seam.
import { hashPassword, verifyPassword } from '@/services/password.service.js';

import { AccountWalletService } from './account-wallet.service.js';
import { connectionRevocationRegistry } from './connection-revocation-registry.js';

const DECOY = '$argon2id$v=19$m=19456,t=2,p=1$EDCm/UT8BUkf/841sKsVBA$ovQxBwQSaiVR9mJzTVt6kcaWVmZzT1PslPE4FjMPxRk';

test('wallet migration is additive, idempotent, and creates no implicit device sessions', async () => {
  await withDatabase(async () => {
    const db = getConnection();
    const passwordHash = await hashPassword('migration fixture password');
    userDb.createUser('preexisting_wallet_user', passwordHash, 'owner');
    await initializeDatabase();
    await initializeDatabase();
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM device_sessions').get() as { count: number }).count, 0);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM device_account_slots').get() as { count: number }).count, 0);
  });
});

async function withDatabase(run: () => Promise<void>): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(tmpdir(), 'account-wallet-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();
  try {
    await run();
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

async function fixture() {
  const passwordHash = await hashPassword('correct horse battery staple');
  const first = userDb.createUser('first_user', passwordHash, 'owner');
  const second = userDb.createUser('second_user', passwordHash, 'user');
  invitesDb.create({
    tokenHash: 'second-user-invite',
    role: 'user',
    invitedBy: first.id,
    email: 'second@example.test',
    expiresAt: '2999-01-01 00:00:00',
  });
  invitesDb.markAccepted('second-user-invite', second.id, '2026-09-16 00:00:00');
  const device = deviceAccountSessionsDb.create(first.id, 60_000);
  const service = new AccountWalletService({
    findLocalCredential: (identifier) => {
      const user = userDb.getUserByLoginIdentifier(identifier);
      return user && Number.isSafeInteger(user.password_changed_at)
        ? {
            id: user.id,
            passwordHash: user.password_hash,
            passwordStamp: user.password_changed_at as number,
          }
        : null;
    },
    verifyPassword,
    decoyPasswordHash: DECOY,
  });
  return { first, second, device, service };
}

test('local add re-authenticates without switching active account', async () => {
  await withDatabase(async () => {
    const { device, service } = await fixture();
    const failed = await service.addLocal(
      device.principal, 'missing@example.test', 'wrong', device.wallet.generation,
    );
    assert.equal(failed, null);
    assert.equal(deviceAccountSessionsDb.snapshot(device.principal.deviceSessionId)?.accounts.length, 1);

    const wallet = await service.addLocal(
      device.principal,
      'second@example.test',
      'correct horse battery staple',
      device.wallet.generation,
    );
    assert.ok(wallet);
    assert.equal(wallet.activeSlotId, device.wallet.activeSlotId);
    assert.equal(wallet.accounts.length, 2);
    assert.equal(wallet.generation, 2);
  });
});

test('password rotation racing local re-authentication cannot attach a stale credential', async () => {
  await withDatabase(async () => {
    const { second, device } = await fixture();
    const service = new AccountWalletService({
      findLocalCredential: (identifier) => {
        const user = userDb.getUserByLoginIdentifier(identifier);
        return user && Number.isSafeInteger(user.password_changed_at)
          ? {
              id: user.id,
              passwordHash: user.password_hash,
              passwordStamp: user.password_changed_at as number,
            }
          : null;
      },
      verifyPassword: async (passwordHash, plaintext) => {
        const verified = await verifyPassword(passwordHash, plaintext);
        if (verified) {
          const replacement = await hashPassword('replacement password');
          userDb.changePassword(second.id, replacement, Date.now() + 10_000);
        }
        return verified;
      },
      decoyPasswordHash: DECOY,
    });

    const result = await service.addLocal(
      device.principal, 'second@example.test', 'correct horse battery staple', 1,
    );
    assert.equal(result, null);
    assert.deepEqual(
      deviceAccountSessionsDb.snapshot(device.principal.deviceSessionId),
      device.wallet,
    );
  });
});

test('generation conflict prevents stale mutation and switch revokes old realtime identity', async () => {
  await withDatabase(async () => {
    const { device, service } = await fixture();
    const added = await service.addLocal(
      device.principal,
      'second@example.test',
      'correct horse battery staple',
      1,
    );
    assert.ok(added);
    const secondSlot = added.accounts.find((account) => account.slotId !== added.activeSlotId)!;
    let closeReason = '';
    connectionRevocationRegistry.register({
      close: (_code, reason) => { closeReason = reason ?? ''; },
    }, device.principal);

    const currentPrincipal = { ...device.principal, generation: added.generation };
    const switched = service.switch(currentPrincipal, secondSlot.slotId, added.generation);
    assert.equal(switched.activeSlotId, secondSlot.slotId);
    assert.equal(closeReason, 'identity_revoked');
    assert.equal(connectionRevocationRegistry.isCurrent(currentPrincipal), false);
    assert.throws(
      () => service.remove(currentPrincipal, device.principal.slotId, added.generation),
      (error) => error instanceof WalletConflictError
        && error.code === 'wallet_generation_conflict',
    );
  });
});

test('authorization generation invalidates a stamped device principal', async () => {
  await withDatabase(async () => {
    const { first, device } = await fixture();
    assert.equal(deviceAccountSessionsDb.isPrincipalCurrent(device.principal), true);
    userDb.setRole(first.id, 'admin');
    assert.equal(deviceAccountSessionsDb.isPrincipalCurrent(device.principal), false);
    const refreshed = deviceAccountSessionsDb.resolve(device.secret);
    assert.equal(refreshed?.principal.authorizationGeneration,
      device.principal.authorizationGeneration + 1);
    assert.equal(deviceAccountSessionsDb.isPrincipalCurrent(refreshed!.principal), true);
  });
});

test('five-slot cap is enforced inside the wallet transaction', async () => {
  await withDatabase(async () => {
    const { device, service } = await fixture();
    let principal = device.principal;
    let generation = 1;
    for (let index = 2; index <= 5; index += 1) {
      const identifier = `user${index}@example.test`;
      const passwordHash = await hashPassword('correct horse battery staple');
      userDb.createUser(identifier, passwordHash, 'user');
      const wallet = await service.addLocal(
        principal, identifier, 'correct horse battery staple', generation,
      );
      assert.ok(wallet);
      generation = wallet.generation;
      principal = { ...principal, generation };
    }
    const sixthHash = await hashPassword('correct horse battery staple');
    userDb.createUser('sixth@example.test', sixthHash, 'user');
    await assert.rejects(
      service.addLocal(principal, 'sixth@example.test', 'correct horse battery staple', generation),
      (error) => error instanceof WalletConflictError && error.code === 'account_limit_reached',
    );
    assert.equal(deviceAccountSessionsDb.snapshot(principal.deviceSessionId)?.accounts.length, 5);
  });
});

test('password rotation preserves only the current slot and closes every stale transport', async () => {
  await withDatabase(async () => {
    const { first, device, service } = await fixture();
    const otherDevice = deviceAccountSessionsDb.create(first.id, 60_000);
    let firstClosed = 0;
    let secondClosed = 0;
    connectionRevocationRegistry.register({ close: () => { firstClosed += 1; } }, device.principal);
    connectionRevocationRegistry.register({ close: () => { secondClosed += 1; } }, otherDevice.principal);

    const changedAt = Date.now() + 1000;
    const nextHash = await hashPassword('new correct horse battery staple');
    service.rotatePassword(first.id, nextHash, changedAt, device.principal.slotId);

    assert.equal(firstClosed, 1);
    assert.equal(secondClosed, 1);
    assert.equal(connectionRevocationRegistry.isCurrent(device.principal), false);
    const preserved = deviceAccountSessionsDb.resolve(device.secret);
    assert.ok(preserved);
    assert.equal(preserved.principal.slotId, device.principal.slotId);
    assert.equal(preserved.principal.generation, 2);
    assert.equal(deviceAccountSessionsDb.resolve(otherDevice.secret), null);
  });
});

test('forced password reset and disabled candidates cannot become active identities', async () => {
  await withDatabase(async () => {
    const { second, device, service } = await fixture();
    const added = await service.addLocal(
      device.principal, 'second@example.test', 'correct horse battery staple', 1,
    );
    assert.ok(added);
    const secondSlot = added.accounts.find((account) => !account.isActive)!;
    userDb.setStatus(second.id, 'disabled');
    assert.throws(
      () => service.switch({ ...device.principal, generation: 2 }, secondSlot.slotId, 2),
      (error) => error instanceof WalletConflictError && error.code === 'slot_not_found',
    );

    userDb.setStatus(second.id, 'active');
    const resetHash = await hashPassword('temporary reset password');
    service.rotatePassword(second.id, resetHash, Date.now() + 1000, null, true);
    assert.equal(deviceAccountSessionsDb.snapshot(device.principal.deviceSessionId)?.accounts.length, 1);
  });
});

test('permanent user deletion safely detaches wallet rows and preserves fallback identity', async () => {
  await withDatabase(async () => {
    const { second, device, service } = await fixture();
    const added = await service.addLocal(
      device.principal, 'second@example.test', 'correct horse battery staple', 1,
    );
    assert.ok(added);
    const secondSlot = added.accounts.find((account) => !account.isActive)!;
    const switched = service.switch(
      { ...device.principal, generation: 2 }, secondSlot.slotId, 2,
    );
    assert.equal(switched.activeSlotId, secondSlot.slotId);

    assert.equal(userDb.deleteUser(second.id), true);
    const wallet = deviceAccountSessionsDb.snapshot(device.principal.deviceSessionId);
    assert.ok(wallet);
    assert.equal(wallet.accounts.length, 1);
    assert.equal(wallet.activeSlotId, device.principal.slotId);
    assert.equal(wallet.generation, 4);
  });
});

test('logout skips disabled remaining accounts instead of selecting an unusable identity', async () => {
  await withDatabase(async () => {
    const { second, device, service } = await fixture();
    const added = await service.addLocal(device.principal, 'second@example.test', 'correct horse battery staple', 1);
    assert.ok(added);
    userDb.setStatus(second.id, 'disabled');
    const result = service.logout({ ...device.principal, generation: 2 }, 2);
    assert.equal(result.wallet?.activeSlotId, null);
    assert.deepEqual(result.wallet?.accounts, []);
    assert.equal(deviceAccountSessionsDb.resolve(device.secret), null);
  });
});

test('forced reset revokes all devices and prevents old principal reuse', async () => {
  await withDatabase(async () => {
    const { first, device, service } = await fixture();
    const secondDevice = deviceAccountSessionsDb.create(first.id, 60_000);
    const resetHash = await hashPassword('temporary reset password');
    service.rotatePassword(first.id, resetHash, Date.now() + 1000, null, true);
    for (const current of [device, secondDevice]) {
      assert.equal(deviceAccountSessionsDb.resolve(current.secret), null);
      assert.equal(connectionRevocationRegistry.isCurrent(current.principal), false);
    }
    assert.throws(() => deviceAccountSessionsDb.create(first.id, 60_000),
      (error) => error instanceof WalletConflictError && error.code === 'account_ineligible');
  });
});

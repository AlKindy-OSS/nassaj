import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { stopReconcileScheduler } from '@/modules/database/project-reconcile.service.js';
import { apiKeysDb } from '@/modules/database/repositories/api-keys.js';
import { deviceAccountSessionsDb } from '@/modules/database/repositories/device-account-sessions.js';
import { userIdentitiesDb } from '@/modules/database/repositories/user-identities.js';
import { userDb } from '@/modules/database/repositories/users.js';

test('B-1410: countLinkedUsersWithRole counts distinct linked owners only', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(tmpdir(), 'user-identities-'));
  const databasePath = path.join(directory, 'auth.db');
  await writeFile(databasePath, '');
  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();
  stopReconcileScheduler();
  try {
    assert.equal(userIdentitiesDb.countLinkedUsersWithRole('owner'), 0);
    const owner = userDb.createUser('owner-a', 'hash', 'owner');
    const member = userDb.createUser('member-a', 'hash', 'user');
    userIdentitiesDb.link(member.id, 'https://issuer.example', 'sub-member');
    assert.equal(userIdentitiesDb.countLinkedUsersWithRole('owner'), 0);

    userIdentitiesDb.link(owner.id, 'https://issuer.example', 'sub-owner-1');
    userIdentitiesDb.link(owner.id, 'https://issuer-2.example', 'sub-owner-2');
    assert.equal(userIdentitiesDb.countLinkedUsersWithRole('owner'), 1, 'distinct users, not rows');

    userIdentitiesDb.unlinkAll(owner.id);
    assert.equal(userIdentitiesDb.countLinkedUsersWithRole('owner'), 0);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(directory, { recursive: true, force: true });
  }
});

test('T-1939: markAttested stamps only the owning link; hasAnyLink reports linkage', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(tmpdir(), 'user-identities-'));
  const databasePath = path.join(directory, 'auth.db');
  await writeFile(databasePath, '');
  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();
  stopReconcileScheduler();
  try {
    const member = userDb.createUser('member-b', 'hash', 'user');
    const other = userDb.createUser('member-c', 'hash', 'user');
    assert.equal(userIdentitiesDb.hasAnyLink(member.id), false);
    userIdentitiesDb.link(member.id, 'https://issuer.example', 'sub-b');
    assert.equal(userIdentitiesDb.hasAnyLink(member.id), true);
    const identity = userIdentitiesDb.findByIssuerAndSubject('https://issuer.example', 'sub-b');
    assert.equal(identity?.last_attested_at, null, 'a new link is not attested yet');

    userIdentitiesDb.markAttested(identity!.id, other.id, 111);
    assert.equal(userIdentitiesDb.findByIssuerAndSubject('https://issuer.example', 'sub-b')?.last_attested_at,
      null, 'a mismatched user id never writes');
    userIdentitiesDb.markAttested(identity!.id, member.id, 1_700_000_000_123);
    assert.equal(userIdentitiesDb.findByIssuerAndSubject('https://issuer.example', 'sub-b')?.last_attested_at,
      1_700_000_000_123);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(directory, { recursive: true, force: true });
  }
});

/** Runs `body` against a fresh initialized database in a temp directory. */
async function withDatabase(body: () => void | Promise<void>) {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(tmpdir(), 'user-identities-'));
  const databasePath = path.join(directory, 'auth.db');
  await writeFile(databasePath, '');
  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();
  stopReconcileScheduler();
  try {
    await body();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(directory, { recursive: true, force: true });
  }
}

test('T-1939 slice 3: attestationSummary takes the newest stamp across links', () => withDatabase(() => {
  const member = userDb.createUser('member-s', 'hash', 'user');
  assert.deepEqual(userIdentitiesDb.attestationSummary(member.id), { linkCount: 0, latestAttestedAt: null });
  userIdentitiesDb.link(member.id, 'https://issuer.example', 'sub-s1');
  userIdentitiesDb.link(member.id, 'https://issuer-2.example', 'sub-s2');
  assert.deepEqual(userIdentitiesDb.attestationSummary(member.id), { linkCount: 2, latestAttestedAt: null });
  const first = userIdentitiesDb.findByIssuerAndSubject('https://issuer.example', 'sub-s1')!;
  const second = userIdentitiesDb.findByIssuerAndSubject('https://issuer-2.example', 'sub-s2')!;
  userIdentitiesDb.markAttested(first.id, member.id, 1000);
  userIdentitiesDb.markAttested(second.id, member.id, 5000);
  assert.deepEqual(userIdentitiesDb.attestationSummary(member.id), { linkCount: 2, latestAttestedAt: 5000 });
}));

test('T-1939 slice 3: listStaleLinkedNonOwners selects only stale, active, linked non-owners', () => withDatabase(() => {
  const cutoff = 10_000;
  const owner = userDb.createUser('owner-s', 'hash', 'owner');
  const stale = userDb.createUser('stale-s', 'hash', 'user');
  const never = userDb.createUser('never-s', 'hash', 'admin');
  const fresh = userDb.createUser('fresh-s', 'hash', 'user');
  const disabled = userDb.createUser('disabled-s', 'hash', 'user');
  userDb.createUser('unlinked-s', 'hash', 'user');
  // One issuer per subject: UNIQUE(user_id, issuer) allows one link per issuer.
  const stamp = (userId: number, subject: string, at: number | null) => {
    userIdentitiesDb.link(userId, `https://issuer.example/${subject}`, subject);
    if (at !== null) {
      const row = userIdentitiesDb.findByIssuerAndSubject(`https://issuer.example/${subject}`, subject)!;
      userIdentitiesDb.markAttested(row.id, userId, at);
    }
  };
  stamp(owner.id, 'sub-owner', null);
  stamp(stale.id, 'sub-stale', cutoff - 1);
  stamp(never.id, 'sub-never', null);
  stamp(fresh.id, 'sub-fresh-old', cutoff - 5000);
  stamp(fresh.id, 'sub-fresh-new', cutoff + 1);
  stamp(disabled.id, 'sub-disabled', null);
  userDb.setStatus(disabled.id, 'disabled');

  const rows = userIdentitiesDb.listStaleLinkedNonOwners(cutoff, 0, 50);
  assert.deepEqual(rows, [
    { userId: stale.id, latestAttestedAt: cutoff - 1 },
    { userId: never.id, latestAttestedAt: null },
  ]);
  assert.deepEqual(userIdentitiesDb.listStaleLinkedNonOwners(cutoff, stale.id, 50).map((row) => row.userId),
    [never.id], 'cursor skips already-seen ids');
  assert.equal(userIdentitiesDb.listStaleLinkedNonOwners(cutoff, 0, 1).length, 1, 'limit is honoured');
}));

test('T-1939 slice 3: revokeAllForUser deletes only that user\'s API keys', () => withDatabase(() => {
  const member = userDb.createUser('keys-a', 'hash', 'user');
  const other = userDb.createUser('keys-b', 'hash', 'user');
  apiKeysDb.createApiKey(member.id, 'one');
  const kept = apiKeysDb.createApiKey(member.id, 'two');
  apiKeysDb.toggleApiKey(member.id, Number(kept.id), false);
  apiKeysDb.createApiKey(other.id, 'other');
  assert.equal(apiKeysDb.revokeAllForUser(member.id), 2, 'disabled keys are removed too');
  assert.equal(apiKeysDb.getApiKeys(member.id).length, 0);
  assert.equal(apiKeysDb.getApiKeys(other.id).length, 1);
  assert.equal(apiKeysDb.revokeAllForUser(member.id), 0);
}));

test('T-1939 slice 3: userIdForSlot resolves a live slot on its own device only', () => withDatabase(() => {
  const member = userDb.createUser('slot-a', 'hash', 'user');
  const created = deviceAccountSessionsDb.create(member.id, 60_000);
  const { deviceSessionId, slotId } = created.principal;
  assert.equal(deviceAccountSessionsDb.userIdForSlot(deviceSessionId, slotId), member.id);
  assert.equal(deviceAccountSessionsDb.userIdForSlot('other-device', slotId), null);
  assert.equal(deviceAccountSessionsDb.userIdForSlot(deviceSessionId, 'slot_missing'), null);
}));

test('T-1939 slice 5: link returns the new id; one link per (user, issuer) is enforced', () => withDatabase(() => {
  const member = userDb.createUser('self-link-a', 'hash', 'user');
  const id = userIdentitiesDb.link(member.id, 'https://issuer.example', 'sub-self-a');
  assert.equal(userIdentitiesDb.findByIssuerAndSubject('https://issuer.example', 'sub-self-a')?.id, id);
  assert.equal(userIdentitiesDb.countForUserAndIssuer(member.id, 'https://issuer.example'), 1);
  assert.equal(userIdentitiesDb.countForUserAndIssuer(member.id, 'https://other.example'), 0);
  assert.throws(() => userIdentitiesDb.link(member.id, 'https://issuer.example', 'sub-self-b'), /UNIQUE/);
  assert.equal(userIdentitiesDb.countUsersWithDuplicateIssuerLinks(), 0);
}));

test('T-1939 slice 5: legacy duplicates are counted per user, never per row', () => withDatabase(() => {
  const member = userDb.createUser('dup-a', 'hash', 'user');
  getConnection().exec('DROP INDEX idx_user_identities_user_issuer');
  for (const subject of ['d1', 'd2', 'd3']) userIdentitiesDb.link(member.id, 'https://issuer.example', subject);
  assert.equal(userIdentitiesDb.countForUserAndIssuer(member.id, 'https://issuer.example'), 3);
  assert.equal(userIdentitiesDb.countUsersWithDuplicateIssuerLinks(), 1);
}));

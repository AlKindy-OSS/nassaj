/**
 * ADR-163 amendment 1, D3/C1 and M6 at the repository: rotateDevice always
 * mints a new device and revokes the presented one in the same transaction;
 * slideExpiry renews conditionally and never past the absolute cap (T17).
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';

import {
  closeConnection,
  DEVICE_ABSOLUTE_TTL_MS,
  DEVICE_IDLE_TTL_MS,
  deviceAccountSessionsDb,
  getConnection,
  initializeDatabase,
  userDb,
  WalletConflictError,
} from '@/modules/database/index.js';

const DAY = 24 * 60 * 60 * 1000;
let sequence = 0;

before(async () => {
  assert.ok(process.env.DATABASE_PATH, 'Use the isolated node test runner');
  await initializeDatabase();
});
after(() => closeConnection());

const user = () => userDb.createUser(`rotation_user_${++sequence}`, 'hash', 'user');
const deviceRow = (id: string) => getConnection().prepare(`
  SELECT expires_at AS expiresAt, created_at AS createdAt, revoked_at AS revokedAt, active_slot_id AS activeSlotId
  FROM device_sessions WHERE id = ?
`).get(id) as { expiresAt: number; createdAt: number; revokedAt: number | null; activeSlotId: string | null };
const liveSlots = (id: string) => (getConnection().prepare(`
  SELECT COUNT(*) AS n FROM device_account_slots WHERE device_session_id = ? AND revoked_at IS NULL
`).get(id) as { n: number }).n;
const setTimes = (id: string, expiresAt: number, createdAt: number) => getConnection()
  .prepare('UPDATE device_sessions SET expires_at = ?, created_at = ? WHERE id = ?').run(expiresAt, createdAt, id);

test('C1: rotation revokes the presented device and its slots and carries nothing over', () => {
  const first = user();
  const second = user();
  const prior = deviceAccountSessionsDb.create(first.id, DEVICE_IDLE_TTL_MS);
  deviceAccountSessionsDb.add(prior.principal, second.id, second.password_changed_at, 1);
  assert.equal(liveSlots(prior.principal.deviceSessionId), 2);

  const next = deviceAccountSessionsDb.rotateDevice(prior.secret, second.id, DEVICE_IDLE_TTL_MS);
  assert.notEqual(next.secret, prior.secret);
  assert.notEqual(next.principal.deviceSessionId, prior.principal.deviceSessionId);
  assert.equal(next.revokedDeviceSessionId, prior.principal.deviceSessionId);
  assert.equal(deviceAccountSessionsDb.resolve(prior.secret), null, 'the old secret is dead');
  assert.equal(liveSlots(prior.principal.deviceSessionId), 0);
  assert.notEqual(deviceRow(prior.principal.deviceSessionId).revokedAt, null);
  assert.equal(next.wallet.accounts.length, 1, 'no merge into the previous wallet');
  assert.equal(deviceAccountSessionsDb.resolve(next.secret)?.principal.userId, second.id);
});

test('C1: an unknown or already-revoked prior secret still yields a fresh device', () => {
  const account = user();
  const unknown = deviceAccountSessionsDb.rotateDevice('not-a-real-secret', account.id, DEVICE_IDLE_TTL_MS);
  assert.equal(unknown.revokedDeviceSessionId, null);
  const again = deviceAccountSessionsDb.rotateDevice(unknown.secret, account.id, DEVICE_IDLE_TTL_MS);
  const third = deviceAccountSessionsDb.rotateDevice(unknown.secret, account.id, DEVICE_IDLE_TTL_MS);
  assert.equal(third.revokedDeviceSessionId, unknown.principal.deviceSessionId);
  assert.ok(deviceAccountSessionsDb.resolve(again.secret), 'rotating a dead secret revokes nothing else');
});

test('C1: an ineligible account rolls back and leaves the presented device untouched', () => {
  const account = user();
  const prior = deviceAccountSessionsDb.create(account.id, DEVICE_IDLE_TTL_MS);
  const blocked = user();
  getConnection().prepare('UPDATE users SET must_change_password = 1 WHERE id = ?').run(blocked.id);
  assert.throws(
    () => deviceAccountSessionsDb.rotateDevice(prior.secret, blocked.id, DEVICE_IDLE_TTL_MS),
    (error: unknown) => error instanceof WalletConflictError && error.code === 'account_ineligible',
  );
  assert.ok(deviceAccountSessionsDb.resolve(prior.secret), 'the prior device survives a refused issuance');
});

test('issuance never exceeds the absolute cap', () => {
  const issued = deviceAccountSessionsDb.rotateDevice(null, user().id, DEVICE_ABSOLUTE_TTL_MS * 2);
  const row = deviceRow(issued.principal.deviceSessionId);
  assert.equal(row.expiresAt - row.createdAt, DEVICE_ABSOLUTE_TTL_MS);
  assert.equal(issued.expiresAt, row.expiresAt);
});

test('T17: no renewal before half of the idle window', () => {
  const issued = deviceAccountSessionsDb.create(user().id, DEVICE_IDLE_TTL_MS);
  assert.equal(deviceAccountSessionsDb.slideExpiry(issued.principal.deviceSessionId), null);
});

test('T17: past half-life the expiry slides to now + idle', () => {
  const issued = deviceAccountSessionsDb.create(user().id, DEVICE_IDLE_TTL_MS);
  const now = Date.now();
  setTimes(issued.principal.deviceSessionId, now + DAY, now - 6 * DAY);
  const renewed = deviceAccountSessionsDb.slideExpiry(issued.principal.deviceSessionId, now);
  assert.equal(renewed, now + DEVICE_IDLE_TTL_MS);
  assert.equal(deviceRow(issued.principal.deviceSessionId).expiresAt, renewed);
});

test('T17: renewal is capped at created_at + 30 days and stops there', () => {
  const issued = deviceAccountSessionsDb.create(user().id, DEVICE_IDLE_TTL_MS);
  const now = Date.now();
  const createdAt = now - 29 * DAY;
  setTimes(issued.principal.deviceSessionId, now + DAY / 2, createdAt);
  assert.equal(deviceAccountSessionsDb.slideExpiry(issued.principal.deviceSessionId, now), createdAt + DEVICE_ABSOLUTE_TTL_MS);
  assert.equal(deviceAccountSessionsDb.slideExpiry(issued.principal.deviceSessionId, now + DAY / 2), null,
    'at the cap there is nothing left to extend');
  setTimes(issued.principal.deviceSessionId, createdAt + DEVICE_ABSOLUTE_TTL_MS, createdAt);
  assert.equal(deviceAccountSessionsDb.slideExpiry(issued.principal.deviceSessionId, now + 2 * DAY), null,
    'past the cap the session is expired, not renewed');
});

test('T17: a revoked or expired session is never revived', () => {
  const account = user();
  const issued = deviceAccountSessionsDb.create(account.id, DEVICE_IDLE_TTL_MS);
  const now = Date.now();
  setTimes(issued.principal.deviceSessionId, now + DAY, now - 6 * DAY);
  deviceAccountSessionsDb.rotateDevice(issued.secret, account.id, DEVICE_IDLE_TTL_MS);
  assert.equal(deviceAccountSessionsDb.slideExpiry(issued.principal.deviceSessionId, now), null);
  assert.equal(deviceRow(issued.principal.deviceSessionId).expiresAt, now + DAY);

  const expired = deviceAccountSessionsDb.create(account.id, DEVICE_IDLE_TTL_MS);
  setTimes(expired.principal.deviceSessionId, now - 1, now - 8 * DAY);
  assert.equal(deviceAccountSessionsDb.slideExpiry(expired.principal.deviceSessionId, now), null);
});

test('T17: the UPDATE is conditional on the expiry that was read (race loses quietly)', () => {
  const issued = deviceAccountSessionsDb.create(user().id, DEVICE_IDLE_TTL_MS);
  const now = Date.now();
  const id = issued.principal.deviceSessionId;
  setTimes(id, now + DAY, now - 6 * DAY);
  const db = getConnection();
  const original = db.prepare.bind(db);
  let raced = false;
  const patched = (sql: string) => {
    if (!raced && sql.includes('UPDATE device_sessions SET expires_at')) {
      raced = true;
      original('UPDATE device_sessions SET revoked_at = ? WHERE id = ?').run(now, id);
    }
    return original(sql);
  };
  Object.assign(db, { prepare: patched });
  try {
    assert.equal(deviceAccountSessionsDb.slideExpiry(id, now), null);
  } finally {
    Object.assign(db, { prepare: original });
  }
  assert.equal(raced, true);
  assert.equal(deviceRow(id).expiresAt, now + DAY, 'a revocation between read and write wins');
});

test('O-4: a device whose active account must change its password does not resolve', () => {
  const account = user();
  const issued = deviceAccountSessionsDb.create(account.id, DEVICE_IDLE_TTL_MS);
  assert.ok(deviceAccountSessionsDb.resolve(issued.secret));
  getConnection().prepare('UPDATE users SET must_change_password = 1 WHERE id = ?').run(account.id);
  assert.equal(deviceAccountSessionsDb.resolve(issued.secret), null);
  assert.equal(deviceAccountSessionsDb.isPrincipalCurrent(issued.principal), false);
});

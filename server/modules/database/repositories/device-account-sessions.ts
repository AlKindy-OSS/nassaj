import crypto from 'node:crypto';

import { getConnection } from '@/modules/database/connection.js';

export const DEVICE_COOKIE = '__Host-nassaj_device';
export const MAX_ACCOUNT_SLOTS = 5;

export type DevicePrincipal = Readonly<{
  deviceSessionId: string;
  slotId: string;
  generation: number;
  userId: number;
  authorizationGeneration: number;
}>;

export type AccountWalletSnapshot = Readonly<{
  generation: number;
  activeSlotId: string | null;
  accounts: ReadonlyArray<Readonly<{
    slotId: string;
    displayName: string;
    avatarUrl: string | null;
    isActive: boolean;
    lastUsedAt: number;
  }>>;
}>;

const hash = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');
const id = (prefix: string): string => `${prefix}_${crypto.randomBytes(24).toString('base64url')}`;

/** Expected domain conflict surfaced without leaking database details. */
export class WalletConflictError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'WalletConflictError';
  }
}

function readSnapshotInCurrentTransaction(sessionId: string): AccountWalletSnapshot | null {
  const db = getConnection();
  const session = db.prepare(`
    SELECT id, active_slot_id, generation
    FROM device_sessions
    WHERE id = ? AND revoked_at IS NULL AND expires_at > ?
  `).get(sessionId, Date.now()) as {
    id: string; active_slot_id: string | null; generation: number;
  } | undefined;
  if (!session) return null;

  const accounts = db.prepare(`
    SELECT s.id AS slotId, u.username AS displayName,
           u.avatar_url AS avatarUrl, s.last_used_at AS lastUsedAt
    FROM device_account_slots s
    JOIN users u ON u.id = s.user_id
    WHERE s.device_session_id = ? AND s.revoked_at IS NULL
      AND u.is_active = 1 AND u.status = 'active'
      AND u.must_change_password = 0
      AND s.password_stamp = u.password_changed_at
    ORDER BY s.last_used_at DESC, s.id ASC
  `).all(sessionId) as Array<{
    slotId: string; displayName: string; avatarUrl: string | null; lastUsedAt: number;
  }>;

  return {
    generation: session.generation,
    activeSlotId: session.active_slot_id,
    accounts: accounts.map((account) => ({
      ...account,
      isActive: account.slotId === session.active_slot_id,
    })),
  };
}

/** Keeps the session row and its account rows on one SQLite read snapshot. */
function readSnapshot(sessionId: string): AccountWalletSnapshot | null {
  const db = getConnection();
  return db.inTransaction
    ? readSnapshotInCurrentTransaction(sessionId)
    : db.transaction(() => readSnapshotInCurrentTransaction(sessionId))();
}

function requirePrincipal(principal: DevicePrincipal, expectedGeneration: number): AccountWalletSnapshot {
  const current = readSnapshot(principal.deviceSessionId);
  if (!current) throw new WalletConflictError('device_session_invalid');
  if (current.generation !== expectedGeneration) {
    throw new WalletConflictError('wallet_generation_conflict');
  }
  if (!deviceAccountSessionsDb.isPrincipalCurrent(principal)) {
    throw new WalletConflictError('device_session_invalid');
  }
  return current;
}

function inImmediateTransaction<T>(operation: () => T): T {
  const db = getConnection();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** Parameterized persistence boundary for device-bound account wallets. */
export const deviceAccountSessionsDb = {
  create(userId: number, ttlMs: number): { secret: string; principal: DevicePrincipal; wallet: AccountWalletSnapshot } {
    const db = getConnection();
    const user = db.prepare(`
      SELECT password_changed_at AS passwordStamp,
             authorization_generation AS authorizationGeneration FROM users
      WHERE id = ? AND is_active = 1 AND status = 'active' AND must_change_password = 0
    `).get(userId) as { passwordStamp: number; authorizationGeneration: number } | undefined;
    if (!user || !Number.isSafeInteger(user.passwordStamp)) {
      throw new WalletConflictError('account_ineligible');
    }
    const secret = crypto.randomBytes(32).toString('base64url');
    const sessionId = id('device');
    const slotId = id('slot');
    const now = Date.now();
    inImmediateTransaction(() => {
      db.prepare(`
        INSERT INTO device_sessions(id, secret_hash, expires_at, generation, created_at)
        VALUES(?, ?, ?, 1, ?)
      `).run(sessionId, hash(secret), now + ttlMs, now);
      db.prepare(`
        INSERT INTO device_account_slots(
          id, device_session_id, user_id, created_at, last_used_at, password_stamp
        ) VALUES(?, ?, ?, ?, ?, ?)
      `).run(slotId, sessionId, userId, now, now, user.passwordStamp);
      db.prepare('UPDATE device_sessions SET active_slot_id = ? WHERE id = ?')
        .run(slotId, sessionId);
    });
    return {
      secret,
      principal: { deviceSessionId: sessionId, slotId, generation: 1, userId,
        authorizationGeneration: user.authorizationGeneration },
      wallet: readSnapshot(sessionId)!,
    };
  },

  resolve(secret: string): { principal: DevicePrincipal; wallet: AccountWalletSnapshot } | null {
    const db = getConnection();
    return db.transaction(() => {
      const row = db.prepare(`
        SELECT d.id AS deviceSessionId, d.active_slot_id AS slotId,
               d.generation, s.user_id AS userId,
               u.authorization_generation AS authorizationGeneration
        FROM device_sessions d
        JOIN device_account_slots s
          ON s.id = d.active_slot_id AND s.device_session_id = d.id AND s.revoked_at IS NULL
        JOIN users u ON u.id = s.user_id AND u.is_active = 1 AND u.status = 'active'
          AND u.must_change_password = 0 AND s.password_stamp = u.password_changed_at
        WHERE d.secret_hash = ? AND d.revoked_at IS NULL AND d.expires_at > ?
      `).get(hash(secret), Date.now()) as DevicePrincipal | undefined;
      if (!row) return null;
      const wallet = readSnapshotInCurrentTransaction(row.deviceSessionId);
      if (!wallet || wallet.generation !== row.generation
          || wallet.activeSlotId !== row.slotId) return null;
      return { principal: row, wallet };
    })();
  },

  snapshot(sessionId: string): AccountWalletSnapshot | null {
    return readSnapshot(sessionId);
  },

  slotIdForUser(sessionId: string, userId: number): string | null {
    const row = getConnection().prepare(`
      SELECT id FROM device_account_slots
      WHERE device_session_id = ? AND user_id = ? AND revoked_at IS NULL
    `).get(sessionId, userId) as { id: string } | undefined;
    return row?.id ?? null;
  },

  deviceSessionIdsForUser(userId: number): string[] {
    const rows = getConnection().prepare(`
      SELECT DISTINCT device_session_id AS deviceSessionId
      FROM device_account_slots WHERE user_id = ?
    `).all(userId) as Array<{ deviceSessionId: string }>;
    return rows.map((row) => row.deviceSessionId);
  },

  isPrincipalCurrent(principal: DevicePrincipal): boolean {
    const row = getConnection().prepare(`
      SELECT 1
      FROM device_sessions d
      JOIN device_account_slots s
        ON s.id = d.active_slot_id AND s.device_session_id = d.id AND s.revoked_at IS NULL
      JOIN users u ON u.id = s.user_id AND u.is_active = 1 AND u.status = 'active'
        AND u.must_change_password = 0 AND s.password_stamp = u.password_changed_at
      WHERE d.id = ? AND d.active_slot_id = ? AND d.generation = ?
        AND s.user_id = ? AND u.authorization_generation = ?
        AND d.revoked_at IS NULL AND d.expires_at > ?
    `).get(
      principal.deviceSessionId,
      principal.slotId,
      principal.generation,
      principal.userId,
      principal.authorizationGeneration,
      Date.now(),
    );
    return Boolean(row);
  },

  switch(principal: DevicePrincipal, slotId: string, expectedGeneration: number): AccountWalletSnapshot {
    return inImmediateTransaction(() => {
      requirePrincipal(principal, expectedGeneration);
      const db = getConnection();
      const slot = db.prepare(`
        SELECT s.id FROM device_account_slots s
        JOIN users u ON u.id = s.user_id
        WHERE s.id = ? AND s.device_session_id = ? AND s.revoked_at IS NULL
          AND u.is_active = 1 AND u.status = 'active' AND u.must_change_password = 0
          AND s.password_stamp = u.password_changed_at
      `).get(slotId, principal.deviceSessionId);
      if (!slot) throw new WalletConflictError('slot_not_found');
      const now = Date.now();
      db.prepare(`
        UPDATE device_sessions
        SET active_slot_id = ?, generation = generation + 1
        WHERE id = ?
      `).run(slotId, principal.deviceSessionId);
      db.prepare('UPDATE device_account_slots SET last_used_at = ? WHERE id = ?')
        .run(now, slotId);
      return readSnapshot(principal.deviceSessionId)!;
    });
  },

  add(
    principal: DevicePrincipal,
    userId: number,
    authenticatedPasswordStamp: number,
    expectedGeneration: number,
  ): AccountWalletSnapshot {
    return inImmediateTransaction(() => {
      requirePrincipal(principal, expectedGeneration);
      const db = getConnection();
      const user = db.prepare(`
        SELECT password_changed_at AS passwordStamp FROM users
        WHERE id = ? AND password_changed_at = ?
          AND is_active = 1 AND status = 'active' AND must_change_password = 0
      `).get(userId, authenticatedPasswordStamp) as { passwordStamp: number } | undefined;
      if (!user || !Number.isSafeInteger(user.passwordStamp)) {
        throw new WalletConflictError('account_credentials_changed');
      }
      const existing = db.prepare(`
        SELECT id, revoked_at AS revokedAt FROM device_account_slots
        WHERE device_session_id = ? AND user_id = ?
      `).get(principal.deviceSessionId, userId) as { id: string; revokedAt: number | null } | undefined;
      if (existing?.revokedAt === null) throw new WalletConflictError('account_already_added');
      const count = db.prepare(`
        SELECT COUNT(*) AS count FROM device_account_slots
        WHERE device_session_id = ? AND revoked_at IS NULL
      `).get(principal.deviceSessionId) as { count: number };
      if (count.count >= MAX_ACCOUNT_SLOTS) {
        throw new WalletConflictError('account_limit_reached');
      }
      const now = Date.now();
      if (existing) {
        db.prepare(`
          UPDATE device_account_slots
          SET revoked_at = NULL, last_used_at = ?, password_stamp = ?
          WHERE id = ?
        `).run(now, user.passwordStamp, existing.id);
      } else {
        db.prepare(`
          INSERT INTO device_account_slots(
            id, device_session_id, user_id, created_at, last_used_at, password_stamp
          ) VALUES(?, ?, ?, ?, ?, ?)
        `).run(id('slot'), principal.deviceSessionId, userId, now, now, user.passwordStamp);
      }
      db.prepare('UPDATE device_sessions SET generation = generation + 1 WHERE id = ?')
        .run(principal.deviceSessionId);
      return readSnapshot(principal.deviceSessionId)!;
    });
  },

  remove(principal: DevicePrincipal, slotId: string, expectedGeneration: number): AccountWalletSnapshot {
    return inImmediateTransaction(() => {
      const current = requirePrincipal(principal, expectedGeneration);
      if (current.activeSlotId === slotId) {
        throw new WalletConflictError('active_slot_cannot_be_removed');
      }
      const db = getConnection();
      const changed = db.prepare(`
        UPDATE device_account_slots SET revoked_at = ?
        WHERE id = ? AND device_session_id = ? AND revoked_at IS NULL
      `).run(Date.now(), slotId, principal.deviceSessionId);
      if (!changed.changes) throw new WalletConflictError('slot_not_found');
      db.prepare('UPDATE device_sessions SET generation = generation + 1 WHERE id = ?')
        .run(principal.deviceSessionId);
      return readSnapshot(principal.deviceSessionId)!;
    });
  },

  logout(principal: DevicePrincipal, expectedGeneration: number, all = false): {
    signedOutSlotId: string | null;
    wallet: AccountWalletSnapshot | null;
  } {
    return inImmediateTransaction(() => {
      const current = requirePrincipal(principal, expectedGeneration);
      const db = getConnection();
      const now = Date.now();
      if (all) {
        db.prepare('UPDATE device_sessions SET active_slot_id = NULL WHERE id = ?')
          .run(principal.deviceSessionId);
        db.prepare(`
          UPDATE device_account_slots SET revoked_at = ?
          WHERE device_session_id = ? AND revoked_at IS NULL
        `).run(now, principal.deviceSessionId);
        db.prepare(`
          UPDATE device_sessions SET revoked_at = ?, generation = generation + 1
          WHERE id = ?
        `).run(now, principal.deviceSessionId);
        return { signedOutSlotId: current.activeSlotId, wallet: null };
      }

      const active = current.activeSlotId;
      db.prepare('UPDATE device_sessions SET active_slot_id = NULL WHERE id = ?')
        .run(principal.deviceSessionId);
      if (active) {
        db.prepare('UPDATE device_account_slots SET revoked_at = ? WHERE id = ?')
          .run(now, active);
      }
      const fallback = db.prepare(`
        SELECT s.id FROM device_account_slots s
        JOIN users u ON u.id = s.user_id
        WHERE s.device_session_id = ? AND s.revoked_at IS NULL
          AND u.is_active = 1 AND u.status = 'active' AND u.must_change_password = 0
          AND s.password_stamp = u.password_changed_at
        ORDER BY s.last_used_at DESC, s.id ASC LIMIT 1
      `).get(principal.deviceSessionId) as { id: string } | undefined;
      db.prepare(`
        UPDATE device_sessions
        SET active_slot_id = ?, generation = generation + 1
        WHERE id = ?
      `).run(fallback?.id ?? null, principal.deviceSessionId);
      return { signedOutSlotId: active, wallet: readSnapshot(principal.deviceSessionId)! };
    });
  },

  /** Changes a password and atomically rotates or revokes every linked slot. */
  rotatePassword(
    userId: number,
    passwordHash: string,
    changedAt: number,
    preserveSlotId: string | null,
    forceChange: boolean,
  ): Array<{ deviceSessionId: string; generation: number }> {
    return inImmediateTransaction(() => {
      const db = getConnection();
      const affected = db.prepare(`
        SELECT DISTINCT device_session_id AS deviceSessionId
        FROM device_account_slots WHERE user_id = ? AND revoked_at IS NULL
      `).all(userId) as Array<{ deviceSessionId: string }>;

      db.prepare(`
        UPDATE device_sessions SET active_slot_id = NULL
        WHERE active_slot_id IN (
          SELECT id FROM device_account_slots
          WHERE user_id = ? AND revoked_at IS NULL AND (? IS NULL OR id != ?)
        )
      `).run(userId, preserveSlotId, preserveSlotId);
      db.prepare(`
        UPDATE users
        SET password_hash = ?, password_changed_at = ?, must_change_password = ?
        WHERE id = ?
      `).run(passwordHash, changedAt, forceChange ? 1 : 0, userId);
      db.prepare(`
        UPDATE device_account_slots SET revoked_at = ?
        WHERE user_id = ? AND revoked_at IS NULL AND (? IS NULL OR id != ?)
      `).run(changedAt, userId, preserveSlotId, preserveSlotId);
      if (preserveSlotId) {
        db.prepare(`
          UPDATE device_account_slots SET password_stamp = ?
          WHERE id = ? AND user_id = ? AND revoked_at IS NULL
        `).run(changedAt, preserveSlotId, userId);
      }

      const fallback = db.prepare(`
        SELECT s.id FROM device_account_slots s
        JOIN users u ON u.id = s.user_id
        WHERE s.device_session_id = ? AND s.revoked_at IS NULL
          AND u.is_active = 1 AND u.status = 'active' AND u.must_change_password = 0
          AND s.password_stamp = u.password_changed_at
        ORDER BY s.last_used_at DESC, s.id ASC LIMIT 1
      `);
      for (const { deviceSessionId } of affected) {
        const session = db.prepare(`
          SELECT active_slot_id AS activeSlotId FROM device_sessions
          WHERE id = ? AND revoked_at IS NULL
        `).get(deviceSessionId) as { activeSlotId: string | null } | undefined;
        if (!session) continue;
        if (!session.activeSlotId) {
          const next = fallback.get(deviceSessionId) as { id: string } | undefined;
          db.prepare('UPDATE device_sessions SET active_slot_id = ? WHERE id = ?')
            .run(next?.id ?? null, deviceSessionId);
        }
        db.prepare('UPDATE device_sessions SET generation = generation + 1 WHERE id = ?')
          .run(deviceSessionId);
      }
      return affected.map(({ deviceSessionId }) => {
        const row = db.prepare('SELECT generation FROM device_sessions WHERE id = ?')
          .get(deviceSessionId) as { generation: number };
        return { deviceSessionId, generation: row.generation };
      });
    });
  },
};

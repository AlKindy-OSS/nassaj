import type { Database } from 'better-sqlite3';

import {
  assertReleaseSchemaComponentTransaction,
  assertReleaseSchemaObjectsAbsent,
} from './release-schema-component-state.js';

export const DEVICE_ACCOUNT_SESSIONS_SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS device_sessions (
      id TEXT PRIMARY KEY,
      secret_hash TEXT NOT NULL UNIQUE,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER,
      active_slot_id TEXT,
      generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),
      created_at INTEGER NOT NULL,
      FOREIGN KEY (active_slot_id) REFERENCES device_account_slots(id)
    );
    CREATE TABLE IF NOT EXISTS device_account_slots (
      id TEXT PRIMARY KEY,
      device_session_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL,
      password_stamp INTEGER NOT NULL,
      revoked_at INTEGER,
      FOREIGN KEY (device_session_id) REFERENCES device_sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT,
      UNIQUE(device_session_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_device_slots_session ON device_account_slots(device_session_id, revoked_at);
    CREATE TRIGGER IF NOT EXISTS device_session_active_slot_valid_insert
    BEFORE INSERT ON device_sessions WHEN NEW.active_slot_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM device_account_slots WHERE id=NEW.active_slot_id AND device_session_id=NEW.id AND revoked_at IS NULL
    ) BEGIN SELECT RAISE(ABORT, 'device_active_slot_invalid'); END;
    CREATE TRIGGER IF NOT EXISTS device_session_active_slot_valid_update
    BEFORE UPDATE OF active_slot_id ON device_sessions WHEN NEW.active_slot_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM device_account_slots WHERE id=NEW.active_slot_id AND device_session_id=NEW.id AND revoked_at IS NULL
    ) BEGIN SELECT RAISE(ABORT, 'device_active_slot_invalid'); END;
    CREATE TRIGGER IF NOT EXISTS device_slot_cannot_revoke_active
    BEFORE UPDATE OF revoked_at ON device_account_slots WHEN NEW.revoked_at IS NOT NULL AND EXISTS (
      SELECT 1 FROM device_sessions WHERE active_slot_id=OLD.id AND revoked_at IS NULL
    ) BEGIN SELECT RAISE(ABORT, 'device_active_slot_revocation'); END;
  `;

export const DEVICE_ACCOUNT_SESSIONS_OWNED_OBJECTS = Object.freeze([
  'device_account_slots',
  'device_session_active_slot_valid_insert',
  'device_session_active_slot_valid_update',
  'device_sessions',
  'device_slot_cannot_revoke_active',
  'idx_device_slots_session',
]);

/** Execute the canonical additive account-wallet DDL against an explicitly supplied database. */
export function createDeviceAccountSessionsFresh(db: Database): void {
  db.exec(DEVICE_ACCOUNT_SESSIONS_SCHEMA_SQL);
}

/** Apply account-wallet storage only from its reviewed all-absent source state. */
export function applyDeviceAccountSessionsComponent(db: Database): void {
  assertReleaseSchemaComponentTransaction(db);
  assertReleaseSchemaObjectsAbsent(db, 'device-account-sessions', DEVICE_ACCOUNT_SESSIONS_OWNED_OBJECTS);
  createDeviceAccountSessionsFresh(db);
}

/** Adds the additive, server-side account wallet tables from ADR-163. */
export function migrateDeviceAccountSessions(db: Database): void {
  createDeviceAccountSessionsFresh(db);

  // Compatibility for databases that briefly received the pre-ADR field name.
  const columns = db.prepare('PRAGMA table_info(device_sessions)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'generation')) {
    db.exec('ALTER TABLE device_sessions ADD COLUMN generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0)');
    if (columns.some((column) => column.name === 'version')) {
      db.exec('UPDATE device_sessions SET generation = version');
    }
  }
  const slotColumns = db.prepare('PRAGMA table_info(device_account_slots)').all() as Array<{ name: string }>;
  if (!slotColumns.some((column) => column.name === 'password_stamp')) {
    db.exec('ALTER TABLE device_account_slots ADD COLUMN password_stamp INTEGER');
    db.exec(`
      UPDATE device_account_slots
      SET password_stamp = (
        SELECT password_changed_at FROM users WHERE users.id = device_account_slots.user_id
      )
    `);
  }
}

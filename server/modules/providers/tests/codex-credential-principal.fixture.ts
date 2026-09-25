/** Synthetic database for real credential admission tests; never copies a legacy DB. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';

import Database from 'better-sqlite3';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-principal-'));
process.env.DATABASE_PATH = path.join(root, 'auth.db');
const seed = new Database(process.env.DATABASE_PATH);
seed.exec(`CREATE TABLE users (
  id INTEGER PRIMARY KEY, username TEXT NOT NULL, password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner', status TEXT NOT NULL DEFAULT 'active',
  is_active INTEGER NOT NULL DEFAULT 1, password_changed_at INTEGER
);
CREATE TABLE api_keys (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL,
  key_digest TEXT, is_active INTEGER NOT NULL DEFAULT 1);
INSERT INTO users (id, username, password_hash) VALUES (1, 'synthetic-owner', 'unused');`);
seed.close();
fs.chmodSync(process.env.DATABASE_PATH, 0o600);
const { getConnection, closeConnection, migratePermissionExecution } = await import('@/modules/database/index.js');
export const database = getConnection();
migratePermissionExecution(database);
const { setProviderSharingConfig } = await import('@/services/provider-sharing.js');
setProviderSharingConfig({ codex: 'shared' });
/** Canonical synthetic session principal, never inferred from the credential destination. */
export const principal = Object.freeze({
  id: 1, role: 'owner', authenticationKind: 'session', authorizationGeneration: 1,
});
after(() => { closeConnection(); fs.rmSync(root, { recursive: true, force: true }); });

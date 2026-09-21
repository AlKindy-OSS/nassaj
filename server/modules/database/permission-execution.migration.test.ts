import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import { migratePermissionExecution } from './permission-execution.migration.js';

const createLegacySchema = (database: Database): void => {
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      status TEXT NOT NULL DEFAULT 'active',
      is_active INTEGER NOT NULL DEFAULT 1,
      password_changed_at INTEGER,
      last_login INTEGER
    );
    CREATE TABLE api_keys (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      key_digest TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    INSERT INTO users (id, username, password_hash) VALUES (1, 'owner', 'hash');
  `);
};

test('permission execution migration is additive and idempotent', () => {
  const database = new Database(':memory:');
  try {
    createLegacySchema(database);
    migratePermissionExecution(database);
    migratePermissionExecution(database);

    const generation = database.prepare(
      'SELECT authorization_generation AS value FROM users WHERE id = ?',
    ).get(1) as { value: number };
    assert.equal(generation.value, 1);
    assert.ok(database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get('permission_launch_decisions'));
  } finally {
    database.close();
  }
});

test('security mutations advance authorization generation atomically', () => {
  const database = new Database(':memory:');
  try {
    createLegacySchema(database);
    migratePermissionExecution(database);
    database.prepare('UPDATE users SET role = ? WHERE id = ?').run('admin', 1);
    database.prepare(
      'INSERT INTO api_keys (id, user_id, key_digest) VALUES (?, ?, ?)',
    ).run(10, 1, 'digest-a');
    database.prepare('UPDATE api_keys SET is_active = ? WHERE id = ?').run(0, 10);
    database.prepare('DELETE FROM api_keys WHERE id = ?').run(10);

    const row = database.prepare(
      'SELECT authorization_generation AS value FROM users WHERE id = ?',
    ).get(1) as { value: number };
    assert.equal(row.value, 5);
  } finally {
    database.close();
  }
});

test('legacy users-only migration defers API-key triggers until that table exists', () => {
  const database = new Database(':memory:');
  try {
    database.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        username TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        status TEXT NOT NULL DEFAULT 'active',
        is_active INTEGER NOT NULL DEFAULT 1,
        password_changed_at INTEGER
      );
      INSERT INTO users (id, username, password_hash) VALUES (1, 'legacy', 'hash');
    `);

    assert.doesNotThrow(() => migratePermissionExecution(database));
    assert.equal(database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?",
    ).get('trg_api_keys_authorization_generation_insert'), undefined);

    database.exec(`
      CREATE TABLE api_keys (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL,
        key_digest TEXT,
        is_active INTEGER NOT NULL DEFAULT 1
      );
    `);
    migratePermissionExecution(database);
    database.prepare(
      'INSERT INTO api_keys (id, user_id, key_digest) VALUES (?, ?, ?)',
    ).run(1, 1, 'digest-later');

    const row = database.prepare(
      'SELECT authorization_generation AS value FROM users WHERE id = ?',
    ).get(1) as { value: number };
    assert.equal(row.value, 2);
  } finally {
    database.close();
  }
});

test('non-security last_login updates do not advance authorization generation', () => {
  const database = new Database(':memory:');
  try {
    createLegacySchema(database);
    migratePermissionExecution(database);

    database.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(1_000, 1);
    database.prepare('UPDATE users SET username = ? WHERE id = ?').run('owner-renamed', 1);

    const row = database.prepare(
      'SELECT authorization_generation AS value FROM users WHERE id = ?',
    ).get(1) as { value: number };
    assert.equal(row.value, 1);
  } finally {
    database.close();
  }
});

test('migration rolls back the added user column when schema installation fails', () => {
  const database = new Database(':memory:');
  try {
    createLegacySchema(database);
    database.exec(`
      CREATE TABLE permission_launch_decisions (
        decision_id TEXT PRIMARY KEY
      );
    `);

    assert.throws(
      () => migratePermissionExecution(database),
      /no such column: state/,
    );

    const userColumns = database.prepare('PRAGMA table_info(users)').all() as Array<{
      name: string;
    }>;
    assert.equal(
      userColumns.some(({ name }) => name === 'authorization_generation'),
      false,
    );
    assert.equal(database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get('permission_admission_leases'), undefined);
  } finally {
    database.close();
  }
});

test('durable constraints reject duplicate leases and concurrent open transitions', () => {
  const database = new Database(':memory:');
  try {
    createLegacySchema(database);
    migratePermissionExecution(database);
    database.prepare(`INSERT INTO permission_launch_decisions (
      decision_id, user_id, principal_id, authentication_kind, authorization_generation,
      launch_id, project_id, workspace_digest, provider, body, engine, entrypoint,
      purpose, requested_profile, contract_version,
      profile_digest, capability_digest, release_build, protocol_generation, verdict, state,
      created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('d1', 1, 'user:1', 'session', 1, 'launch-1', 'project-1',
        '1234567890abcdef', 'codex', 'codex', 'sdk', 'ws.chat',
        'sdk_turn', 'full_delegation', 'permission-parity/v1', 'profile-digest',
        'capability-digest', 'dev', 1, 'authorized', 'authorized', 1, 1);
    const insertLease = database.prepare(`INSERT INTO permission_admission_leases (
      lease_id, decision_id, purpose, protocol_generation, owner_id, owner_pid,
      owner_boot_id, owner_start_ticks, effect_identity, status, expires_at_ms,
      created_at_ms, updated_at_ms
    ) VALUES (?, ?, 'sdk_turn', 1, 'owner', 7, 'boot', 'ticks', ?, 'issued', 100, 1, 1)`);
    insertLease.run('l1', 'd1', 'effect-1');
    assert.throws(() => insertLease.run('l2', 'd1', 'effect-2'), /UNIQUE constraint failed/);

    const insertTransition = database.prepare(`INSERT INTO permission_rollout_transitions (
      transition_id, from_profile, to_profile, from_generation, to_generation,
      manifest_digest, contract_version, profile_digest, capability_digest,
      state, created_at_ms, updated_at_ms
    ) VALUES (?, 'legacy', 'shadow', 1, 2, ?, 'permission-parity/v1',
      'profile-digest', 'capability-digest', 'prepared', 1, 1)`);
    insertTransition.run('t1', 'manifest-a');
    assert.throws(() => insertTransition.run('t2', 'manifest-b'), /UNIQUE constraint failed/);
  } finally {
    database.close();
  }
});

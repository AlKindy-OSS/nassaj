import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { runMigrations } from '@/modules/database/migrations.js';
import { userDb } from '@/modules/database/repositories/users.js';
import { invitesDb } from '@/modules/database/repositories/invites.js';
import { auditLogDb } from '@/modules/database/repositories/audit-log.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'auth-db-'));
  const databasePath = path.join(tempDirectory, 'db.sqlite');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

function tableColumns(db: ReturnType<typeof getConnection>, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

test('schema: users table has multi-user columns', async () => {
  await withIsolatedDatabase(() => {
    const cols = tableColumns(getConnection(), 'users');
    for (const col of ['role', 'status', 'invited_by']) {
      assert.ok(cols.includes(col), `users.${col} missing`);
    }
  });
});

test('schema: audit_log and invites tables exist', async () => {
  await withIsolatedDatabase(() => {
    const db = getConnection();
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    ).map((r) => r.name);
    assert.ok(names.includes('audit_log'));
    assert.ok(names.includes('invites'));
  });
});

test('migration: legacy single-user DB upgrades without data loss and promotes owner', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'auth-legacy-'));
  const databasePath = path.join(tempDirectory, 'db.sqlite');

  // Build a legacy users table (no role/status/invited_by) with one row.
  closeConnection();
  const legacy = new Database(databasePath);
  legacy.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_login DATETIME,
      is_active BOOLEAN DEFAULT 1
    );
  `);
  legacy.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run('legacy_admin', 'x');
  legacy.close();

  process.env.DATABASE_PATH = databasePath;
  try {
    const db = getConnection();
    runMigrations(db);

    const row = db
      .prepare('SELECT username, role, status FROM users WHERE username = ?')
      .get('legacy_admin') as { username: string; role: string; status: string };

    assert.equal(row.username, 'legacy_admin', 'existing row preserved');
    assert.equal(row.role, 'owner', 'first existing user promoted to owner');
    assert.equal(row.status, 'active');
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('userDb: createUser with role and getOwnerCount', async () => {
  await withIsolatedDatabase(() => {
    assert.equal(userDb.getOwnerCount(), 0);
    const owner = userDb.createUser('owner1', 'hash', 'owner');
    assert.equal(owner.role, 'owner');
    assert.equal(userDb.getOwnerCount(), 1);

    userDb.createUser('member', 'hash', 'user', owner.id);
    const list = userDb.listUsers();
    assert.equal(list.length, 2);
    assert.equal(list.find((u) => u.username === 'member')?.role, 'user');
  });
});

test('userDb: disabled user is not returned by id/username lookups', async () => {
  await withIsolatedDatabase(() => {
    const u = userDb.createUser('temp', 'hash', 'user');
    userDb.setStatus(u.id, 'disabled');
    assert.equal(userDb.getUserById(u.id), undefined);
    assert.equal(userDb.getUserByUsername('temp'), undefined);
  });
});

test('invitesDb: markAccepted is single-use (atomic)', async () => {
  await withIsolatedDatabase(() => {
    const owner = userDb.createUser('owner1', 'hash', 'owner');
    const now = '2999-01-01 00:00:00';
    invitesDb.create({
      tokenHash: 'abc',
      role: 'user',
      invitedBy: owner.id,
      expiresAt: '3000-01-01 00:00:00',
    });

    assert.equal(invitesDb.markAccepted('abc', owner.id, now), true, 'first accept succeeds');
    assert.equal(invitesDb.markAccepted('abc', owner.id, now), false, 'second accept fails');
  });
});

test('invitesDb: expired invite cannot be accepted', async () => {
  await withIsolatedDatabase(() => {
    const owner = userDb.createUser('owner1', 'hash', 'owner');
    invitesDb.create({
      tokenHash: 'exp',
      role: 'user',
      invitedBy: owner.id,
      expiresAt: '2000-01-01 00:00:00',
    });
    const now = '2026-01-01 00:00:00';
    assert.equal(invitesDb.markAccepted('exp', owner.id, now), false);
  });
});

test('invitesDb: list never exposes token_hash', async () => {
  await withIsolatedDatabase(() => {
    const owner = userDb.createUser('owner1', 'hash', 'owner');
    invitesDb.create({ tokenHash: 'secret', role: 'user', invitedBy: owner.id, expiresAt: '3000-01-01 00:00:00' });
    const rows = invitesDb.list();
    assert.equal(rows.length, 1);
    assert.ok(!('token_hash' in rows[0]));
  });
});

test('auditLogDb: records events and never throws on bad input', async () => {
  await withIsolatedDatabase(() => {
    auditLogDb.record('login_success', { userId: null, metadata: { ip: 'x' } });
    auditLogDb.record('bootstrap_owner', {});
    const recent = auditLogDb.recent(10);
    assert.equal(recent.length, 2);
    assert.ok(recent.some((r) => r.action === 'bootstrap_owner'));
  });
});

/**
 * Integration tests for userDb.deleteUser (T-116).
 *
 * deleteUser mirrors the schema's declared ON DELETE CASCADE / SET NULL
 * clauses explicitly (child tables first, single transaction) because SQLite
 * FK enforcement is per-connection and not guaranteed on every connection
 * path. These tests verify the full cleanup against a real migrated database.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { userDb } from '@/modules/database/repositories/users.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'users-delete-db-'));
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

test('deleteUser: removes the user row and returns true', async () => {
  await withIsolatedDatabase(() => {
    const victim = userDb.createUser('victim', 'hash', 'user');

    assert.equal(userDb.deleteUser(victim.id), true);
    assert.equal(userDb.getRawById(victim.id), undefined);
  });
});

test('deleteUser: returns false for a non-existent user', async () => {
  await withIsolatedDatabase(() => {
    assert.equal(userDb.deleteUser(9999), false);
  });
});

test('deleteUser: removes every referencing row (no orphans, FK enforcement irrelevant)', async () => {
  await withIsolatedDatabase(() => {
    const db = getConnection();
    // Deliberately disable FK enforcement on this connection so the test proves
    // the explicit cleanup works even where declared CASCADEs would not fire.
    db.pragma('foreign_keys = OFF');

    const owner = userDb.createUser('owner1', 'hash', 'owner');
    const victim = userDb.createUser('victim', 'hash', 'user');

    db.prepare(
      'INSERT INTO webauthn_credentials (id, user_id, public_key) VALUES (?, ?, ?)'
    ).run('cred1', victim.id, Buffer.from([1]));
    db.prepare("INSERT INTO projects (project_id, project_path) VALUES ('p1', '/tmp/p1')").run();
    db.prepare('INSERT INTO project_members (project_id, user_id) VALUES (?, ?)').run(
      'p1',
      victim.id
    );
    db.prepare('INSERT INTO starred_sessions (user_id, session_id) VALUES (?, ?)').run(
      victim.id,
      's1'
    );
    db.prepare(
      'INSERT INTO api_keys (user_id, key_name, api_key) VALUES (?, ?, ?)'
    ).run(victim.id, 'k', 'secret-1');
    db.prepare(
      'INSERT INTO user_credentials (user_id, credential_name, credential_type, credential_value) VALUES (?, ?, ?, ?)'
    ).run(victim.id, 'gh', 'github_token', 'v');
    db.prepare(
      'INSERT INTO user_notification_preferences (user_id, preferences_json) VALUES (?, ?)'
    ).run(victim.id, '{}');
    db.prepare(
      'INSERT INTO user_ui_preferences (user_id, preferences_json) VALUES (?, ?)'
    ).run(victim.id, '{}');
    db.prepare(
      'INSERT INTO push_subscriptions (user_id, endpoint, keys_p256dh, keys_auth) VALUES (?, ?, ?, ?)'
    ).run(victim.id, 'https://e/1', 'p', 'a');
    db.prepare(
      'INSERT INTO session_participants (session_id, user_id) VALUES (?, ?)'
    ).run('s1', victim.id);
    db.prepare(
      'INSERT INTO message_authors (session_id, user_id, content_hash, created_at) VALUES (?, ?, ?, ?)'
    ).run('s1', victim.id, 'h1', new Date().toISOString());
    db.prepare(
      "INSERT INTO invites (token_hash, invited_by, expires_at) VALUES ('t1', ?, '2030-01-01')"
    ).run(victim.id);
    db.prepare(
      "INSERT INTO invites (token_hash, invited_by, accepted_by, expires_at) VALUES ('t2', ?, ?, '2030-01-01')"
    ).run(owner.id, victim.id);
    db.prepare('INSERT INTO audit_log (user_id, action) VALUES (?, ?)').run(
      victim.id,
      'login_success'
    );

    assert.equal(userDb.deleteUser(victim.id), true);

    const cascadeTables = [
      'webauthn_credentials',
      'project_members',
      'starred_sessions',
      'api_keys',
      'user_credentials',
      'user_notification_preferences',
      'user_ui_preferences',
      'push_subscriptions',
      'session_participants',
      'message_authors',
    ];
    for (const table of cascadeTables) {
      const row = db
        .prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE user_id = ?`)
        .get(victim.id) as { c: number };
      assert.equal(row.c, 0, `${table} left orphaned rows`);
    }

    const invitesByVictim = db
      .prepare('SELECT COUNT(*) AS c FROM invites WHERE invited_by = ?')
      .get(victim.id) as { c: number };
    assert.equal(invitesByVictim.c, 0, 'invites.invited_by not cascaded');

    const acceptedBy = db
      .prepare("SELECT accepted_by FROM invites WHERE token_hash = 't2'")
      .get() as { accepted_by: number | null };
    assert.equal(acceptedBy.accepted_by, null, 'invites.accepted_by not nulled');

    const auditUserId = db
      .prepare("SELECT user_id FROM audit_log WHERE action = 'login_success'")
      .get() as { user_id: number | null };
    assert.equal(auditUserId.user_id, null, 'audit_log.user_id not nulled');

    // The other user and their invite row survive untouched.
    assert.ok(userDb.getRawById(owner.id));
    const ownerInvite = db
      .prepare("SELECT invited_by FROM invites WHERE token_hash = 't2'")
      .get() as { invited_by: number };
    assert.equal(ownerInvite.invited_by, owner.id);
  });
});

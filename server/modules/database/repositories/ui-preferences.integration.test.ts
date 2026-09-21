import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { uiPreferencesDb } from '@/modules/database/repositories/ui-preferences.js';
import { userDb } from '@/modules/database/repositories/users.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'ui-preferences-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

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

test('a new user has empty preferences and reading does not create a row', async () => {
  await withIsolatedDatabase(() => {
    const alice = userDb.createUser('alice', 'hash', 'user').id;

    assert.deepEqual(uiPreferencesDb.getUiPreferences(alice), {});

    const row = getConnection()
      .prepare('SELECT 1 FROM user_ui_preferences WHERE user_id = ?')
      .get(alice);
    assert.equal(row, undefined);
  });
});

test('save then read round-trips the stored object', async () => {
  await withIsolatedDatabase(() => {
    const alice = userDb.createUser('alice', 'hash', 'user').id;

    const saved = uiPreferencesDb.updateUiPreferences(alice, {
      theme: 'dark',
      sidebarCollapsed: true,
      fontScale: 1.25,
    });

    assert.deepEqual(saved, { theme: 'dark', sidebarCollapsed: true, fontScale: 1.25 });
    assert.deepEqual(uiPreferencesDb.getUiPreferences(alice), {
      theme: 'dark',
      sidebarCollapsed: true,
      fontScale: 1.25,
    });
  });
});

test('partial update merges over stored keys instead of replacing them', async () => {
  await withIsolatedDatabase(() => {
    const alice = userDb.createUser('alice', 'hash', 'user').id;

    uiPreferencesDb.updateUiPreferences(alice, { theme: 'dark', lang: 'ar' });
    // Partial PUT only touches `theme`; `lang` must survive.
    const merged = uiPreferencesDb.updateUiPreferences(alice, { theme: 'light' });

    assert.deepEqual(merged, { theme: 'light', lang: 'ar' });
    assert.deepEqual(uiPreferencesDb.getUiPreferences(alice), { theme: 'light', lang: 'ar' });
  });
});

test('preferences are isolated between users', async () => {
  await withIsolatedDatabase(() => {
    const alice = userDb.createUser('alice', 'hash', 'user').id;
    const bob = userDb.createUser('bob', 'hash', 'user').id;

    uiPreferencesDb.updateUiPreferences(alice, { theme: 'dark' });

    assert.deepEqual(uiPreferencesDb.getUiPreferences(alice), { theme: 'dark' });
    // Bob never set anything; alice's prefs must not leak.
    assert.deepEqual(uiPreferencesDb.getUiPreferences(bob), {});
  });
});

test('non-object input is rejected', async () => {
  await withIsolatedDatabase(() => {
    const alice = userDb.createUser('alice', 'hash', 'user').id;

    assert.throws(() => uiPreferencesDb.updateUiPreferences(alice, 'nope'), TypeError);
    assert.throws(() => uiPreferencesDb.updateUiPreferences(alice, 42), TypeError);
    assert.throws(() => uiPreferencesDb.updateUiPreferences(alice, [1, 2, 3]), TypeError);
    assert.throws(() => uiPreferencesDb.updateUiPreferences(alice, null), TypeError);
  });
});

test('oversized payload is rejected', async () => {
  await withIsolatedDatabase(() => {
    const alice = userDb.createUser('alice', 'hash', 'user').id;
    const huge = { blob: 'x'.repeat(70 * 1024) };

    assert.throws(() => uiPreferencesDb.updateUiPreferences(alice, huge), /too large/);
  });
});

test('deleting a user cascades and clears their preferences', async () => {
  await withIsolatedDatabase(() => {
    const alice = userDb.createUser('alice', 'hash', 'user').id;
    uiPreferencesDb.updateUiPreferences(alice, { theme: 'dark' });

    const before = getConnection()
      .prepare('SELECT 1 FROM user_ui_preferences WHERE user_id = ?')
      .get(alice);
    assert.notEqual(before, undefined);

    getConnection().prepare('DELETE FROM users WHERE id = ?').run(alice);

    const after = getConnection()
      .prepare('SELECT 1 FROM user_ui_preferences WHERE user_id = ?')
      .get(alice);
    assert.equal(after, undefined);
  });
});

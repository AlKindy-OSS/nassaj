import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import {
  backupDatabaseBeforeRebuild,
  migrateApiKeysToDigests,
  migrateLegacySessionNames,
  migrateUserCredentialsEncryption,
} from '@/modules/database/migrations.js';

async function withDiskDatabase(
  run: (db: Database.Database, directory: string) => void | Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'migration-backup-'));
  const db = new Database(path.join(directory, 'auth.db'));
  db.exec('CREATE TABLE sentinel (value TEXT NOT NULL); INSERT INTO sentinel VALUES (\'preserved\')');
  try {
    await run(db, directory);
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test('required backup is owner-only, durable, and passes SQLite integrity', async () => {
  await withDiskDatabase((db, directory) => {
    const target = backupDatabaseBeforeRebuild(db, 'rebuild-projects');
    assert.ok(target);
    const backupDirectory = path.join(directory, 'migration-backups');
    assert.equal(fs.statSync(backupDirectory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
    const snapshot = new Database(target, { readonly: true, fileMustExist: true });
    try {
      assert.equal(snapshot.pragma('integrity_check', { simple: true }), 'ok');
      assert.deepEqual(snapshot.prepare('SELECT value FROM sentinel').all(), [{ value: 'preserved' }]);
    } finally {
      snapshot.close();
    }
  });
});

test('disk-full and permission failures are fatal and leave source data untouched', async () => {
  for (const code of ['ENOSPC', 'EACCES']) {
    await withDiskDatabase((db) => {
      assert.throws(
        () => backupDatabaseBeforeRebuild(db, 'session-agents-cascade', {
          vacuumInto: () => {
            const error = new Error(code) as NodeJS.ErrnoException;
            error.code = code;
            throw error;
          },
        }),
        /migration_backup_required/,
      );
      assert.deepEqual(db.prepare('SELECT value FROM sentinel').all(), [{ value: 'preserved' }]);
    });
  }
});

test('integrity or fsync failure deletes only the failed candidate and preserves known-good backup', async () => {
  await withDiskDatabase((db, directory) => {
    const knownGood = backupDatabaseBeforeRebuild(db, 'rebuild-projects');
    assert.ok(knownGood && fs.existsSync(knownGood));

    assert.throws(
      () => backupDatabaseBeforeRebuild(db, 'rebuild-sessions', { verifyIntegrity: () => false }),
      /migration_backup_required/,
    );
    assert.ok(fs.existsSync(knownGood));

    assert.throws(
      () => backupDatabaseBeforeRebuild(db, 'connectors-unique-scope', {
        fsyncFile: () => { throw new Error('synthetic_fsync_failure'); },
      }),
      /migration_backup_required/,
    );
    assert.ok(fs.existsSync(knownGood));
    assert.deepEqual(
      fs.readdirSync(path.join(directory, 'migration-backups')).filter((name) => name.endsWith('.sqlite')),
      [path.basename(knownGood)],
    );
  });
});

test('retention is bounded and always preserves the newest verified snapshot', async () => {
  await withDiskDatabase((db, directory) => {
    let newest = '';
    for (let index = 0; index < 8; index += 1) {
      newest = backupDatabaseBeforeRebuild(db, 'rebuild-sessions', {
        now: () => new Date(Date.UTC(2030, 0, 1, 0, 0, index)),
      }) ?? '';
    }
    const retained = fs.readdirSync(path.join(directory, 'migration-backups'))
      .filter((name) => name.endsWith('.sqlite'));
    assert.equal(retained.length, 5);
    assert.ok(retained.includes(path.basename(newest)));
  });
});

test('destructive migration caller stops before DROP when required backup cannot be created', async () => {
  await withDiskDatabase((db, directory) => {
    db.exec(`
      CREATE TABLE sessions (session_id TEXT PRIMARY KEY, provider TEXT, custom_name TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE session_names (session_id TEXT PRIMARY KEY, provider TEXT, custom_name TEXT, created_at TEXT, updated_at TEXT);
      INSERT INTO session_names VALUES ('synthetic-session', 'claude', 'Name', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
    `);
    fs.writeFileSync(path.join(directory, 'migration-backups'), 'blocks-directory-creation', { mode: 0o600 });
    assert.throws(() => migrateLegacySessionNames(db), /migration_backup_required/);
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_names'").get());
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number }).count,
      0,
    );
  });
});

test('the first retained snapshot is created only after legacy secrets are transformed', async () => {
  const previousKey = process.env.NASSAJ_PROVIDER_SECRETS_KEY;
  process.env.NASSAJ_PROVIDER_SECRETS_KEY = Buffer.alloc(32, 7).toString('base64');
  try {
    await withDiskDatabase((db) => {
      const apiMarker = `ck_${'d'.repeat(64)}`;
      const credentialMarker = 'synthetic-plaintext-credential-marker';
      db.exec(`
        CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL);
        INSERT INTO users VALUES (1, 'synthetic-owner');
        CREATE TABLE app_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO app_config VALUES ('external_api.enabled', '1');
        CREATE TABLE api_keys (
          id INTEGER PRIMARY KEY,
          user_id INTEGER NOT NULL,
          key_name TEXT NOT NULL,
          api_key TEXT NOT NULL,
          created_at DATETIME,
          last_used DATETIME,
          is_active BOOLEAN DEFAULT 1
        );
        CREATE TABLE user_credentials (
          id INTEGER PRIMARY KEY,
          user_id INTEGER NOT NULL,
          credential_type TEXT NOT NULL,
          credential_value TEXT NOT NULL
        );
      `);
      db.prepare('INSERT INTO api_keys VALUES (1, 1, ?, ?, CURRENT_TIMESTAMP, NULL, 1)')
        .run('Synthetic', apiMarker);
      db.prepare('INSERT INTO user_credentials VALUES (1, 1, ?, ?)')
        .run('github_token', credentialMarker);

      migrateApiKeysToDigests(db);
      migrateUserCredentialsEncryption(db);
      const target = backupDatabaseBeforeRebuild(db, 'connectors-unique-scope');
      assert.ok(target);

      const snapshot = new Database(target, { readonly: true, fileMustExist: true });
      try {
        const apiColumns = snapshot.pragma('table_info(api_keys)') as Array<{ name: string }>;
        assert.ok(!apiColumns.some((column) => column.name === 'api_key'));
        assert.ok(apiColumns.some((column) => column.name === 'key_digest'));
        const storedCredential = snapshot
          .prepare('SELECT credential_value FROM user_credentials WHERE id = 1')
          .pluck()
          .get() as string;
        assert.match(storedCredential, /^dbcred:v1:/);
        assert.notEqual(storedCredential, credentialMarker);
      } finally {
        snapshot.close();
      }

      const bytes = fs.readFileSync(target);
      assert.equal(bytes.includes(Buffer.from(apiMarker)), false);
      assert.equal(bytes.includes(Buffer.from(credentialMarker)), false);
    });
  } finally {
    if (previousKey === undefined) delete process.env.NASSAJ_PROVIDER_SECRETS_KEY;
    else process.env.NASSAJ_PROVIDER_SECRETS_KEY = previousKey;
  }
});

test('backup rejects unapproved labels and insecure directory or file identities', async () => {
  await withDiskDatabase((db, directory) => {
    assert.throws(() => backupDatabaseBeforeRebuild(db, '../outside'), /migration_backup_label_invalid/);

    const outside = path.join(directory, 'outside');
    fs.mkdirSync(outside, { mode: 0o700 });
    fs.symlinkSync(outside, path.join(directory, 'migration-backups'));
    assert.throws(
      () => backupDatabaseBeforeRebuild(db, 'rebuild-projects'),
      /migration_backup_required/,
    );
    fs.unlinkSync(path.join(directory, 'migration-backups'));

    assert.throws(
      () => backupDatabaseBeforeRebuild(db, 'rebuild-projects', {
        expectedUid: (process.geteuid?.() ?? process.getuid?.() ?? 0) + 1,
      }),
      /migration_backup_required/,
    );

    assert.throws(
      () => backupDatabaseBeforeRebuild(db, 'rebuild-projects', {
        vacuumInto: (_database, target) => {
          fs.writeFileSync(target, Buffer.alloc(64), { mode: 0o600 });
          fs.linkSync(target, `${target}.linked`);
        },
      }),
      /migration_backup_required/,
    );
  });
});

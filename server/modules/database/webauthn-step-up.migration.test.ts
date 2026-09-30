/**
 * Passkey step-up eligibility column (T-1939 slice 6A, B-1407): additive,
 * idempotent, existing passkeys stay NOT eligible, explicit rollback.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import { WEBAUTHN_CREDENTIALS_TABLE_SCHEMA_SQL } from './schema.js';
import {
  migrateWebAuthnStepUpEligible,
  rollbackWebAuthnStepUpEligible,
} from './webauthn-step-up.migration.js';

const columns = (db: Database.Database) => (db.prepare('PRAGMA table_info(webauthn_credentials)').all() as
  Array<{ name: string }>).map((column) => column.name);

test('adds step_up_eligible DEFAULT 0: existing passkeys are not eligible; idempotent; rollback', () => {
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT)');
    db.exec(WEBAUTHN_CREDENTIALS_TABLE_SCHEMA_SQL);
    db.exec("INSERT INTO users (username) VALUES ('legacy')");
    db.prepare('INSERT INTO webauthn_credentials (id, user_id, public_key) VALUES (?, 1, ?)')
      .run('legacy-cred', Buffer.from([1]));

    migrateWebAuthnStepUpEligible(db);
    migrateWebAuthnStepUpEligible(db);
    assert.equal(columns(db).filter((name) => name === 'step_up_eligible').length, 1);
    assert.deepEqual(db.prepare('SELECT step_up_eligible FROM webauthn_credentials').get(),
      { step_up_eligible: 0 });
    assert.throws(() => db.prepare('UPDATE webauthn_credentials SET step_up_eligible = NULL').run(),
      /NOT NULL/);

    rollbackWebAuthnStepUpEligible(db);
    rollbackWebAuthnStepUpEligible(db);
    assert.ok(!columns(db).includes('step_up_eligible'));
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM webauthn_credentials').get() as { n: number }).n, 1,
      'rollback keeps the passkeys');
  } finally { db.close(); }
});

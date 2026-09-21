import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import { inspectExistingSecurityState } from './existing-security-state.js';

const fixture = () => {
  const database = new Database(':memory:');
  database.exec('CREATE TABLE app_config(key TEXT PRIMARY KEY, value TEXT); CREATE TABLE session_workspace_modes(session_id TEXT,project_path TEXT,mode TEXT)');
  database.exec("CREATE TABLE users(role TEXT); INSERT INTO users VALUES ('owner'); CREATE TABLE vapid_keys(id INTEGER,public_key TEXT,private_key TEXT); INSERT INTO vapid_keys VALUES (1,'public-fixture','private-fixture');");
  database.prepare('INSERT INTO app_config VALUES (?, ?)').run('jwt_secret', 'x'.repeat(64));
  return database;
};

test('existing startup inspection is read-only and rejects enabling shadow initialization', () => {
  const database = fixture();
  try {
    const before = database.serialize(); database.pragma('query_only = ON');
    assert.deepEqual(inspectExistingSecurityState(database, {}), { policyId: 'existing-security-state/v1' });
    assert.throws(() => inspectExistingSecurityState(database, { NASSAJ_UNIVERSAL_CONVERSATIONS_SHADOW: '1' }), /shadow_requires_initialization/);
    assert.deepEqual(database.serialize(), before);
  } finally { database.close(); }
});

test('existing JWT inspection never creates missing app_config or secrets and respects environment precedence', () => {
  const database = fixture();
  try {
    database.prepare('DELETE FROM app_config WHERE key = ?').run('jwt_secret');
    database.pragma('query_only = ON');
    assert.throws(() => inspectExistingSecurityState(database, {}), /jwt_missing_or_invalid/);
    assert.throws(() => inspectExistingSecurityState(database, { JWT_SECRET: 'short' }), /jwt_invalid/);
    assert.equal(inspectExistingSecurityState(database, { JWT_SECRET: 'e'.repeat(32) }).policyId, 'existing-security-state/v1');
    assert.deepEqual(database.prepare('SELECT * FROM app_config').all(), []);
    database.pragma('query_only = OFF'); database.exec('DROP TABLE app_config'); database.pragma('query_only = ON');
    assert.throws(() => inspectExistingSecurityState(database, { JWT_SECRET: 'e'.repeat(32) }), /app_config_missing/);
  } finally { database.close(); }
});

test('existing startup rejects every required overlay ratchet without modifying the ledger', () => {
  const database = fixture();
  try {
    database.prepare('INSERT INTO session_workspace_modes VALUES (?, ?, ?)').run('session', '/fixture', 'legacy_shared');
    const before = database.serialize(); database.pragma('query_only = ON');
    assert.equal(inspectExistingSecurityState(database, {}, input => {
      assert.deepEqual(input, { sessionId: 'session', projectPath: '/fixture' }); return 'absent';
    }).policyId, 'existing-security-state/v1');
    for (const state of ['present_valid', 'present_invalid', 'unknown']) {
      assert.throws(() => inspectExistingSecurityState(database, {}, () => state), /overlay_ratchet_required/);
    }
    assert.throws(() => inspectExistingSecurityState(database, {}, () => { throw new Error('missing project'); }), /overlay_ratchet_required/);
    assert.deepEqual(database.serialize(), before);
  } finally { database.close(); }
});

test('existing startup requires existing owner and latest complete VAPID keys without bootstrap writes', () => {
  const database = fixture();
  try {
    database.prepare('DELETE FROM users WHERE role = ?').run('owner');
    database.pragma('query_only = ON');
    assert.throws(() => inspectExistingSecurityState(database, {}), /owner_missing/);
    database.pragma('query_only = OFF');
    database.prepare('INSERT INTO users VALUES (?)').run('owner');
    database.prepare('INSERT INTO vapid_keys VALUES (?, ?, ?)').run(2, '', '');
    const before = database.serialize(); database.pragma('query_only = ON');
    assert.throws(() => inspectExistingSecurityState(database, {}), /vapid_missing/);
    assert.deepEqual(database.serialize(), before);
  } finally { database.close(); }
});

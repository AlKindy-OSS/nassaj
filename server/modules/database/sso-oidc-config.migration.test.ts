/** ADR-194 D3 table, repository helpers and the reserved `sso.` app_config namespace. */
import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import { APP_CONFIG_TABLE_SCHEMA_SQL } from './schema.js';
import { migrateSsoOidcConfig, rollbackSsoOidcConfig } from './sso-oidc-config.migration.js';
import { assertGenericAppConfigKey } from './repositories/app-config-reserved.js';
import {
  deleteDisabledRecordOn, disabledRecordPresentOn, nonOwnerLinkExistsOn, readActiveVersionOn, readSlotOn,
  setActiveEnabledOn, stampLinkedNonOwnerSessionsRevokedOn, upsertDraftOn, writeDisabledRecordOn,
} from './repositories/sso-oidc-config.js';

function freshDb() {
  const db = new Database(':memory:');
  db.exec(APP_CONFIG_TABLE_SCHEMA_SQL);
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, role TEXT, password_changed_at INTEGER);
    CREATE TABLE user_identities (id INTEGER PRIMARY KEY, user_id INTEGER, issuer TEXT, subject TEXT)`);
  migrateSsoOidcConfig(db);
  migrateSsoOidcConfig(db);
  return db;
}

const DRAFT = {
  issuer: 'https://idp.example', client_id: 'c', client_auth: 'none' as const, client_secret_enc: null,
  secret_version: 0, extra_scopes: '', redirect_uri: null, role_claim_path: '', role_rules_json: '[]',
  tenant_mode: 'none' as const, tenant_claim_path: null, tenant_values_json: '[]', jit_enabled: 0,
  attestation_max_age_hours: 12, allow_private_network: 0, issuer_port: null, pinned_endpoints_json: null,
  discovery_flags_json: null, config_hash: 'h',
};

test('migration is idempotent and CHECK constraints refuse out-of-domain values', () => {
  const db = freshDb();
  upsertDraftOn(db, DRAFT, 1, 10);
  const insert = (column: string, value: unknown) => () => db.prepare(`UPDATE sso_oidc_config SET ${column} = ?`).run(value);
  for (const [column, value] of [['slot', 'other'], ['enabled', 2], ['client_auth', 'private_key_jwt'],
    ['tenant_mode', 'any'], ['jit_enabled', 5], ['attestation_max_age_hours', 0],
    ['attestation_max_age_hours', 25], ['allow_private_network', 2], ['issuer_port', 70000]] as const) {
    assert.throws(insert(column, value), /CHECK constraint failed/, `${column}=${value}`);
  }
});

test('draft upsert bumps draft_version on every write; active version reads null without a row', () => {
  const db = freshDb();
  assert.equal(readActiveVersionOn(db), null);
  upsertDraftOn(db, DRAFT, 1, 10);
  upsertDraftOn(db, { ...DRAFT, client_id: 'c2' }, 2, 20);
  const draft = readSlotOn(db, 'draft');
  assert.equal(draft?.draft_version, 2);
  assert.equal(draft?.client_id, 'c2');
  assert.equal(draft?.updated_by, 2);
  assert.equal(readActiveVersionOn(db), null, 'a draft is not the active row');
});

test('setActiveEnabledOn bumps the version; a missing active row changes nothing', () => {
  const db = freshDb();
  assert.equal(setActiveEnabledOn(db, 0, 1, 5), false);
  db.prepare(`INSERT INTO sso_oidc_config (slot, enabled, issuer, client_id, client_auth, role_claim_path,
    role_rules_json, tenant_mode, config_hash, version) VALUES ('active', 1, 'i', 'c', 'none', 'r', '[]', 'none', 'h', 3)`).run();
  assert.equal(setActiveEnabledOn(db, 0, 1, 5), true);
  assert.equal(readActiveVersionOn(db), 4);
  assert.equal(readSlotOn(db, 'active')?.enabled, 0);
});

test('disabled record lifecycle and non-owner link detection', () => {
  const db = freshDb();
  assert.equal(disabledRecordPresentOn(db), false);
  writeDisabledRecordOn(db, 'owner', 1);
  writeDisabledRecordOn(db, 'force_off', 2);
  assert.equal(disabledRecordPresentOn(db), true);
  assert.equal(deleteDisabledRecordOn(db), true);
  assert.equal(deleteDisabledRecordOn(db), false);
  db.exec("INSERT INTO users (id, role) VALUES (1, 'owner'), (2, 'user'), (3, 'admin')");
  db.exec("INSERT INTO user_identities (user_id, issuer, subject) VALUES (1, 'i', 'o')");
  assert.equal(nonOwnerLinkExistsOn(db), false, 'an owner link never enforces');
  db.exec("INSERT INTO user_identities (user_id, issuer, subject) VALUES (3, 'i', 'a'), (3, 'j', 'a2')");
  assert.equal(nonOwnerLinkExistsOn(db), true);
  assert.deepEqual(stampLinkedNonOwnerSessionsRevokedOn(db, 99), [3]);
  assert.deepEqual(db.prepare('SELECT id, password_changed_at AS p FROM users ORDER BY id').all(),
    [{ id: 1, p: null }, { id: 2, p: null }, { id: 3, p: 99 }]);
});

test('rollback drops the table and the record; generic writers cannot touch sso.*', () => {
  const db = freshDb();
  writeDisabledRecordOn(db, 'owner', 1);
  rollbackSsoOidcConfig(db);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'sso_oidc_config'").get(), undefined);
  assert.equal(disabledRecordPresentOn(db), false);
  assert.throws(() => assertGenericAppConfigKey('sso.disabled'), /APP_CONFIG_RESERVED_PREFIX/);
  assert.doesNotThrow(() => assertGenericAppConfigKey('jwt_secret'));
});

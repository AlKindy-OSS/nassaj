/**
 * ADR-194 D1 state model (T-1962 S1) against a REAL database: the state
 * matrix over every credential entry (password/passkey/wallet share
 * requiresSsoLogin; invites; attestation; sweep), the owner column, the
 * read-throws row, I1, I2, the FORCE_OFF transition, owner disable, boot
 * re-assertion, the per-call version read and the per-version decryptability
 * cache. The back-channel column is in routes/oidc.backchannel-state.test.ts.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { stopReconcileScheduler } from '@/modules/database/project-reconcile.service.js';
import { SSO_DISABLED_CONFIG_KEY, writeDisabledRecordOn } from '@/modules/database/repositories/sso-oidc-config.js';
import { apiKeysDb } from '@/modules/database/repositories/api-keys.js';
import { userIdentitiesDb } from '@/modules/database/repositories/user-identities.js';
import { userDb } from '@/modules/database/repositories/users.js';
import { migrateSsoOidcConfig } from '@/modules/database/sso-oidc-config.migration.js';
import { encryptSsoClientSecret } from '@/modules/database/sso-secret-envelope.js';
import { resetProviderSecretsKeyCacheForTests } from '@/services/isolation/provider-secrets-key-manager.js';

import { clearSsoConfig, FIXTURE_CLIENT_ID, FIXTURE_ISSUER, writeSsoRow } from './__tests__/sso-config-fixture.js';
import { runSsoAttestationSweep, resetSsoAttestationSweepState } from './sso-attestation-sweep.js';
import { userSsoAttestationFresh } from './sso-attestation.js';
import {
  activeSsoMapping, legacyEnvPresent, resetSsoConfigCacheForTests, ssoJitEnabled, ssoLoginAvailable, ssoPolicyEnforced,
  ssoState,
} from './sso-config.service.js';
import { evaluateSsoClaims } from './sso-role-mapping.js';
import { applySsoBootPolicy, disableSso } from './sso-lifecycle.service.js';
import { localAccountCreationClosed, requiresSsoLogin } from './sso-only-policy.js';

const ENV_KEYS = ['OIDC_ENABLED', 'NASSAJ_SSO_FORCE_OFF', 'NASSAJ_PROVIDER_SECRETS_KEY',
  'OIDC_ISSUER_URL'] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
let tempDirectory = '';
let previousDatabasePath: string | undefined;
let owner: { id: number; username: string; role: string };
let member: { id: number; username: string; role: string };
let memberApiKey = '';
let ownerApiKey = '';
const quiet = () => {};

before(async () => {
  previousDatabasePath = process.env.DATABASE_PATH;
  tempDirectory = await mkdtemp(path.join(tmpdir(), 'sso-config-svc-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'db.sqlite');
  await initializeDatabase();
  stopReconcileScheduler();
  owner = userDb.createUser('sso_owner', 'hash-owner', 'owner');
  member = userDb.createUser('sso_member', 'hash-member', 'user');
  memberApiKey = String(apiKeysDb.createApiKey(member.id, 'matrix-member').apiKey);
  ownerApiKey = String(apiKeysDb.createApiKey(owner.id, 'matrix-owner').apiKey);
});

after(async () => {
  closeConnection();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  resetProviderSecretsKeyCacheForTests();
  if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = previousDatabasePath;
  await rm(tempDirectory, { recursive: true, force: true });
});

beforeEach(() => {
  const db = getConnection();
  migrateSsoOidcConfig(db);
  clearSsoConfig(db);
  db.exec('DELETE FROM user_identities');
  delete process.env.OIDC_ENABLED;
  delete process.env.NASSAJ_SSO_FORCE_OFF;
  delete process.env.OIDC_ISSUER_URL;
  process.env.NASSAJ_PROVIDER_SECRETS_KEY = crypto.randomBytes(32).toString('base64');
  resetProviderSecretsKeyCacheForTests();
  resetSsoConfigCacheForTests();
  resetSsoAttestationSweepState();
});

const linkMember = (attestedAt: number | null = Date.now()) => {
  const id = userIdentitiesDb.link(member.id, FIXTURE_ISSUER, `sub-member-${crypto.randomUUID()}`);
  if (attestedAt !== null) userIdentitiesDb.markAttested(id, member.id, attestedAt);
};
const linkOwner = () => userIdentitiesDb.link(owner.id, FIXTURE_ISSUER, `sub-owner-${crypto.randomUUID()}`);
const disabledRecordPresent = () => getConnection()
  .prepare('SELECT 1 FROM app_config WHERE key = ?').get(SSO_DISABLED_CONFIG_KEY) !== undefined;
const passwordStamp = (id: number) => (getConnection()
  .prepare('SELECT password_changed_at AS v FROM users WHERE id = ?').get(id) as { v: number | null }).v;
const auditCount = (action: string) => (getConnection()
  .prepare('SELECT COUNT(*) AS n FROM audit_log WHERE action = ?').get(action) as { n: number }).n;
const sweepCount = () => runSsoAttestationSweep({
  revoke: () => ({ abortedRuns: 0, closedSockets: 0, endedInteractiveSessions: 0 }),
});

type Expected = { enforced: boolean; available: boolean; state: string; memberLinked?: boolean };

/** Every entry for one state; the owner column is checked in every row. */
function assertEntries(label: string, expected: Expected) {
  assert.equal(ssoPolicyEnforced(), expected.enforced, `${label}: enforced`);
  assert.equal(ssoLoginAvailable(), expected.available, `${label}: login available`);
  assert.equal(ssoState(), expected.state, `${label}: state`);
  const governed = expected.enforced && expected.memberLinked !== false;
  assert.equal(requiresSsoLogin(member), governed, `${label}: member password/passkey/wallet refused`);
  assert.equal(localAccountCreationClosed(), expected.enforced, `${label}: invites closed`);
  const stale = governed && !expected.available;
  assert.equal(userSsoAttestationFresh(member), !stale, `${label}: member attestation`);
  assert.equal(sweepCount(), stale ? 1 : 0, `${label}: sweep revocations`);
  // D6 / S8 Q1: keys of a linked non-owner (attested just now) are refused
  // while enforced but unavailable; otherwise only the plain T-1946 window.
  const key = apiKeysDb.resolveApiKey(memberApiKey) as { ok: boolean; reason?: string };
  assert.deepEqual([key.ok, key.reason], stale ? [false, 'sso_attestation_expired'] : [true, undefined],
    `${label}: member API key`);
  assert.equal(apiKeysDb.resolveApiKey(ownerApiKey).ok, true, `${label}: owner API key never governed`);
  assert.equal(requiresSsoLogin(owner), false, `${label}: owner password/passkey never SSO-gated`);
  assert.equal(userSsoAttestationFresh(owner), true, `${label}: owner never governed`);
}

const STATES: Array<{ label: string; setup: () => void; expected: Expected }> = [
  { label: 'fresh install (owner link only)', setup: () => { linkOwner(); },
    expected: { enforced: false, available: false, state: 'off', memberLinked: false } },
  { label: 'no row, no env, non-owner link', setup: () => { linkMember(); },
    expected: { enforced: true, available: false, state: 'unavailable' } },
  { label: 'active, valid, enabled', setup: () => { linkMember(); writeSsoRow(getConnection()); },
    expected: { enforced: true, available: true, state: 'active' } },
  { label: 'broken row: validation fails', setup: () => { linkMember(); writeSsoRow(getConnection(), { role_rules_json: '[]' }); },
    expected: { enforced: true, available: false, state: 'unavailable' } },
  { label: 'broken row: redirect missing', setup: () => { linkMember(); writeSsoRow(getConnection(), { redirect_uri: null }); },
    expected: { enforced: true, available: false, state: 'unavailable' } },
  { label: 'broken row: pins missing', setup: () => { linkMember(); writeSsoRow(getConnection(), { pinned_endpoints_json: null }); },
    expected: { enforced: true, available: false, state: 'unavailable' } },
  { label: 'broken row: runtime_fault', setup: () => {
    linkMember(); writeSsoRow(getConnection(), { runtime_fault: 'discovery_endpoint_changed' });
  }, expected: { enforced: true, available: false, state: 'unavailable' } },
  { label: 'broken row: hash mismatch', setup: () => { linkMember(); writeSsoRow(getConnection(), { config_hash: 'f'.repeat(64) }); },
    expected: { enforced: true, available: false, state: 'unavailable' } },
  { label: 'secret AAD mismatch', setup: () => {
    linkMember();
    const draftCipher = encryptSsoClientSecret('s3cret', { slot: 'draft', issuer: FIXTURE_ISSUER, clientId: FIXTURE_CLIENT_ID });
    writeSsoRow(getConnection(), { client_auth: 'client_secret_basic', client_secret_enc: draftCipher });
  }, expected: { enforced: true, available: false, state: 'unavailable' } },
  { label: 'secret key unavailable', setup: () => {
    linkMember();
    const cipher = encryptSsoClientSecret('s3cret', { slot: 'active', issuer: FIXTURE_ISSUER, clientId: FIXTURE_CLIENT_ID });
    writeSsoRow(getConnection(), { client_auth: 'client_secret_post', client_secret_enc: cipher });
    process.env.NASSAJ_PROVIDER_SECRETS_KEY = 'not-a-key';
    resetProviderSecretsKeyCacheForTests();
  }, expected: { enforced: true, available: false, state: 'unavailable' } },
  { label: 'read throws (table missing)', setup: () => {
    linkMember(); process.env.OIDC_ENABLED = 'true'; getConnection().exec('DROP TABLE sso_oidc_config');
  }, expected: { enforced: true, available: false, state: 'unavailable' } },
  { label: 'legacy env, no row', setup: () => { linkMember(); process.env.OIDC_ENABLED = 'true'; },
    expected: { enforced: true, available: false, state: 'paused' } },
  { label: 'legacy env, no row, no links', setup: () => { process.env.OIDC_ENABLED = 'true'; },
    expected: { enforced: true, available: false, state: 'paused', memberLinked: false } },
  { label: 'owner disabled', setup: () => {
    linkMember(); process.env.OIDC_ENABLED = 'true'; writeDisabledRecordOn(getConnection(), 'owner', Date.now());
  }, expected: { enforced: false, available: false, state: 'off' } },
  { label: 'owner disabled beats an enabled row', setup: () => {
    linkMember(); writeSsoRow(getConnection()); writeDisabledRecordOn(getConnection(), 'owner', Date.now());
  }, expected: { enforced: false, available: false, state: 'off' } },
  { label: 'FORCE_OFF applied', setup: () => {
    linkMember(); writeSsoRow(getConnection()); process.env.NASSAJ_SSO_FORCE_OFF = '1';
    writeDisabledRecordOn(getConnection(), 'force_off', Date.now());
  }, expected: { enforced: false, available: false, state: 'off' } },
];

for (const { label, setup, expected } of STATES) {
  test(`D1 matrix: ${label}`, () => {
    setup();
    assertEntries(label, expected);
  });
}

test('active but not enabled: enforced by the non-owner link, login unavailable; no links → off', () => {
  writeSsoRow(getConnection(), { enabled: 0 });
  assertEntries('enabled=0, no links', { enforced: false, available: false, state: 'off', memberLinked: false });
  linkMember();
  assertEntries('enabled=0, linked', { enforced: true, available: false, state: 'unavailable' });
});

test('S2: the active row\'s mapping is the only role source, and only while login is available', () => {
  linkMember();
  writeSsoRow(getConnection());
  const mapping = activeSsoMapping();
  assert.ok(mapping);
  assert.deepEqual(evaluateSsoClaims({ roles: ['admin'], org: 'org-1' }, mapping), { role: 'admin', reason: null });
  assert.equal(evaluateSsoClaims({ roles: ['admin'], org: 'org-2' }, mapping).reason, 'tenant_not_allowed');
  writeSsoRow(getConnection(), { enabled: 0 });
  assert.equal(activeSsoMapping(), null, 'no mapping while login is unavailable');
  for (const change of [{ role_claim_path: 'preferred_username' }, { role_rules_json: '[{"value":"x","role":"owner"}]' },
    { tenant_claim_path: 'name' }]) {
    writeSsoRow(getConnection(), change);
    assert.equal(ssoPolicyEnforced(), true, JSON.stringify(change));
    assert.equal(ssoState(), 'unavailable', JSON.stringify(change));
    assert.equal(activeSsoMapping(), null);
  }
});

test('I1: legacy env needs a successful read and no active row', () => {
  process.env.OIDC_ENABLED = 'true';
  assert.equal(legacyEnvPresent(), true);
  writeSsoRow(getConnection(), { enabled: 0 });
  assert.equal(legacyEnvPresent(), false, 'an active row (even disabled) ends legacy');
  assert.equal(ssoState(), 'off', 'env is ignored once a row exists');
  getConnection().exec('DROP TABLE sso_oidc_config');
  assert.equal(legacyEnvPresent(), false, 'a failed read is not legacy');
  assert.equal(ssoPolicyEnforced(), true, 'the exception rule enforces instead');
  delete process.env.OIDC_ENABLED;
  assert.equal(legacyEnvPresent(), false);
});

test('I1: disable in paused writes sso.disabled, which overrides OIDC_ENABLED across reboots', () => {
  linkMember();
  process.env.OIDC_ENABLED = 'true';
  assert.equal(ssoState(), 'paused');
  const result = disableSso({ actorUserId: owner.id, keepLinkedSessions: true, afterCommit: quiet });
  assert.equal(result.fromState, 'paused');
  assert.equal(result.keptSessions, false, 'revocation is forced outside the active state');
  assert.equal(result.linkedRevoked, 1);
  for (let boot = 0; boot < 2; boot += 1) {
    applySsoBootPolicy();
    resetSsoConfigCacheForTests();
    assertEntries(`after reboot ${boot}`, { enforced: false, available: false, state: 'off' });
  }
});

test('I2: a restored database with a non-owner link and no record is enforced regardless of env or row', () => {
  linkMember();
  for (const env of [undefined, 'false', 'true']) {
    if (env === undefined) delete process.env.OIDC_ENABLED;
    else process.env.OIDC_ENABLED = env;
    assert.equal(ssoPolicyEnforced(), true, `OIDC_ENABLED=${env}`);
    assert.equal(requiresSsoLogin(member), true);
  }
  writeSsoRow(getConnection(), { enabled: 0 });
  assert.equal(ssoPolicyEnforced(), true, 'a disabled row without the record does not lift it');
  assert.equal(disabledRecordPresent(), false, 'nothing but disable or FORCE_OFF writes the record');
});

test('I2: boot with enabled=1 and a stale disabled record clears the record and audits once', () => {
  linkMember();
  writeSsoRow(getConnection());
  writeDisabledRecordOn(getConnection(), 'owner', Date.now());
  const before = auditCount('sso_disabled_record_cleared');
  assert.deepEqual(applySsoBootPolicy(), { action: 'disabled_record_cleared' });
  assert.equal(disabledRecordPresent(), false);
  assert.equal(auditCount('sso_disabled_record_cleared'), before + 1);
  assert.deepEqual(applySsoBootPolicy(), { action: 'none' });
  assert.equal(ssoState(), 'active');
});

test('FORCE_OFF revokes linked non-owners exactly once; a re-boot does nothing', () => {
  linkMember();
  linkOwner();
  writeSsoRow(getConnection());
  process.env.NASSAJ_SSO_FORCE_OFF = '1';
  const ownerStamp = passwordStamp(owner.id);
  const memberStampBefore = passwordStamp(member.id);
  const revoked: number[][] = [];
  const before = auditCount('sso_force_off_applied');
  const first = applySsoBootPolicy({ nowMs: 2_000_000_000_000, afterCommit: (ids) => revoked.push(ids) });
  assert.deepEqual(first, { action: 'force_off_applied', linkedRevoked: 1 });
  assert.deepEqual(revoked, [[member.id]]);
  assert.equal(passwordStamp(member.id), 2_000_000_000_000);
  assert.notEqual(passwordStamp(member.id), memberStampBefore);
  assert.equal(passwordStamp(owner.id), ownerStamp, 'the owner is never revoked');
  assert.equal(disabledRecordPresent(), true);
  assert.equal((getConnection().prepare("SELECT enabled FROM sso_oidc_config WHERE slot='active'")
    .get() as { enabled: number }).enabled, 0);
  const second = applySsoBootPolicy({ nowMs: 2_100_000_000_000, afterCommit: (ids) => revoked.push(ids) });
  assert.deepEqual(second, { action: 'none' });
  assert.deepEqual(revoked, [[member.id]], 'no second revocation');
  assert.equal(passwordStamp(member.id), 2_000_000_000_000);
  assert.equal(auditCount('sso_force_off_applied'), before + 1);
  assertEntries('after FORCE_OFF', { enforced: false, available: false, state: 'off' });
});

test('FORCE_OFF lifts nothing until its revocation and record have committed (fail closed)', () => {
  linkMember();
  process.env.NASSAJ_SSO_FORCE_OFF = '1';
  assert.equal(ssoPolicyEnforced(), true);
  assert.equal(ssoLoginAvailable(), false);
  writeSsoRow(getConnection());
  assert.equal(ssoLoginAvailable(), false, 'FORCE_OFF never offers login');
});

test('owner disable: keep sessions only from active; idempotent; ends enabled', () => {
  linkMember();
  writeSsoRow(getConnection());
  const kept = disableSso({ actorUserId: owner.id, keepLinkedSessions: true, afterCommit: quiet });
  assert.deepEqual(kept, { alreadyDisabled: false, linkedRevoked: 0, fromState: 'active', keptSessions: true });
  assert.equal(ssoState(), 'off');
  const again = disableSso({ actorUserId: owner.id, afterCommit: () => assert.fail('no second revocation') });
  assert.equal(again.alreadyDisabled, true);
  const row = getConnection().prepare("SELECT enabled, updated_by FROM sso_oidc_config WHERE slot='active'")
    .get() as { enabled: number; updated_by: number };
  assert.deepEqual(row, { enabled: 0, updated_by: owner.id });
});

test('owner disable from active without keep revokes the linked member', () => {
  linkMember();
  writeSsoRow(getConnection());
  const ids: number[][] = [];
  const result = disableSso({ actorUserId: owner.id, afterCommit: (userIds) => ids.push(userIds) });
  assert.equal(result.linkedRevoked, 1);
  assert.deepEqual(ids, [[member.id]]);
});

test('hot reload: every evaluation re-reads the version; a bumped version is seen at once', () => {
  linkMember();
  const row = writeSsoRow(getConnection());
  assert.equal(ssoLoginAvailable(), true);
  getConnection().prepare(`UPDATE sso_oidc_config SET runtime_fault = 'discovery_endpoint_changed',
    version = version + 1 WHERE slot = 'active'`).run();
  assert.equal(ssoLoginAvailable(), false, 'no reset needed');
  getConnection().prepare('UPDATE sso_oidc_config SET runtime_fault = NULL, version = ? WHERE slot = ?')
    .run(row.version + 5, 'active');
  assert.equal(ssoLoginAvailable(), true);
});

test('decryptability is computed once per (version, secret_version), never per call', () => {
  linkMember();
  const cipher = encryptSsoClientSecret('s3cret', { slot: 'active', issuer: FIXTURE_ISSUER, clientId: FIXTURE_CLIENT_ID });
  const row = writeSsoRow(getConnection(), { client_auth: 'client_secret_basic', client_secret_enc: cipher });
  assert.equal(ssoLoginAvailable(), true);
  process.env.NASSAJ_PROVIDER_SECRETS_KEY = crypto.randomBytes(32).toString('base64');
  resetProviderSecretsKeyCacheForTests();
  assert.equal(ssoLoginAvailable(), true, 'cached for this version: the new key is not tried');
  getConnection().prepare('UPDATE sso_oidc_config SET version = ? WHERE slot = ?').run(row.version + 1, 'active');
  assert.equal(ssoLoginAvailable(), false, 'a new version decrypts again and fails under the other key');
});

test('JIT: needs login available and the row opt-in', () => {
  writeSsoRow(getConnection(), { jit_enabled: 1 });
  assert.equal(ssoJitEnabled(), true);
  writeSsoRow(getConnection(), { jit_enabled: 0 });
  assert.equal(ssoJitEnabled(), false);
  writeSsoRow(getConnection(), { jit_enabled: 1, runtime_fault: 'discovery_endpoint_changed' });
  assert.equal(ssoJitEnabled(), false);
  writeSsoRow(getConnection(), { jit_enabled: 1, tenant_mode: 'none', tenant_claim_path: null, tenant_values_json: '[]' });
  assert.equal(ssoJitEnabled(), false, 'JIT with no tenant restriction is an invalid row');
});

test('attestation window comes from the active row', () => {
  linkMember(Date.now() - 3 * 60 * 60 * 1000);
  writeSsoRow(getConnection(), { attestation_max_age_hours: 4 });
  assert.equal(userSsoAttestationFresh(member), true);
  writeSsoRow(getConnection(), { attestation_max_age_hours: 2 });
  assert.equal(userSsoAttestationFresh(member), false);
});

test('boot names ignored OIDC_* env once a row exists, never values; a bad row never throws', (t) => {
  const writes: string[] = [];
  t.mock.method(process.stderr, 'write', (chunk: string) => { writes.push(String(chunk)); return true; });
  process.env.OIDC_ISSUER_URL = 'https://secret-looking.example';
  writeSsoRow(getConnection(), { role_rules_json: 'not json' });
  assert.deepEqual(applySsoBootPolicy(), { action: 'none' });
  const ignored = writes.map((line) => JSON.parse(line)).find((entry) => entry.code === 'sso_legacy_env_ignored');
  assert.ok(ignored?.variables.includes('OIDC_ISSUER_URL'));
  assert.ok(!writes.join('').includes('secret-looking'), 'values are never logged');
  assert.ok(writes.some((line) => line.includes('sso_active_config_invalid')));
});

test('boot policy failure is logged and never thrown', (t) => {
  const writes: string[] = [];
  t.mock.method(process.stderr, 'write', (chunk: string) => { writes.push(String(chunk)); return true; });
  process.env.NASSAJ_SSO_FORCE_OFF = '1';
  getConnection().exec('DROP TABLE sso_oidc_config');
  linkMember();
  assert.deepEqual(applySsoBootPolicy(), { action: 'failed' });
  assert.ok(writes.some((line) => line.includes('sso_boot_policy_failed')));
  assert.equal(disabledRecordPresent(), false, 'the failed transition left no record');
  assert.equal(ssoPolicyEnforced(), true, 'so the policy stays enforced');
});

/**
 * ADR-194 S3 relying-party runtime against a real database: active and draft
 * client selection, verifier cache keys, the N1 version fence, persisted drift
 * (CAS on the observed version) and the back-channel selection.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test, { beforeEach } from 'node:test';

process.env.NASSAJ_PROVIDER_SECRETS_KEY = crypto.randomBytes(32).toString('base64');
for (const key of ['OIDC_ENABLED', 'OIDC_ISSUER_URL', 'OIDC_CLIENT_ID', 'NASSAJ_SSO_FORCE_OFF']) delete process.env[key];

const { initializeDatabase } = await import('@/modules/database/init-db.js');
const { stopReconcileScheduler } = await import('@/modules/database/project-reconcile.service.js');
const { getConnection } = await import('@/modules/database/connection.js');
const { userDb, userIdentitiesDb } = await import('@/modules/database/index.js');
const { clearSsoConfig, writeSsoRow, FIXTURE_ISSUER } = await import('./__tests__/sso-config-fixture.js');
const { resetSsoConfigCacheForTests, ssoState } = await import('./sso-config.service.js');
const runtime = await import('./sso-oidc-runtime.service.js');
await initializeDatabase();
stopReconcileScheduler();

const db = getConnection();
const owner = userDb.createUser('rt_owner', 'hash', 'owner');
const admin = userDb.createUser('rt_admin', 'hash', 'admin');
const member = userDb.createUser('rt_member', 'hash', 'user');

beforeEach(() => {
  clearSsoConfig(db);
  db.exec('DELETE FROM user_identities');
  for (const key of ['OIDC_ENABLED', 'OIDC_ISSUER_URL', 'OIDC_CLIENT_ID']) delete process.env[key];
  resetSsoConfigCacheForTests();
  runtime.setSsoNetworkOverridesForTests({});
});

const activeVersion = () => (db.prepare("SELECT version FROM sso_oidc_config WHERE slot = 'active'").get() as
  { version: number }).version;

test('activeSsoClient: row values, scope and flags; null while login is unavailable', () => {
  assert.equal(runtime.activeSsoClient(), null, 'no row');
  const row = writeSsoRow(db, {
    extra_scopes: 'groups offline_access',
    discovery_flags_json: JSON.stringify({ authorization_response_iss_parameter_supported: true }),
  });
  const client = runtime.activeSsoClient();
  assert.ok(client);
  assert.equal(client.slot, 'active');
  assert.equal(client.version, row.version);
  assert.equal(client.issuer, FIXTURE_ISSUER);
  assert.equal(client.redirectUri, row.redirect_uri);
  assert.equal(client.scope, 'openid profile email groups offline_access');
  assert.equal(client.discoveryFlags.authorization_response_iss_parameter_supported, true);
  assert.ok(client.mapping);
  assert.equal(runtime.activeSsoClient()?.verifier, client.verifier, 'cached for issuer|client|version');
  writeSsoRow(db, { extra_scopes: 'groups offline_access' });
  assert.notEqual(runtime.activeSsoClient()?.verifier, client.verifier, 'a new version builds a new verifier');
  writeSsoRow(db, { enabled: 0 });
  assert.equal(runtime.activeSsoClient(), null, 'disabled row');
});

test('runUnderVersionFence: one transaction; a moved version writes nothing; a throw rolls back', () => {
  writeSsoRow(db);
  const version = activeVersion();
  const insert = () => userIdentitiesDb.link(member.id, `https://idp-${crypto.randomUUID()}.example`, 'sub-member');
  assert.equal(typeof runtime.runUnderVersionFence(version, insert), 'number');
  assert.equal(runtime.runUnderVersionFence(version + 1, insert), runtime.SSO_FENCE_REFUSED);
  assert.equal(runtime.runUnderVersionFence(undefined, insert), runtime.SSO_FENCE_REFUSED);
  assert.throws(() => runtime.runUnderVersionFence(version, () => { insert(); throw new Error('boom'); }), /boom/);
  const links = (db.prepare('SELECT COUNT(*) AS n FROM user_identities').get() as { n: number }).n;
  assert.equal(links, 1, 'only the matching, non-throwing write committed');
  assert.equal(runtime.activeVersionStillIs(version), true);
  assert.equal(runtime.activeVersionStillIs(version + 1), false);
  assert.equal(runtime.activeVersionStillIs('7'), false);
});

test('recordDiscoveryDrift: CAS on the observed version, audited once, makes SSO unavailable', (t) => {
  t.mock.method(process.stderr, 'write', () => true);
  writeSsoRow(db);
  const version = activeVersion();
  assert.equal(runtime.recordDiscoveryDrift(version - 1), false, 'a stale verifier cannot fault a newer config');
  assert.equal(runtime.recordDiscoveryDrift(version), true);
  assert.equal(runtime.recordDiscoveryDrift(version + 1), false, 'already faulted');
  const row = db.prepare("SELECT runtime_fault AS fault, version FROM sso_oidc_config WHERE slot = 'active'").get() as
    { fault: string; version: number };
  assert.deepEqual(row, { fault: 'discovery_endpoint_changed', version: version + 1 });
  assert.equal(ssoState(), 'unavailable');
  const audits = db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'sso_runtime_fault_recorded'").get() as
    { n: number };
  assert.equal(audits.n, 1);
});

test('draftSsoClient: hash, draft_version, owner and pins are re-checked; separate cache by hash', () => {
  const draft = writeSsoRow(db, { enabled: 0, draft_version: 5 }, 'draft');
  const entry = { purpose: 'test', ownerUserId: owner.id, configHash: draft.config_hash, draftVersion: 5 };
  const selected = runtime.draftSsoClient(entry);
  assert.ok('client' in selected);
  assert.equal(selected.client.slot, 'draft');
  assert.equal(runtime.draftSsoClient(entry).client?.verifier, selected.client.verifier, 'cached by config_hash');
  assert.deepEqual(runtime.draftSsoClient({ ...entry, draftVersion: 6 }), { refusal: 'sso_test_config_changed' });
  assert.deepEqual(runtime.draftSsoClient({ ...entry, configHash: 'b'.repeat(64) }), { refusal: 'sso_test_config_changed' });
  assert.deepEqual(runtime.draftSsoClient({ ...entry, ownerUserId: admin.id }), { refusal: 'sso_test_owner_invalid' });
  writeSsoRow(db, { enabled: 0, draft_version: 5, issuer_port: 9443 }, 'draft');
  assert.deepEqual(runtime.draftSsoClient(entry), { refusal: 'sso_test_config_changed' }, 'tampered or edited row');
});

test('draftTestBinding: pins and redirect required; the binding is the stored hash and version', () => {
  assert.deepEqual(runtime.draftTestBinding(), { refusal: 'sso_test_config_invalid' }, 'no draft row');
  writeSsoRow(db, { enabled: 0, draft_version: 2, pinned_endpoints_json: null }, 'draft');
  assert.deepEqual(runtime.draftTestBinding(), { refusal: 'sso_test_discovery_required' });
  writeSsoRow(db, { enabled: 0, draft_version: 2, redirect_uri: null }, 'draft');
  assert.deepEqual(runtime.draftTestBinding(), { refusal: 'sso_test_discovery_required' });
  const draft = writeSsoRow(db, { enabled: 0, draft_version: 2 }, 'draft');
  assert.deepEqual(runtime.draftTestBinding(), { configHash: draft.config_hash, draftVersion: 2 });
  writeSsoRow(db, { enabled: 0, draft_version: 2, config_hash: 'c'.repeat(64) }, 'draft');
  assert.deepEqual(runtime.draftTestBinding(), { refusal: 'sso_test_config_invalid' });
});

test('backchannelSsoVerifier: the D1 column', () => {
  assert.deepEqual(runtime.backchannelSsoVerifier(), { status: 501 }, 'fresh install');
  userIdentitiesDb.link(member.id, FIXTURE_ISSUER, 'sub-member');
  assert.deepEqual(runtime.backchannelSsoVerifier(), { status: 503 }, 'enforced with nothing configured');
  writeSsoRow(db, { runtime_fault: 'discovery_endpoint_changed' });
  const broken = runtime.backchannelSsoVerifier();
  assert.equal(broken.issuer, FIXTURE_ISSUER, 'broken row verifies with its own issuer');
  assert.equal(broken.verifier?.pinned, true);
  writeSsoRow(db, { pinned_endpoints_json: null });
  assert.deepEqual(runtime.backchannelSsoVerifier(), { status: 503 }, 'no pinned jwks_uri');
  clearSsoConfig(db);
  resetSsoConfigCacheForTests();
  Object.assign(process.env, { OIDC_ENABLED: 'true', OIDC_ISSUER_URL: 'https://legacy.example', OIDC_CLIENT_ID: 'c' });
  const legacy = runtime.backchannelSsoVerifier();
  assert.equal(legacy.issuer, 'https://legacy.example');
  assert.equal(legacy.verifier?.pinned, false, 'legacy env uses discovery');
  process.env.OIDC_ISSUER_URL = 'http://legacy.example';
  assert.deepEqual(runtime.backchannelSsoVerifier(), { status: 503 });
  db.exec('ALTER TABLE sso_oidc_config RENAME TO sso_oidc_config_hidden');
  try {
    assert.deepEqual(runtime.backchannelSsoVerifier(), { status: 503 }, 'unreadable state');
    assert.equal(runtime.activeSsoClient(), null);
    assert.equal(runtime.activeVersionStillIs(1), false);
  } finally {
    db.exec('ALTER TABLE sso_oidc_config_hidden RENAME TO sso_oidc_config');
  }
});

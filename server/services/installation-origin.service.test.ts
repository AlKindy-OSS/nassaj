/**
 * ADR-194 D3 / I8 installation origin for SSO (T-1962 S3): the connector
 * store wins when initialized; otherwise the owner-confirmed app_config
 * record, validated by the ADR-193 validator; redirect status is derived from
 * it and never from the request.
 */
import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';

const { initializeDatabase } = await import('@/modules/database/init-db.js');
const { stopReconcileScheduler } = await import('@/modules/database/project-reconcile.service.js');
const { getConnection } = await import('@/modules/database/connection.js');
const { userDb } = await import('@/modules/database/index.js');
const { assertGenericAppConfigKey } = await import('@/modules/database/repositories/app-config-reserved.js');
const origin = await import('./installation-origin.service.js');
await initializeDatabase();
stopReconcileScheduler();

const db = getConnection();
const actor = userDb.createUser('origin_owner', 'hash', 'owner');
const savedEnv = process.env.NODE_ENV;

beforeEach(() => {
  db.prepare('DELETE FROM app_config WHERE key = ?').run(origin.INSTALLATION_ORIGIN_CONFIG_KEY);
  origin.registerConnectorInstallationOriginReader(null);
  process.env.NODE_ENV = 'production';
});

test('a node without the connector origin confirms one with the ADR-193 validator, audited', () => {
  assert.equal(origin.confirmedInstallationOrigin(), null);
  assert.equal(origin.ssoRedirectUriForDraft(), null);
  assert.equal(origin.confirmInstallationOrigin({ origin: 'https://nassaj.example', actorUserId: actor.id }), 'https://nassaj.example');
  assert.equal(origin.confirmedInstallationOrigin(), 'https://nassaj.example');
  assert.equal(origin.ssoRedirectUriForDraft(), 'https://nassaj.example/api/auth/oidc/callback');
  for (const bad of ['http://nassaj.example', 'https://nassaj.example/', 'https://nassaj.example/x', 'https://u@n.example',
    'http://localhost:3004', ' https://nassaj.example']) {
    assert.throws(() => origin.confirmInstallationOrigin({ origin: bad, actorUserId: actor.id }),
      (error: { code?: string }) => error.code === 'installation_origin_invalid', bad);
  }
  const audits = db.prepare("SELECT metadata FROM audit_log WHERE action = 'installation_origin_confirmed'").all();
  assert.equal(audits.length, 1);
  assert.throws(() => assertGenericAppConfigKey(origin.INSTALLATION_ORIGIN_CONFIG_KEY), /APP_CONFIG_RESERVED_PREFIX/);
});

test('loopback http is accepted only outside production', () => {
  process.env.NODE_ENV = 'development';
  assert.equal(origin.confirmInstallationOrigin({ origin: 'http://localhost:3004', actorUserId: actor.id }), 'http://localhost:3004');
  process.env.NODE_ENV = 'production';
  assert.equal(origin.confirmedInstallationOrigin(), null, 'a stored value that no longer validates reads as null');
});

test('the connector origin, when present, is the only source', () => {
  origin.confirmInstallationOrigin({ origin: 'https://local.example', actorUserId: actor.id });
  origin.registerConnectorInstallationOriginReader(() => 'https://connectors.example');
  assert.equal(origin.confirmedInstallationOrigin(), 'https://connectors.example');
  assert.throws(() => origin.confirmInstallationOrigin({ origin: 'https://x.example', actorUserId: actor.id }),
    (error: { code?: string }) => error.code === 'installation_origin_managed_by_connectors');
  origin.registerConnectorInstallationOriginReader(() => { throw new Error('tampered'); });
  assert.equal(origin.confirmedInstallationOrigin(), 'https://local.example', 'an unreadable connector origin falls back');
});

test('I8 redirect status compares the stored redirect with the confirmed origin', () => {
  const stored = 'https://nassaj.example/api/auth/oidc/callback';
  assert.equal(origin.ssoRedirectOriginStatus(stored), 'installation_origin_unconfirmed');
  origin.confirmInstallationOrigin({ origin: 'https://nassaj.example', actorUserId: actor.id });
  assert.equal(origin.ssoRedirectOriginStatus(stored), 'ok');
  origin.confirmInstallationOrigin({ origin: 'https://moved.example', actorUserId: actor.id });
  assert.equal(origin.ssoRedirectOriginStatus(stored), 'redirect_origin_mismatch');
  assert.equal(origin.ssoRedirectOriginStatus(null), 'redirect_origin_mismatch');
  db.prepare('UPDATE app_config SET value = ? WHERE key = ?').run('https://evil.example/path', origin.INSTALLATION_ORIGIN_CONFIG_KEY);
  assert.equal(origin.confirmedInstallationOrigin(), null, 'a tampered record reads as null');
});

test.after(() => {
  if (savedEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = savedEnv;
});

/**
 * ADR-194 D6 / S8 Q1 boot wiring: the API key clause refuses linked members
 * while SSO is enforced but unavailable only if the SSO state model registered
 * its gate. Production loads that model through the auth middleware that
 * server/index.js imports at boot, so loading the middleware must register it,
 * and the registered gate must be the fail-closed state evaluation.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');

test('the production boot chain registers the SSO-unavailable API key gate', async () => {
  const repository = await import('./api-key-sso-window.js');
  const indexSource = readFileSync(path.resolve(import.meta.dirname, '../../../index.js'), 'utf8');
  assert.match(indexSource, /from '\.\/middleware\/auth\.js'/, 'server/index.js loads the auth middleware at boot');

  const directory = await mkdtemp(path.join(tmpdir(), 'api-key-gate-'));
  process.env.DATABASE_PATH = path.join(directory, 'db.sqlite');
  try {
    const { initializeDatabase } = await import('../init-db.js');
    await initializeDatabase();
    (await import('../project-reconcile.service.js')).stopReconcileScheduler();
    await import('../../../middleware/auth.js');
    assert.equal(repository.apiKeySsoUnavailableGateRegistered(), true, 'loading the auth middleware registers the gate');

    const { getConnection, closeConnection } = await import('../connection.js');
    const db = getConnection();
    const clause = () => repository.apiKeySsoAttestationClause(db).params.length;
    assert.equal(clause(), 1, 'no link: the plain window (cutoff bound)');
    const user = db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('gate-member', 'x', 'user')").run();
    db.prepare('INSERT INTO user_identities (user_id, issuer, subject) VALUES (?, ?, ?)')
      .run(user.lastInsertRowid, 'https://idp.example', 'sub-gate');
    assert.equal(clause(), 0, 'link, no row: enforced and unavailable → linked members refused');
    db.exec('DROP TABLE sso_oidc_config');
    assert.equal(clause(), 0, 'a state read failure also refuses (fail closed)');
    closeConnection();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('S9 M1: boot asserts the gate right after the SSO boot policy and refuses to serve without it', async () => {
  const indexSource = readFileSync(path.resolve(import.meta.dirname, '../../../index.js'), 'utf8');
  assert.match(indexSource, /import '\.\/services\/sso-config\.service\.js';/, 'the state model is loaded explicitly');
  const boot = indexSource.indexOf('applySsoBootPolicy();');
  const check = indexSource.indexOf('assertSsoApiKeyGateRegistered();');
  const listen = indexSource.indexOf('server.listen(', check);
  assert.ok(boot > 0 && check > boot, 'asserted after applySsoBootPolicy()');
  assert.ok(listen === -1 || listen > check, 'before the listener');

  const gate = await import('./api-key-sso-gate.js');
  const { assertSsoApiKeyGateRegistered } = await import('../../../services/sso-lifecycle.service.js');
  assert.doesNotThrow(() => assertSsoApiKeyGateRegistered(), 'registered by the state model');
  gate.setApiKeySsoUnavailableGate(undefined as never);
  assert.equal(gate.apiKeySsoUnavailableGateRegistered(), false);
  assert.throws(() => assertSsoApiKeyGateRegistered(), /SSO_API_KEY_GATE_MISSING/);
  gate.setApiKeySsoUnavailableGate(() => true);
  assert.equal(gate.apiKeySsoUnavailable(), true);
  gate.setApiKeySsoUnavailableGate(() => { throw new Error('read failed'); });
  assert.equal(gate.apiKeySsoUnavailable(), true, 'a throwing gate refuses keys');
});

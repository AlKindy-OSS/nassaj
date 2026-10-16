/**
 * ADR-194 A1: PUT /api/settings/sso/owner-sign-in and the `ownerSignIn` read
 * model — step-up on enable only (local evidence), the same-transaction audit,
 * the role matrix, and that the route touches the caller's own link only.
 */
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { admin, api, db, member, owner, resetSsoFixture, STEP_UP } from './__tests__/settings-sso-harness.js';

const { userDb } = await import('../modules/database/repositories/users.js');
const { userIdentitiesDb } = await import('../modules/database/repositories/user-identities.js');
const { writeSsoRow, FIXTURE_ISSUER } = await import('../services/__tests__/sso-config-fixture.js');
const { resetSsoConfigCacheForTests } = await import('../services/sso-config.service.js');

const secondOwner = userDb.createUser('settings_owner_two', 'hash-owner-two', 'owner');

beforeEach(() => {
  resetSsoFixture();
  db.exec('DROP TRIGGER IF EXISTS fail_owner_opt_in_audit');
  writeSsoRow(db);
  resetSsoConfigCacheForTests();
});

const optInOf = (identityId: number) => (db.prepare('SELECT owner_sso_opt_in_at AS v FROM user_identities WHERE id = ?')
  .get(identityId) as { v: number | null }).v;
const audits = () => db.prepare("SELECT user_id AS userId, metadata FROM audit_log WHERE action = 'sso_owner_sign_in_changed'")
  .all() as Array<{ userId: number; metadata: string }>;

function linkOwner(userId = owner.id, issuer = FIXTURE_ISSUER, subject = `sub-${userId}`) {
  return userIdentitiesDb.link(userId, issuer, subject);
}

test('turning it on without step-up is step_up_required and writes nothing', async () => {
  const identityId = linkOwner();
  const res = await api('PUT', '/owner-sign-in', { enabled: true });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'step_up_required');
  assert.equal(optInOf(identityId), null);
  assert.deepEqual(audits(), []);
});

test('SSO-grant evidence is refused; a wrong password is refused', async () => {
  const identityId = linkOwner();
  const grant = await api('PUT', '/owner-sign-in', { enabled: true, stepUp: { method: 'oidc_grant', grant: 'g' } });
  assert.equal(grant.status, 400);
  assert.equal(grant.body.code, 'step_up_invalid_request');
  const wrong = await api('PUT', '/owner-sign-in', { enabled: true, stepUp: { method: 'password', password: 'nope' } });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.code, 'step_up_failed');
  assert.equal(optInOf(identityId), null);
});

test('password step-up writes the opt-in with a same-transaction audit; GET reports it', async () => {
  const identityId = linkOwner();
  const before = Date.now();
  const res = await api('PUT', '/owner-sign-in', { enabled: true, stepUp: STEP_UP });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(res.body.ownerSignIn, { linked: true, enabled: true });
  assert.ok(Number(optInOf(identityId)) >= before);
  assert.deepEqual(audits().map((row) => ({ ...row, metadata: JSON.parse(row.metadata) })),
    [{ userId: owner.id, metadata: { identityId, enabled: true } }]);
  assert.deepEqual((await api('GET', '/')).body.ownerSignIn, { linked: true, enabled: true });
});

test('a forced audit failure rolls the opt-in write back', async (t) => {
  t.mock.method(process.stderr, 'write', () => true);
  const identityId = linkOwner();
  db.exec(`CREATE TRIGGER fail_owner_opt_in_audit BEFORE INSERT ON audit_log
    WHEN NEW.action = 'sso_owner_sign_in_changed' BEGIN SELECT RAISE(ABORT, 'audit down'); END`);
  const res = await api('PUT', '/owner-sign-in', { enabled: true, stepUp: STEP_UP });
  assert.equal(res.status, 500);
  assert.equal(res.body.code, 'internal_error');
  assert.equal(optInOf(identityId), null, 'the write was rolled back');
});

test('turning it off needs no step-up and clears the opt-in', async () => {
  const identityId = linkOwner();
  userIdentitiesDb.setOwnerSsoOptIn(identityId, owner.id, Date.now());
  const res = await api('PUT', '/owner-sign-in', { enabled: false });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.ownerSignIn, { linked: true, enabled: false });
  assert.equal(optInOf(identityId), null);
  assert.equal(JSON.parse(audits()[0]?.metadata ?? '{}').enabled, false);
});

test('a non-owner gets 403 and nothing is written', async () => {
  for (const userId of [admin.id, member.id]) {
    const identityId = linkOwner(userId);
    const res = await api('PUT', '/owner-sign-in', { enabled: false }, { userId });
    assert.equal(res.status, 403);
    assert.equal(optInOf(identityId), null);
  }
});

test('an owner without a link (or linked to another issuer) gets owner_sso_not_linked', async () => {
  const off = await api('PUT', '/owner-sign-in', { enabled: false });
  assert.equal(off.status, 409);
  assert.equal(off.body.code, 'owner_sso_not_linked');
  linkOwner(owner.id, 'https://previous-idp.example');
  const on = await api('PUT', '/owner-sign-in', { enabled: true, stepUp: STEP_UP });
  assert.equal(on.status, 409);
  assert.equal(on.body.code, 'owner_sso_not_linked');
  assert.deepEqual((await api('GET', '/')).body.ownerSignIn, { linked: false, enabled: false });
});

test('legacy duplicate links for the active issuer are refused oidc_duplicate_links', async () => {
  db.exec('DROP INDEX IF EXISTS idx_user_identities_user_issuer');
  try {
    linkOwner(owner.id, FIXTURE_ISSUER, 'sub-a');
    linkOwner(owner.id, FIXTURE_ISSUER, 'sub-b');
    const res = await api('PUT', '/owner-sign-in', { enabled: false });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'oidc_duplicate_links');
    assert.deepEqual((await api('GET', '/')).body.ownerSignIn, { linked: true, enabled: false });
  } finally {
    db.exec('DELETE FROM user_identities');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_user_identities_user_issuer ON user_identities(user_id, issuer)');
  }
});

test('the route touches only the caller\'s own row', async () => {
  const mine = linkOwner();
  const theirs = linkOwner(secondOwner.id);
  assert.equal((await api('PUT', '/owner-sign-in', { enabled: true, stepUp: STEP_UP })).status, 200);
  assert.notEqual(optInOf(mine), null);
  assert.equal(optInOf(theirs), null, 'the other owner\'s link is untouched');
});

test('a body without a boolean enabled is 400 owner_sso_invalid', async () => {
  linkOwner();
  for (const body of [{}, { enabled: 'true' }, { enabled: 1 }]) {
    const res = await api('PUT', '/owner-sign-in', body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.body.code, 'owner_sso_invalid');
  }
});

test('without an active configuration GET reports no link', async () => {
  linkOwner();
  db.exec("DELETE FROM sso_oidc_config WHERE slot = 'active'");
  resetSsoConfigCacheForTests();
  assert.deepEqual((await api('GET', '/')).body.ownerSignIn, { linked: false, enabled: false });
});

/**
 * ADR-H20 S6: the node's linked-sessions settings API (auto sign-in, owner
 * login_hint, post-logout URI, re-check interval, the owner kill switch).
 * Owner-only; every change needs the sso_config step-up (local password or
 * passkey), for an owner-tier SSO session too (the N2 owner grant that used to
 * stand in for it was withdrawn 2026-10-18), and is audited strictly.
 * There is no owner entry cap (ADR-194 A1 withdrawn 2026-10-18) and none can be set.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { beforeEach, test } from 'node:test';

import { ssoDeviceSessionsDb } from '../modules/database/index.js';

import {
  admin, api, db, member, nextRateEpoch, owner, resetSsoFixture, STEP_UP,
} from './__tests__/settings-sso-harness.js';

beforeEach(() => {
  resetSsoFixture();
  db.exec("DELETE FROM app_config WHERE key LIKE 'sso.linked.%'; DELETE FROM sso_device_sessions;");
});

const audits = () => (db.prepare("SELECT metadata FROM audit_log WHERE action = 'sso_linked_settings_changed' ORDER BY id")
  .all() as Array<{ metadata: string }>).map((row) => JSON.parse(row.metadata));

function ownerTierSession() {
  const refreshSid = crypto.randomBytes(16).toString('base64url');
  ssoDeviceSessionsDb.bind({
    refreshSid, userId: owner.id, issuer: 'https://idp.example', idpSid: 'V1_s', loginHint: null, ownerTier: true,
    nowMs: Date.now(), pruneAfter: Date.now() + 86_400_000,
  });
  return refreshSid;
}

test('GET: safe defaults (no owner entry cap any more); admin and member get 403', async () => {
  const res = await api('GET', '/linked-sessions');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(res.body, {
    settings: {
      autoSignIn: true, ownerLoginHint: null, postLogoutRedirectUri: null, recheckIntervalHours: 12,
      idpSignOutAffectsOwner: true,
    },
  });
  for (const userId of [admin.id, member.id]) {
    assert.equal((await api('GET', '/linked-sessions', undefined, { userId })).status, 403);
    assert.equal((await api('PUT', '/linked-sessions', { settings: { autoSignIn: true }, stepUp: STEP_UP }, { userId })).status, 403);
  }
});

test('PUT needs step-up: none → 403, a wrong password → 401, the local password → saved and audited', async () => {
  const body = { settings: { autoSignIn: false, ownerLoginHint: 'ibrahim@example.org' } };
  const missing = await api('PUT', '/linked-sessions', body);
  assert.equal(missing.status, 403);
  assert.equal(missing.body.code, 'step_up_required');
  const wrong = await api('PUT', '/linked-sessions', { ...body, stepUp: { method: 'password', password: 'nope' } });
  assert.equal(wrong.status, 401);
  assert.equal((await api('GET', '/linked-sessions')).body.settings.autoSignIn, true, 'nothing written');
  const saved = await api('PUT', '/linked-sessions', { ...body, stepUp: STEP_UP });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.settings.autoSignIn, false, 'an explicit off is stored and respected');
  assert.equal(saved.body.settings.ownerLoginHint, 'ibrahim@example.org');
  assert.deepEqual(audits(), [{ changed: ['autoSignIn', 'ownerLoginHint'] }]);
});

test('an owner-tier SSO session still confirms an sso_config change with the local step-up', async () => {
  const sid = ownerTierSession();
  const refused = await api('PUT', '/linked-sessions', { settings: { recheckIntervalHours: 6 } },
    { headers: { 'x-test-refresh-sid': sid } });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, 'step_up_required');
  const ok = await api('PUT', '/linked-sessions', { settings: { recheckIntervalHours: 24 }, stepUp: STEP_UP },
    { headers: { 'x-test-refresh-sid': sid } });
  assert.equal(ok.status, 200);
});

test('the kill switch: a change needs step-up and is audited', async () => {
  const res = await api('PUT', '/linked-sessions', { settings: { idpSignOutAffectsOwner: false }, stepUp: STEP_UP });
  assert.equal(res.status, 200);
  assert.equal(res.body.settings.idpSignOutAffectsOwner, false);
  assert.deepEqual(audits(), [{ changed: ['idpSignOutAffectsOwner'], idpSignOutAffectsOwner: false }]);
});

test('invalid values and unknown fields (the entry cap included) refuse the whole update', async () => {
  for (const settings of [
    { recheckIntervalHours: 25 }, { recheckIntervalHours: 0 }, { recheckIntervalHours: 1.5 },
    { postLogoutRedirectUri: 'http://dar.example/out' }, { postLogoutRedirectUri: 'https://u:p@dar.example/' },
    { ownerLoginHint: 'two words' }, { autoSignIn: 'yes' }, { ownerEntryCapDays: 1 }, { idpSignOutAffectsOwner: 0 },
    {}, null, [true],
  ]) {
    nextRateEpoch();
    const res = await api('PUT', '/linked-sessions', { settings, stepUp: STEP_UP });
    assert.equal(res.status, 400, JSON.stringify(settings));
    assert.equal(res.body.code, 'invalid_sso_linked_settings');
  }
  assert.deepEqual(audits(), []);
  nextRateEpoch();
  const cleared = await api('PUT', '/linked-sessions', {
    settings: { postLogoutRedirectUri: 'https://dar.example/auth/signed-out', ownerLoginHint: null }, stepUp: STEP_UP,
  });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.settings.postLogoutRedirectUri, 'https://dar.example/auth/signed-out');
});

test('a corrupt stored value reads as its safe default (kill switch stays on)', async () => {
  db.prepare("INSERT OR REPLACE INTO app_config (key, value) VALUES ('sso.linked.idp_signout_affects_owner', 'maybe')").run();
  db.prepare("INSERT OR REPLACE INTO app_config (key, value) VALUES ('sso.linked.recheck_interval_hours', '99')").run();
  const res = await api('GET', '/linked-sessions');
  assert.equal(res.body.settings.idpSignOutAffectsOwner, true);
  assert.equal(res.body.settings.recheckIntervalHours, 12);
});

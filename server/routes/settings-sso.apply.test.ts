/**
 * ADR-194 D9/D1 (T-1962 S4) through the owner SSO settings API: the apply
 * transaction (proof check I3, issuer change I7, mapping change I2, secret
 * re-encryption, forced-audit rollback), enable, and disable in every state
 * (I1, I6), with the revocation and re-attestation counts.
 */
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import {
  api, db, draftBody, liveRevocations, owner, proveDraft, resetSsoFixture, STEP_UP, stamp, useProvider,
} from './__tests__/settings-sso-harness.js';
import { apiKeysDb } from '../modules/database/repositories/api-keys.js';
import { userIdentitiesDb } from '../modules/database/repositories/user-identities.js';
import { userDb } from '../modules/database/repositories/users.js';
import { decryptSsoClientSecret } from '../modules/database/sso-secret-envelope.js';
import { createMockOpenIdProvider } from '../services/__tests__/mock-openid-provider.js';
import { FIXTURE_ISSUER, writeSsoRow } from '../services/__tests__/sso-config-fixture.js';
import { resetSsoConfigCacheForTests } from '../services/sso-config.service.js';

const NEW_ISSUER = 'https://idp-new.example';
const HOUR_MS = 60 * 60 * 1000;
const orphan = userDb.createUser('apply_orphan', 'hash', 'user');
const both = userDb.createUser('apply_both', 'hash', 'user');
const otherOwner = userDb.createUser('apply_owner_two', 'hash', 'owner');

beforeEach(() => resetSsoFixture());

const activeRow = () => db.prepare("SELECT * FROM sso_oidc_config WHERE slot = 'active'").get() as
  Record<string, unknown> | undefined;
const attestedAt = (userId: number) => (db.prepare('SELECT last_attested_at AS v FROM user_identities WHERE user_id = ? LIMIT 1')
  .get(userId) as { v: number | null }).v;
const keyCount = (userId: number) => (db.prepare('SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ?')
  .get(userId) as { n: number }).n;

function link(userId: number, issuer: string, subject: string) {
  const id = userIdentitiesDb.link(userId, issuer, subject);
  userIdentitiesDb.markAttested(id, userId, Date.now());
}

/** Active config under the old issuer plus: orphan (old only), both (old + new), owner (old). */
function issuerChangeFixture() {
  writeSsoRow(db);
  link(orphan.id, FIXTURE_ISSUER, 'sub-orphan');
  link(both.id, FIXTURE_ISSUER, 'sub-both-old');
  link(both.id, NEW_ISSUER, 'sub-both-new');
  link(owner.id, FIXTURE_ISSUER, 'sub-owner');
  apiKeysDb.createApiKey(orphan.id, 'orphan-key');
  apiKeysDb.createApiKey(owner.id, 'owner-key');
  useProvider(createMockOpenIdProvider({ issuer: NEW_ISSUER }));
}

test('I3: apply works after the display result was read; enable:true activates SSO', async () => {
  const binding = await proveDraft();
  const read = await api('GET', `/draft/test-login/result/${binding.resultId}`);
  assert.equal(read.status, 200, 'the display row is consumed');
  const res = await api('POST', '/apply', { ...binding, enable: true, stepUp: STEP_UP });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.ssoState, 'active');
  const applied = res.body.applied as Record<string, unknown>;
  assert.equal(applied.version, 1);
  assert.equal(applied.enabled, true);
  const status = await api('GET', '/');
  assert.equal((status.body.active as { invalidReason: unknown }).invalidReason, null);
  assert.equal((status.body.active as { configHash: string }).configHash, binding.configHash, 'no field was forced');
  assert.deepEqual(status.body.ignoredEnv, []);
});

test('apply refuses missing, foreign, stale or failed proofs and a missing step-up', async () => {
  await api('PUT', '/draft', draftBody());
  await api('POST', '/draft/test-discovery');
  const draft = (await api('GET', '/')).body.draft as { draftVersion: number; configHash: string };
  const noSignIn = await api('POST', '/apply', { draftVersion: draft.draftVersion, configHash: draft.configHash,
    stepUp: STEP_UP });
  assert.equal(noSignIn.status, 409);
  assert.equal(noSignIn.body.code, 'sso_apply_proof_missing');

  const binding = await proveDraft();
  const refusals: Array<[Record<string, unknown>, number, string]> = [
    [{ ...binding, configHash: '0'.repeat(64), stepUp: STEP_UP }, 409, 'sso_apply_proof_missing'],
    [{ ...binding, draftVersion: binding.draftVersion - 1, stepUp: STEP_UP }, 409, 'sso_apply_proof_missing'],
    [{ ...binding }, 403, 'step_up_required'],
    [{ ...binding, stepUp: { method: 'oidc_grant', grant: 'g' } }, 400, 'step_up_invalid_request'],
    [{ draftVersion: 'x', configHash: binding.configHash, stepUp: STEP_UP }, 400, 'sso_apply_invalid'],
  ];
  for (const [body, status, code] of refusals) {
    const res = await api('POST', '/apply', body);
    assert.equal(res.status, status, JSON.stringify(body));
    assert.equal(res.body.code, code);
  }
  db.prepare('UPDATE sso_apply_proofs SET owner_user_id = ?').run(otherOwner.id);
  assert.equal((await api('POST', '/apply', { ...binding, stepUp: STEP_UP })).body.code, 'sso_apply_proof_missing',
    'another owner\'s proofs');
  db.prepare('UPDATE sso_apply_proofs SET owner_user_id = ?, created_at = created_at - ?').run(owner.id, 25 * HOUR_MS);
  assert.equal((await api('POST', '/apply', { ...binding, stepUp: STEP_UP })).body.code, 'sso_apply_proof_missing',
    'older than 24 hours');
  assert.equal(activeRow(), undefined);
});

test('a sign-in proof without a mapped role is not passed; a draft edit after the proof invalidates it', async () => {
  const failed = await proveDraft(draftBody(), { sub: 'o', roles: ['stranger'], org: 'org-1' });
  assert.equal((await api('POST', '/apply', { ...failed, stepUp: STEP_UP })).body.code, 'sso_apply_proof_missing');
  const binding = await proveDraft();
  await api('PUT', '/draft', draftBody({ attestationMaxAgeHours: 6 }));
  assert.equal((await api('POST', '/apply', { ...binding, stepUp: STEP_UP })).body.code, 'sso_apply_proof_missing');
  assert.equal(activeRow(), undefined);
});

test('I7: an issuer change forces JIT off and revokes orphaned non-owners by default; counts match', async () => {
  issuerChangeFixture();
  const ownerStamp = stamp(owner.id);
  const bothStamp = stamp(both.id);
  db.prepare('UPDATE users SET password_changed_at = 1 WHERE id = ?').run(orphan.id);
  const binding = await proveDraft(draftBody({ jitEnabled: true }));
  const impact = (await api('GET', '/')).body.applyImpact as Record<string, unknown>;
  assert.deepEqual(impact, { issuerChanged: true, mappingChanged: true, reattestRequired: 2, orphaned: 1,
    jitForcedOff: true, policyEnforcedNow: true });
  const res = await api('POST', '/apply', { ...binding, stepUp: STEP_UP });
  assert.equal(res.status, 200, res.text);
  const summary = res.body.applied as Record<string, unknown>;
  assert.deepEqual(summary, { version: Number(summary.version), enabled: true, mappingChanged: true,
    reattestRequired: 2, issuerChanged: true, orphaned: 1, revoked: true, keysRevoked: 1, jitForcedOff: true });
  const active = activeRow();
  assert.equal(active?.issuer, NEW_ISSUER);
  assert.equal(active?.jit_enabled, 0, 'JIT forced off on the new active row');
  assert.ok(Number(stamp(orphan.id)) > 1, 'the orphan\'s sessions are stamped revoked');
  assert.equal(stamp(both.id), bothStamp, 'a member linked under the new issuer keeps the session');
  assert.equal(stamp(owner.id), ownerStamp, 'the owner is never revoked');
  assert.equal(keyCount(orphan.id), 0);
  assert.equal(keyCount(owner.id), 1);
  assert.deepEqual(liveRevocations, [orphan.id]);
  assert.equal(userIdentitiesDb.findByUserId(orphan.id).length, 1, 'old links are kept dormant');
  assert.equal(attestedAt(both.id), null, 'mapping change: re-attestation required');
  assert.notEqual(attestedAt(owner.id), null);
  const audit = db.prepare("SELECT user_id, metadata FROM audit_log WHERE action = 'sso_config_applied'").get() as
    { user_id: number; metadata: string };
  assert.equal(audit.user_id, owner.id);
  assert.deepEqual(JSON.parse(audit.metadata), summary);
});

test('keeping orphaned members signed in needs the typed confirmation', async () => {
  issuerChangeFixture();
  const orphanStamp = stamp(orphan.id);
  const binding = await proveDraft();
  for (const confirmation of [undefined, 'keep signed in', 'yes']) {
    const res = await api('POST', '/apply', { ...binding, keepOrphanedSessions: true, confirmation, stepUp: STEP_UP });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'sso_keep_confirmation_required');
  }
  const kept = await api('POST', '/apply', { ...binding, keepOrphanedSessions: true, confirmation: 'إبقاء الجلسات',
    stepUp: STEP_UP });
  assert.equal(kept.status, 200);
  assert.equal((kept.body.applied as { revoked: boolean }).revoked, false);
  assert.equal(stamp(orphan.id), orphanStamp);
  assert.equal(keyCount(orphan.id), 1);
  assert.deepEqual(liveRevocations, []);
});

test('I2: a mapping change nulls attestation of linked non-owners only; a non-mapping change does not', async () => {
  writeSsoRow(db);
  link(both.id, FIXTURE_ISSUER, 'sub-both');
  link(owner.id, FIXTURE_ISSUER, 'sub-owner');
  const memberStamp = stamp(both.id);
  const scopes = await proveDraft(draftBody({ extraScopes: 'groups' }));
  const unchanged = await api('POST', '/apply', { ...scopes, stepUp: STEP_UP });
  assert.deepEqual([(unchanged.body.applied as Record<string, unknown>).mappingChanged,
    (unchanged.body.applied as Record<string, unknown>).reattestRequired], [false, 0]);
  assert.notEqual(attestedAt(both.id), null);

  const rules = await proveDraft(draftBody({ extraScopes: 'groups',
    roleRules: [{ value: 'admin', role: 'admin' }, { value: 'member', role: 'user' }, { value: 'viewer', role: 'user' }] }));
  const changed = await api('POST', '/apply', { ...rules, stepUp: STEP_UP });
  const summary = changed.body.applied as Record<string, unknown>;
  assert.deepEqual([summary.mappingChanged, summary.reattestRequired, summary.issuerChanged, summary.orphaned],
    [true, 1, false, 0]);
  assert.equal(attestedAt(both.id), null);
  assert.notEqual(attestedAt(owner.id), null, 'the owner is never governed');
  assert.equal(stamp(both.id), memberStamp, 'no session revocation without an issuer change');
});

test('a forced audit failure rolls back the whole apply', async () => {
  issuerChangeFixture();
  const before = { active: activeRow(), orphanStamp: stamp(orphan.id), attested: attestedAt(both.id) };
  const binding = await proveDraft(draftBody({ jitEnabled: true }));
  db.exec(`CREATE TEMP TRIGGER force_apply_audit_failure BEFORE INSERT ON main.audit_log
    WHEN NEW.action = 'sso_config_applied' BEGIN SELECT RAISE(ABORT, 'forced'); END`);
  try {
    const res = await api('POST', '/apply', { ...binding, stepUp: STEP_UP });
    assert.equal(res.status, 500);
    assert.equal(res.body.code, 'internal_error');
  } finally {
    db.exec('DROP TRIGGER force_apply_audit_failure');
  }
  assert.deepEqual(activeRow(), before.active);
  assert.equal(stamp(orphan.id), before.orphanStamp);
  assert.equal(keyCount(orphan.id), 1);
  assert.equal(attestedAt(both.id), before.attested);
  assert.deepEqual(liveRevocations, [], 'no post-commit step without a commit');
});

test('apply re-encrypts a confidential secret under the active AAD', async () => {
  const secret = 'confidential-client-secret';
  useProvider(createMockOpenIdProvider({ clientAuth: 'client_secret_post', clientSecret: secret }));
  const binding = await proveDraft(draftBody({ clientAuth: 'client_secret_post', clientSecret: secret }));
  const res = await api('POST', '/apply', { ...binding, enable: true, stepUp: STEP_UP });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.ssoState, 'active', 'the active secret decrypts');
  const active = activeRow() as { client_secret_enc: string; issuer: string; client_id: string };
  const draft = db.prepare("SELECT client_secret_enc AS enc FROM sso_oidc_config WHERE slot = 'draft'").get() as
    { enc: string };
  assert.notEqual(active.client_secret_enc, draft.enc);
  const aad = { issuer: active.issuer, clientId: active.client_id };
  assert.equal(decryptSsoClientSecret(active.client_secret_enc, { slot: 'active', ...aad }), secret);
  assert.throws(() => decryptSsoClientSecret(draft.enc, { slot: 'active', ...aad }), 'a draft ciphertext never decrypts as active');
  assert.ok(!res.text.includes(secret));
});

test('I1/I6: disable in paused or unavailable needs no step-up, forces revocation, and outlives env', async () => {
  for (const legacy of [true, false]) {
    resetSsoFixture();
    if (legacy) process.env.OIDC_ENABLED = 'true';
    link(both.id, FIXTURE_ISSUER, 'sub-both');
    const before = stamp(both.id);
    assert.equal((await api('GET', '/')).body.ssoState, legacy ? 'paused' : 'unavailable');
    const keep = await api('POST', '/disable', { keepLinkedSessions: true });
    assert.equal(keep.status, 403, 'keeping sessions always needs step-up');
    const res = await api('POST', '/disable', {});
    assert.equal(res.status, 200, res.text);
    assert.deepEqual([res.body.linkedRevoked, res.body.keptSessions, res.body.ssoState], [1, false, 'off']);
    assert.notEqual(stamp(both.id), before);
    resetSsoConfigCacheForTests();
    const status = await api('GET', '/');
    assert.deepEqual([status.body.ssoState, status.body.disabledRecord], ['off', true]);
    if (legacy) assert.equal(process.env.OIDC_ENABLED, 'true', 'the record overrides env that is still set');
  }
});

test('I6: disable while active needs step-up; with it the owner may keep linked sessions', async () => {
  writeSsoRow(db);
  link(both.id, FIXTURE_ISSUER, 'sub-both');
  const before = stamp(both.id);
  assert.equal((await api('GET', '/')).body.ssoState, 'active');
  const refused = await api('POST', '/disable', {});
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, 'step_up_required');
  const res = await api('POST', '/disable', { keepLinkedSessions: true, stepUp: STEP_UP });
  assert.equal(res.status, 200);
  assert.deepEqual([res.body.keptSessions, res.body.linkedRevoked, res.body.ssoState], [true, 0, 'off']);
  assert.equal(stamp(both.id), before);
  assert.equal(activeRow()?.enabled, 0);
});

test('enable needs step-up and a valid active row; it clears the disabled record; FORCE_OFF refuses', async () => {
  const none = await api('POST', '/enable', { stepUp: STEP_UP });
  assert.deepEqual([none.status, none.body.code], [409, 'sso_active_config_missing']);
  writeSsoRow(db, { enabled: 0 });
  db.prepare("INSERT INTO app_config (key, value) VALUES ('sso.disabled', '{}')").run();
  assert.equal((await api('POST', '/enable', {})).status, 403);
  const res = await api('POST', '/enable', { stepUp: STEP_UP });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual([res.body.disabledRecordCleared, res.body.ssoState], [true, 'active']);
  process.env.NASSAJ_SSO_FORCE_OFF = '1';
  const forced = await api('POST', '/enable', { stepUp: STEP_UP });
  assert.deepEqual([forced.status, forced.body.code], [409, 'sso_force_off']);
  delete process.env.NASSAJ_SSO_FORCE_OFF;
  writeSsoRow(db, { runtime_fault: 'discovery_endpoint_changed' });
  const faulted = await api('POST', '/enable', { stepUp: STEP_UP });
  assert.deepEqual([faulted.body.code, faulted.body.reason], ['sso_runtime_fault', 'discovery_endpoint_changed']);
});

/**
 * ADR-H20 S6 unit tests: the privileged-action classification (N2), the
 * back-channel request limits, timeout and failure classification (N7), the
 * device-session helpers and their fail-closed paths, the new PKCE purposes,
 * the settings merge, and the repositories' prune and touch throttle.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test, { before } from 'node:test';

import {
  getConnection, initializeDatabase, oidcLogoutJtisDb, ssoDeviceSessionsDb, SSO_SESSION_IDLE_MS,
  ssoDeviceSessionIdleExpired,
} from '../modules/database/index.js';

import { isOwnerPrivilegedRequest } from './owner-privileged-actions.js';
import {
  BACKCHANNEL_MAX_BODY_BYTES,
  isRetryableVerifierFailure,
  processBackchannelLogout,
  readBackchannelRequest,
  withBackchannelTimeout,
} from './oidc-backchannel-logout.service.js';
import {
  addSsoIdpSid,
  grantOwnerPrivilege,
  idpSidOf,
  ownerStepUpRequired,
  sessionLoginHintOf,
  ssoRecheckDue,
  touchSsoDeviceSession,
} from './sso-device-session.service.js';
import { createOidcPkceStore } from './oidc-pkce.store.js';
import { endSessionUrlFor, mergeSsoLinkedSettings, readSsoLinkedSettings } from './sso-linked-settings.service.js';

const HOUR_MS = 60 * 60_000;

before(async () => {
  assert.ok(process.env.DATABASE_PATH, 'Use the isolated node test runner');
  await initializeDatabase();
});

function bind(overrides: Partial<Parameters<typeof ssoDeviceSessionsDb.bind>[0]> = {}) {
  const refreshSid = crypto.randomBytes(16).toString('base64url');
  ssoDeviceSessionsDb.bind({
    refreshSid, userId: 7, issuer: 'https://idp.example', idpSid: `V1_${refreshSid}`, loginHint: null,
    ownerTier: false, privilegedUntil: null, nowMs: Date.now(), pruneAfter: Date.now() + HOUR_MS, ...overrides,
  });
  return refreshSid;
}

// ---------------------------------------------------------------------------
// N2 classification
// ---------------------------------------------------------------------------

test('N2: privileged REST actions — settings, keys, users, server actions, terminal, agent commands', () => {
  const privileged: Array<[string, string]> = [
    ['PUT', '/api/settings/api-key-sso-window'], ['POST', '/api/settings/api-keys'], ['DELETE', '/api/settings/api-keys/3'],
    ['POST', '/api/settings/sso/apply'], ['PUT', '/api/settings/sso/linked-sessions'],
    ['POST', '/api/credential-grants'], ['PUT', '/api/providers/claude/key'], ['POST', '/api/connectors/x/install'],
    ['POST', '/api/system/pending/9/execute'], ['POST', '/api/system/update'],
    ['PATCH', '/api/auth/users/4/role'], ['DELETE', '/api/auth/users/4'], ['POST', '/api/auth/invites'], ['POST', '/api/admin/x'],
    ['GET', '/api/terminals'], ['POST', '/api/terminals'], ['POST', '/API/Terminals/1?x=1'],
    ['POST', '/api/commands/execute'], ['POST', '/api/session-steer'], ['POST', '/api/scheduled-messages'],
    ['POST', '/api/workflow-supervisor/launch'], ['POST', '/api/sessions/s1/permission-fence/acknowledge'],
    ['PUT', '/api/governance/x'], ['PUT', '/api/harness-files/x'],
    // M1: unlinking another user's SSO identity; M2: renaming or deleting a passkey.
    ['DELETE', '/api/auth/oidc/link/12'], ['DELETE', '/api/auth/oidc/link/selfish'],
    ['PATCH', '/api/auth/webauthn/credentials/3'], ['DELETE', '/api/auth/webauthn/credentials/3'],
    ['DELETE', '/api/auth/webauthn/credentials/3?x=1'],
  ];
  for (const [method, originalUrl] of privileged) {
    assert.equal(isOwnerPrivilegedRequest({ method, originalUrl }), true, `${method} ${originalUrl}`);
  }
  const open: Array<[string, string]> = [
    ['GET', '/api/settings/api-keys'], ['GET', '/api/settings/sso'], ['GET', '/api/auth/users'], ['GET', '/api/system/status'],
    ['POST', '/api/auth/logout'], ['POST', '/api/auth/refresh'], ['POST', '/api/auth/oidc/owner-step-up/start'],
    ['POST', '/api/projects/p/files'], ['POST', '/api/sessions/s1/messages'], ['HEAD', '/api/settings/x'],
    ['OPTIONS', '/api/system/x'], ['POST', '/api/settingsx'], ['POST', '/api/agent'],
    ['DELETE', '/api/auth/oidc/link/self'], ['DELETE', '/api/auth/oidc/link/self/'], ['GET', '/api/auth/oidc/link/12'],
    ['GET', '/api/auth/webauthn/credentials'], ['POST', '/api/auth/webauthn/register/options'],
    ['POST', '/api/auth/webauthn/register/verify'], ['POST', '/api/auth/webauthn/step-up/options'],
    ['POST', '/api/auth/webauthn/login/options'], ['POST', '/api/auth/webauthn/login/verify'],
  ];
  for (const [method, originalUrl] of open) {
    assert.equal(isOwnerPrivilegedRequest({ method, originalUrl }), false, `${method} ${originalUrl}`);
  }
});

test('N2: ownerStepUpRequired fails closed (true) for an owner when the binding cannot be read', (t) => {
  t.mock.method(process.stderr, 'write', () => true);
  const sid = bind({ ownerTier: true });
  assert.equal(ownerStepUpRequired({ role: 'owner', refreshSid: sid }), true);
  t.mock.method(ssoDeviceSessionsDb, 'get', () => { throw new Error('database is locked'); });
  assert.equal(ownerStepUpRequired({ role: 'owner', refreshSid: sid }), true, 'fail closed');
  assert.equal(ownerStepUpRequired({ role: 'user', refreshSid: sid }), false, 'members are never gated here');
  assert.equal(ownerStepUpRequired({ role: 'owner', refreshSid: null }), false);
  assert.equal(ownerStepUpRequired(undefined), false);
});

test('H2: a member-tier SSO binding of a user now holding the owner role is gated', () => {
  const promoted = bind({ ownerTier: false });
  assert.equal(ownerStepUpRequired({ role: 'user', refreshSid: promoted }), false, 'still a member: never gated');
  assert.equal(ownerStepUpRequired({ role: 'owner', refreshSid: promoted }), true, 'promoted: fresh owner sign-in');
  assert.equal(ownerStepUpRequired({ role: 'owner', refreshSid: 'password-session-without-row' }), false);
});

test('N2: a grant is only for an owner-tier row; a member binding gets none', () => {
  const member = bind();
  assert.equal(grantOwnerPrivilege(member), null);
  assert.equal(ssoDeviceSessionsDb.get(member)?.privileged_until, null);
  const owner = bind({ ownerTier: true });
  const until = grantOwnerPrivilege(owner, 1_000);
  assert.equal(until, 1_000 + 60 * 60_000);
  assert.equal(grantOwnerPrivilege('missing-sid-xxxxxxxxxx'), null);
});

// ---------------------------------------------------------------------------
// Device-session helpers and repositories
// ---------------------------------------------------------------------------

test('idpSidOf / sessionLoginHintOf take bounded printable values only', () => {
  assert.equal(idpSidOf({ sid: 'V1_123' }), 'V1_123');
  for (const sid of [undefined, '', 7, 'a\u0000b', 'x'.repeat(256)]) assert.equal(idpSidOf({ sid }), null, String(sid));
  assert.equal(sessionLoginHintOf({ preferred_username: 'u@idp' }), 'u@idp');
  for (const name of [undefined, '', 'a b', 'a\nb', 'x'.repeat(256)]) assert.equal(sessionLoginHintOf({ preferred_username: name }), null);
});

test('ssoRecheckDue: at the interval, not before; no row never re-checks', () => {
  const nowMs = 100 * HOUR_MS;
  assert.equal(ssoRecheckDue({ last_recheck_at: nowMs - 12 * HOUR_MS }, 12, nowMs), true);
  assert.equal(ssoRecheckDue({ last_recheck_at: nowMs - 12 * HOUR_MS + 1 }, 12, nowMs), false);
  assert.equal(ssoRecheckDue(undefined, 12, nowMs), false);
});

test('idle predicate: 24 h exactly is still in; a millisecond more is out', () => {
  assert.equal(ssoDeviceSessionIdleExpired({ last_seen_at: 0 }, SSO_SESSION_IDLE_MS), false);
  assert.equal(ssoDeviceSessionIdleExpired({ last_seen_at: 0 }, SSO_SESSION_IDLE_MS + 1), true);
  assert.equal(ssoDeviceSessionIdleExpired(undefined, Number.MAX_SAFE_INTEGER), false);
});

test('touch is throttled and best effort; addIdpSid needs an existing row', (t) => {
  const sid = bind();
  const start = ssoDeviceSessionsDb.get(sid)!.last_seen_at;
  touchSsoDeviceSession(sid, start + 60_000);
  assert.equal(ssoDeviceSessionsDb.get(sid)!.last_seen_at, start, 'inside 5 min: no write');
  touchSsoDeviceSession(sid, start + 5 * 60_000);
  assert.equal(ssoDeviceSessionsDb.get(sid)!.last_seen_at, start + 5 * 60_000);
  t.mock.method(process.stderr, 'write', () => true);
  t.mock.method(ssoDeviceSessionsDb, 'touch', () => { throw new Error('locked'); });
  assert.doesNotThrow(() => touchSsoDeviceSession(sid, start + 20 * 60_000));
  t.mock.restoreAll();
  assert.equal(addSsoIdpSid('no-such-session-xxxxxxx', 'V1_x'), false);
  assert.equal(addSsoIdpSid(sid, 'V1_second'), true);
  assert.equal(ssoDeviceSessionsDb.findByIdpSid('https://idp.example', 'V1_second')[0]?.refresh_sid, sid);
});

test('a bind prunes rows past prune_after (and their sids), never live ones', () => {
  const old = bind({ pruneAfter: 10 });
  const live = bind({ pruneAfter: Date.now() + HOUR_MS });
  bind();
  assert.equal(ssoDeviceSessionsDb.get(old), undefined);
  assert.equal(ssoDeviceSessionsDb.findByIdpSid('https://idp.example', `V1_${old}`).length, 0);
  assert.ok(ssoDeviceSessionsDb.get(live));
  assert.ok(ssoDeviceSessionsDb.pruneExpired(Date.now() + 2 * HOUR_MS) >= 2);
});

test('jti store: seen only while unexpired; full refuses without evicting; expired rows are pruned', () => {
  getConnection().exec('DELETE FROM oidc_logout_jtis');
  const nowMs = Date.now();
  assert.equal(oidcLogoutJtisDb.record('iss', 'a', { expiresAt: nowMs + 1000, nowMs, maxEntries: 2 }), 'recorded');
  assert.equal(oidcLogoutJtisDb.record('iss', 'b', { expiresAt: nowMs + 1000, nowMs, maxEntries: 2 }), 'recorded');
  assert.equal(oidcLogoutJtisDb.record('iss', 'c', { expiresAt: nowMs + 1000, nowMs, maxEntries: 2 }), 'full');
  assert.equal(oidcLogoutJtisDb.seen('iss', 'a', nowMs), true);
  assert.equal(oidcLogoutJtisDb.seen('other-iss', 'a', nowMs), false, 'keyed by issuer too');
  assert.equal(oidcLogoutJtisDb.seen('iss', 'a', nowMs + 1000), false);
  assert.equal(oidcLogoutJtisDb.record('iss', 'c', { expiresAt: nowMs + 5000, nowMs: nowMs + 1000, maxEntries: 2 }), 'recorded',
    'expired rows make room');
  assert.equal(oidcLogoutJtisDb.countActive(nowMs + 1000), 1);
});

// ---------------------------------------------------------------------------
// N7 request handling
// ---------------------------------------------------------------------------

test('D5 request limits: form encoding only, ≤ 8 KB declared and actual, one string token', () => {
  const req = (headers: Record<string, string>, body: unknown) => ({ headers, body }) as never;
  const form = { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' };
  assert.deepEqual(readBackchannelRequest(req(form, { logout_token: 't' })), { token: 't' });
  assert.equal(readBackchannelRequest(req({ 'content-type': 'application/json' }, { logout_token: 't' })).status, 415);
  assert.equal(readBackchannelRequest(req({}, { logout_token: 't' })).status, 415);
  assert.equal(readBackchannelRequest(req({ ...form, 'content-length': String(BACKCHANNEL_MAX_BODY_BYTES + 1) }, {})).status, 413);
  assert.equal(readBackchannelRequest(req(form, { logout_token: 'x'.repeat(BACKCHANNEL_MAX_BODY_BYTES + 1) })).status, 413);
  for (const body of [{}, { logout_token: '' }, { logout_token: ['a'] }, undefined]) {
    assert.equal(readBackchannelRequest(req(form, body)).status, 400, JSON.stringify(body));
  }
});

test('D5: our own failures are retryable (503), an invalid token is not (400)', async () => {
  for (const code of ['jwks_unavailable', 'unknown_or_ambiguous_kid', 'endpoint_unpinned', 'invalid_jwks']) {
    assert.equal(isRetryableVerifierFailure({ code }), true, code);
  }
  for (const code of ['invalid_algorithm', 'signature_or_registered_claim_invalid', 'logout_sid_required', undefined]) {
    assert.equal(isRetryableVerifierFailure({ code }), false, String(code));
  }
  const unavailable = await processBackchannelLogout({
    verifier: { verifyLogoutToken: async () => { throw Object.assign(new Error('x'), { code: 'jwks_unavailable' }); } },
    issuer: 'iss', token: 't',
  });
  assert.deepEqual(unavailable, { status: 503, reason: 'verifier_unavailable:jwks_unavailable' });
  const invalid = await processBackchannelLogout({
    verifier: { verifyLogoutToken: async () => { throw new Error('boom'); } }, issuer: 'iss', token: 't',
  });
  assert.deepEqual(invalid, { status: 400, reason: 'invalid_token' });
});

test('D5: processing past 5 s answers 503 so the IdP retries', async () => {
  const slow = new Promise<{ status: number; reason: string }>((resolve) => setTimeout(() => resolve({ status: 200, reason: 'x' }), 50));
  assert.deepEqual(await withBackchannelTimeout(slow, 5), { status: 503, reason: 'timeout' });
  assert.deepEqual(await withBackchannelTimeout(Promise.resolve({ status: 200, reason: 'ok' }), 50), { status: 200, reason: 'ok' });
});

// ---------------------------------------------------------------------------
// PKCE purposes and settings
// ---------------------------------------------------------------------------

test('PKCE: owner_step_up and recheck bind user, request time and a device-session id; login may carry requestedAtMs', () => {
  const store = createOidcPkceStore();
  const browser = `${'b'.repeat(42)}A`;
  const secrets = { nonce: 'n', codeVerifier: 'v', browserTransaction: browser, configVersion: 3 };
  const refreshSid = 'R'.repeat(22);
  for (const purpose of ['owner_step_up', 'recheck'] as const) {
    assert.equal(store.store(purpose, { ...secrets, purpose, userId: 4, requestedAtMs: 9, refreshSid } as never), true);
    assert.deepEqual(store.consume(purpose, browser), {
      nonce: 'n', codeVerifier: 'v', purpose, userId: 4, requestedAtMs: 9, refreshSid, configVersion: 3,
    });
  }
  assert.equal(store.store('login', { ...secrets, requestedAtMs: 5 } as never), true);
  assert.deepEqual(store.consume('login', browser), { nonce: 'n', codeVerifier: 'v', purpose: 'login', configVersion: 3, requestedAtMs: 5 });
  const invalid: Array<Record<string, unknown>> = [
    { purpose: 'recheck', userId: 4, requestedAtMs: 9 },
    { purpose: 'recheck', userId: 4, requestedAtMs: 9, refreshSid: 'short' },
    { purpose: 'owner_step_up', userId: 4, requestedAtMs: 9, refreshSid, audience: 'connector_owner' },
    { purpose: 'link', userId: 4, requestedAtMs: 9, refreshSid },
    { purpose: 'step_up', userId: 4, requestedAtMs: 9, audience: 'connector_owner', refreshSid },
    { purpose: 'login', refreshSid },
    { purpose: 'login', requestedAtMs: Number.NaN },
  ];
  for (const binding of invalid) {
    assert.equal(store.store('s', { ...secrets, ...binding } as never), false, JSON.stringify(binding));
  }
});

test('settings merge: partial updates over the current values; any bad field refuses all', () => {
  const current = readSsoLinkedSettings();
  assert.deepEqual(mergeSsoLinkedSettings({ autoSignIn: true }, current), { ...current, autoSignIn: true });
  assert.equal(mergeSsoLinkedSettings({ autoSignIn: true, recheckIntervalHours: 30 }, current), null);
  assert.equal(mergeSsoLinkedSettings({ toString: true }, current), null);
  assert.equal(mergeSsoLinkedSettings('autoSignIn', current), null);
});

test('endSessionUrlFor: null without a client or endpoint, never throws', async (t) => {
  t.mock.method(process.stderr, 'write', () => true);
  assert.equal(await endSessionUrlFor(null), null);
  assert.equal(await endSessionUrlFor({ clientId: 'c', verifier: {} }), null);
  assert.equal(await endSessionUrlFor({ clientId: 'c', verifier: { endSessionEndpoint: async () => null } }), null);
  assert.equal(await endSessionUrlFor({ clientId: 'c', verifier: { endSessionEndpoint: async () => 'not a url' } }), null);
  assert.equal(await endSessionUrlFor({ clientId: 'c', verifier: { endSessionEndpoint: async () => 'https://idp/end' } }),
    'https://idp/end?client_id=c');
});

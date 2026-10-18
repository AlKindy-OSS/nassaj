/**
 * ADR-H20 S6 unit tests: the
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

import {
  BACKCHANNEL_MAX_BODY_BYTES,
  isRetryableVerifierFailure,
  processBackchannelLogout,
  readBackchannelRequest,
  withBackchannelTimeout,
} from './oidc-backchannel-logout.service.js';
import {
  addSsoIdpSid,
  idpSidOf,
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
    ownerTier: false, nowMs: Date.now(), pruneAfter: Date.now() + HOUR_MS, ...overrides,
  });
  return refreshSid;
}

test('N2 withdrawn (2026-10-18): a bind never writes a privileged grant, owner tier or not', () => {
  assert.equal(ssoDeviceSessionsDb.get(bind())?.privileged_until, null);
  assert.equal(ssoDeviceSessionsDb.get(bind({ ownerTier: true }))?.privileged_until, null);
  assert.equal(ssoDeviceSessionsDb.get(bind({ ownerTier: true }))?.owner_tier, 1);
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

test('PKCE: recheck binds user, request time and a device-session id; owner_step_up is gone; login may carry requestedAtMs', () => {
  const store = createOidcPkceStore();
  const browser = `${'b'.repeat(42)}A`;
  const secrets = { nonce: 'n', codeVerifier: 'v', browserTransaction: browser, configVersion: 3 };
  const refreshSid = 'R'.repeat(22);
  for (const purpose of ['recheck'] as const) {
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
    { purpose: 'owner_step_up', userId: 4, requestedAtMs: 9, refreshSid },
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

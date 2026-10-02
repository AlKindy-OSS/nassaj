/**
 * ADR-194 S8 gap tests on the shared settings harness (real settings router,
 * OIDC router, auth router, services and database; the IdP is the in-process
 * mock OpenID Provider):
 *
 *  - D9 / I7 recovery path for an orphaned member, end to end through the
 *    routes: issuer change orphans and revokes the member → owner unlinks
 *    (DELETE /api/auth/oidc/link/:userId) → owner resets the password
 *    (temporary, must_change_password) → member changes it and self-links
 *    under the new issuer (POST /link/self/start with the current password).
 *  - Test plan item 8, upgrade of an env-configured node: paused and enforced
 *    with the legacy env, import-env, a nested role path, test-discovery, test
 *    sign-in, apply; existing user_identities still resolve and JIT works
 *    under role_grant_scope; the owner's IdP link stays refused.
 *  - I4: apply performs no request to the identity provider.
 */
import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';

import {
  api, app, baseUrl, db, draftBody, member, op, owner, OWNER_PASSWORD, proveDraft, resetSsoFixture, STEP_UP, useProvider,
} from './__tests__/settings-sso-harness.js';

const { default: authRouter } = await import('./auth.js');
const { generateToken } = await import('../middleware/auth.js');
const { userDb, userIdentitiesDb } = await import('../modules/database/index.js');
const { hashPassword } = await import('../services/password.service.js');
const { createMockOpenIdProvider } = await import('../services/__tests__/mock-openid-provider.js');
const { BROWSER_TRANSACTION_COOKIE } = await import('../services/oidc-browser-transaction.js');
const { resetSsoConfigCacheForTests, ssoState } = await import('../services/sso-config.service.js');

app.use('/api/auth', authRouter);

const MEMBER_PASSWORD = 'member-local-password-1';
const NEW_ISSUER = 'https://idp-next.example';
const memberHash = await hashPassword(MEMBER_PASSWORD);

beforeEach(() => {
  resetSsoFixture();
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(memberHash, member.id);
});

type Json = Record<string, unknown>;
async function http(method: string, route: string, init: { token?: string; body?: unknown; cookie?: string;
  headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...init.headers };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  if (init.cookie) headers.cookie = init.cookie;
  const res = await fetch(`${baseUrl}${route}`, {
    method, headers, redirect: 'manual', body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  let json: Json = {};
  try { json = JSON.parse(text) as Json; } catch { json = {}; }
  return { status: res.status, json, headers: res.headers };
}

const tokenFor = (userId: number) => generateToken(userDb.getUserById(userId));
const login = (username: string, password: string) => http('POST', '/api/auth/login', { body: { username, password } });
const cookieOf = (headers: Headers, name: string) => (headers.getSetCookie?.() ?? [headers.get('set-cookie') ?? ''])
  .map((value) => value.split(';', 1)[0]).find((value) => value.startsWith(`${name}=`)) ?? '';

/** GET /login → mock IdP → /callback → /exchange; returns the exchange answer or the refusal code. */
async function ssoLogin(claims: Json) {
  const start = await http('GET', '/api/auth/oidc/login');
  const cookie = cookieOf(start.headers, BROWSER_TRANSACTION_COOKIE);
  const { code, state } = op.authorize(String(start.headers.get('location')), claims);
  const back = await http('GET', `/api/auth/oidc/callback?${new URLSearchParams({ state, code })}`, { cookie });
  const target = new URL(String(back.headers.get('location')), 'https://app.example');
  const oneTime = target.searchParams.get('oidc_code');
  if (!oneTime) return { refusal: target.searchParams.get('error') };
  const exchanged = await http('POST', '/api/auth/oidc/exchange', { cookie, body: { code: oneTime } });
  return { userId: exchanged.json.userId as number, token: exchanged.json.token as string };
}

async function applyDraft(body: Json, claims?: Json) {
  const binding = await proveDraft(body, claims);
  return api('POST', '/apply', { draftVersion: binding.draftVersion, configHash: binding.configHash, enable: true, stepUp: STEP_UP });
}

test('D9 recovery path: issuer change orphans the member; unlink, reset and self-link restore them', async () => {
  const first = await applyDraft(draftBody());
  assert.equal(first.status, 200, 'first apply');
  const oldLink = userIdentitiesDb.link(member.id, op.issuer, 'sub-member-old');
  userIdentitiesDb.markAttested(oldLink, member.id, Date.now());
  assert.equal((await login(member.username, MEMBER_PASSWORD)).json.code, 'sso_required', 'linked member is SSO-only');

  useProvider(createMockOpenIdProvider({ issuer: NEW_ISSUER }));
  const switched = await applyDraft(draftBody({ issuer: NEW_ISSUER }));
  assert.equal(switched.status, 200, 'issuer-change apply');
  assert.equal((switched.body.applied as Json).orphaned, 1);
  assert.equal((switched.body.applied as Json).revoked, true);

  const orphanLogin = await login(member.username, MEMBER_PASSWORD);
  assert.equal(orphanLogin.status, 403, 'requiresSsoLogin stays issuer-agnostic: no stale password revival');
  assert.notEqual((await ssoLogin({ sub: 'sub-member-old', roles: ['member'], org: 'org-1' })).refusal, null,
    'the old subject does not resolve under the new issuer (no rename)');

  const ownerToken = tokenFor(owner.id);
  const unlinked = await http('DELETE', `/api/auth/oidc/link/${member.id}`, { token: ownerToken });
  assert.equal(unlinked.status, 200, 'owner unlinks the orphan');
  const reset = await http('POST', `/api/auth/users/${member.id}/reset-password`, { token: ownerToken });
  assert.equal(reset.status, 200, 'owner resets the password');
  const temporary = String(reset.json.tempPassword);

  const firstLogin = await login(member.username, temporary);
  assert.equal(firstLogin.json.passwordChangeRequired, true, 'temporary password forces a change');
  const passwordCookie = cookieOf(firstLogin.headers, '__Host-nassaj_password_change');
  const csrf = await http('GET', `/api/auth/mutation-csrf?${new URLSearchParams({ method: 'PATCH', path: '/api/auth/me/password' })}`,
    { cookie: passwordCookie });
  const newPassword = 'member-after-reset-password-2';
  const changed = await http('PATCH', '/api/auth/me/password', {
    cookie: passwordCookie, headers: { 'x-csrf-token': String(csrf.json.csrfToken), origin: baseUrl },
    body: { currentPassword: temporary, newPassword },
  });
  assert.equal(changed.status, 200, 'member sets a new password');

  const local = await login(member.username, newPassword);
  assert.equal(local.status, 200, 'unlinked member signs in locally');
  const start = await http('POST', '/api/auth/oidc/link/self/start', {
    token: String(local.json.token), body: { currentPassword: newPassword },
  });
  assert.equal(start.status, 200, 'self-link starts with the current password');
  const cookie = cookieOf(start.headers, BROWSER_TRANSACTION_COOKIE);
  const { code, state } = op.authorize(String(start.json.authorizationUrl), { sub: 'sub-member-new', roles: ['member'], org: 'org-1' });
  await http('GET', `/api/auth/oidc/callback?${new URLSearchParams({ state, code })}`, { cookie });
  assert.equal(userIdentitiesDb.countForUserAndIssuer(member.id, NEW_ISSUER), 1, 'linked under the new issuer');
  const sso = await ssoLogin({ sub: 'sub-member-new', roles: ['member'], org: 'org-1' });
  assert.equal(sso.userId, member.id, 'the member signs in through the new IdP');
  assert.equal((await login(member.username, newPassword)).json.code, 'sso_required', 'and is SSO-only again');
  assert.equal((await login(owner.username, OWNER_PASSWORD)).status, 200, 'owner password throughout');
});

const LEGACY_ENV = {
  OIDC_ENABLED: 'true', OIDC_CLIENT_ID: 'nassaj-client', OIDC_ROLE_PROJECT_ID: 'proj-1',
  OIDC_ALLOWED_ORG_IDS: 'org-1,org-2', OIDC_JIT_ENABLED: 'true', OIDC_ATTESTATION_MAX_AGE_HOURS: '30',
  OIDC_REDIRECT_URI: 'https://old-host.example/api/auth/oidc/callback',
};
const NESTED = (role: string, scope: string) => ({ 'urn:example:roles': { [role]: { [scope]: 'tenant.example' } } });

function seedLegacyNode(env: Record<string, string>) {
  Object.assign(process.env, { OIDC_ISSUER_URL: op.issuer, ...env });
  const linked = userIdentitiesDb.link(member.id, op.issuer, 'sub-member');
  userIdentitiesDb.markAttested(linked, member.id, Date.now());
  userIdentitiesDb.link(owner.id, op.issuer, 'sub-owner');
  resetSsoConfigCacheForTests();
}

test('test plan 8: an env-configured node upgrades paused → import → test → apply; links resolve, JIT by scope', async () => {
  seedLegacyNode(LEGACY_ENV);
  assert.equal(ssoState(), 'paused');
  assert.equal((await login(member.username, MEMBER_PASSWORD)).json.code, 'sso_required', 'linked member refused');
  assert.equal((await login(owner.username, OWNER_PASSWORD)).status, 200, 'owner password works while paused');
  assert.equal((await http('POST', '/api/auth/invites', { token: tokenFor(owner.id), body: { role: 'user' } })).status, 403);
  assert.equal((await http('GET', '/api/auth/oidc/login')).status, 501, 'no SSO login (the owner link is unusable)');

  const imported = await api('POST', '/import-env');
  assert.equal(imported.status, 200, imported.text);
  const draft = imported.body.draft as Json;
  assert.equal(draft.issuer, op.issuer, 'issuer byte-identical');
  assert.equal(draft.clientAuth, 'none');
  assert.equal(draft.jitEnabled, true);
  assert.equal(draft.attestationMaxAgeHours, 24, 'clamped to 24');
  assert.equal(draft.tenantMode, 'role_grant_scope');
  assert.deepEqual(draft.tenantValues, ['org-1', 'org-2']);
  assert.deepEqual(draft.roleRules, [{ value: 'admin', role: 'admin' }, { value: 'member', role: 'user' }, { value: 'viewer', role: 'user' }]);
  assert.ok((imported.body.warnings as Json[]).some((warning) => warning.code === 'redirect_uri_mismatch'));

  const body = draftBody({ roleClaimPath: '["urn:example:roles"]', roleRules: draft.roleRules, tenantMode: 'role_grant_scope',
    tenantClaimPath: null, tenantValues: draft.tenantValues, jitEnabled: true, attestationMaxAgeHours: 24 });
  const applied = await applyDraft(body, { sub: 'sub-owner-test', ...NESTED('member', 'org-1') });
  assert.equal(applied.status, 200, applied.text);
  assert.equal(applied.body.ssoState, 'active');
  assert.equal((applied.body.applied as Json).jitForcedOff, false, 'same issuer: JIT kept');

  const existing = await ssoLogin({ sub: 'sub-member', ...NESTED('member', 'org-2') });
  assert.equal(existing.userId, member.id, 'the existing identity resolves to the same account');
  const jit = await ssoLogin({ sub: 'sub-new', preferred_username: 'scoped_newcomer', ...NESTED('member', 'org-2') });
  assert.equal(userDb.getUserById(Number(jit.userId))?.role, 'user', 'JIT under role_grant_scope');
  const outOfScope = await ssoLogin({ sub: 'sub-outsider', ...NESTED('admin', 'org-9') });
  assert.ok(outOfScope.refusal, 'a grant outside the allowed scopes grants nothing');
  assert.equal((await ssoLogin({ sub: 'sub-owner', ...NESTED('admin', 'org-1') })).refusal, 'owner_must_sign_in_locally');
  assert.equal((await login(owner.username, OWNER_PASSWORD)).status, 200, 'owner password after apply');
});

test('test plan 8: OIDC_ENABLED=true without a project id is paused and enforced too', async () => {
  const { OIDC_ROLE_PROJECT_ID: _omitted, ...env } = LEGACY_ENV;
  seedLegacyNode(env);
  assert.equal(ssoState(), 'paused');
  assert.equal((await login(member.username, MEMBER_PASSWORD)).json.code, 'sso_required');
  assert.equal((await login(owner.username, OWNER_PASSWORD)).status, 200);
});

test('I4: apply copies the pinned endpoints and performs no request to the identity provider', async () => {
  const { draftVersion, configHash } = await proveDraft(draftBody());
  const before = op.requests.length;
  const applied = await api('POST', '/apply', { draftVersion, configHash, enable: true, stepUp: STEP_UP });
  assert.equal(applied.status, 200, applied.text);
  assert.equal(op.requests.length, before, 'no discovery, JWKS or token request during apply');
  const pins = db.prepare("SELECT pinned_endpoints_json AS p FROM sso_oidc_config WHERE slot = 'active'").get() as { p: string };
  assert.equal(JSON.parse(pins.p).token_endpoint, `${op.issuer}/token`);
});

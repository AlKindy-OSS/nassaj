/**
 * ADR-194 S3 end to end: the REAL router, runtime, verifier, pinned fetch,
 * test sign-in service and database against an in-process mock OpenID
 * Provider (a pinnedFetchJson transport; no socket, no Docker).
 *
 * Covers the D2 callback order and the test-branch isolation spies (zero calls
 * to every session, link, role, attestation, provisioning and grant writer for
 * every test outcome), RFC 9207 on the selected config, the N1 version fence
 * (apply between start and callback; apply between mint and redirect), pinned
 * endpoints with persisted drift, confidential client authentication, owner
 * refusal, and the back channel in broken states.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import test, { after, beforeEach, mock } from 'node:test';
import { pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';

import { createMockOpenIdProvider } from '../services/__tests__/mock-openid-provider.js';

const url = (spec: string) => pathToFileURL(path.resolve(import.meta.dirname, spec)).href;
const passThrough = (_req: unknown, _res: unknown, next: () => void) => next();
process.env.NASSAJ_PROVIDER_SECRETS_KEY = crypto.randomBytes(32).toString('base64');
for (const key of ['OIDC_ENABLED', 'OIDC_ISSUER_URL', 'OIDC_CLIENT_ID', 'OIDC_REDIRECT_URI']) delete process.env[key];

// ---- spies on every writer a test sign-in must never reach (D2) -------------
const calls = new Map<string, number>();
const count = (name: string) => calls.get(name) ?? 0;
function spy<Args extends unknown[], R>(name: string, fn: (...args: Args) => R) {
  return (...args: Args): R => {
    calls.set(name, count(name) + 1);
    return fn(...args);
  };
}
let onGenerateToken: (() => void) | null = null;

const realRoleMapper = await import(url('../services/external-role-mapper.js'));
const realJit = await import(url('../services/oidc-jit-provision.js'));
const realSelfLink = await import(url('../services/oidc-self-link.js'));
const realTestSignIn = await import(url('../services/sso-test-signin.service.js'));
const { createOidcCodeStore } = await import(url('../services/oidc-code.store.js'));
const { createOidcStepUpGrantStore } = await import(url('../services/oidc-step-up-grant.store.js'));
const codes = createOidcCodeStore();
const grants = createOidcStepUpGrantStore();

mock.module(url('../services/external-role-mapper.js'), {
  namedExports: { ...realRoleMapper, syncExternalRole: spy('syncExternalRole', realRoleMapper.syncExternalRole) },
});
mock.module(url('../services/oidc-jit-provision.js'), {
  namedExports: { ...realJit, provisionSsoUser: spy('provisionSsoUser', realJit.provisionSsoUser) },
});
mock.module(url('../services/oidc-self-link.js'), {
  namedExports: {
    ...realSelfLink, linkIdentityWithAttestation: spy('linkIdentityWithAttestation', realSelfLink.linkIdentityWithAttestation),
  },
});
mock.module(url('../services/sso-test-signin.service.js'), {
  namedExports: {
    ...realTestSignIn,
    completeTestSignIn: spy('completeTestSignIn', realTestSignIn.completeTestSignIn),
    recordTestFailure: spy('recordTestFailure', realTestSignIn.recordTestFailure),
  },
});
mock.module(url('../services/oidc-code.store.js'), {
  namedExports: {
    oidcCodeStore: {
      store: spy('oidcCodeStore.put', codes.store), consume: codes.consume, discard: codes.discard,
      get size() { return codes.size; },
    },
  },
});
mock.module(url('../services/oidc-step-up-grant.store.js'), {
  namedExports: { oidcStepUpGrantStore: { ...grants, issue: spy('grantStore.issue', grants.issue) } },
});
mock.module(url('../middleware/auth.js'), {
  namedExports: {
    authenticateToken: (req: { headers: Record<string, string | undefined>; user?: unknown }, _r: unknown, next: () => void) => {
      req.user = { id: Number(req.headers['x-test-user-id']), role: String(req.headers['x-test-role'] ?? 'user') };
      next();
    },
    generateToken: spy('generateToken', (user: { id: number }) => {
      onGenerateToken?.();
      return `jwt-for-${user.id}`;
    }),
    invalidateRefreshCache: () => {},
    requireRole: () => passThrough,
  },
});
mock.module(url('../middleware/rate-limit.js'), { namedExports: { createRateLimiter: () => passThrough } });
mock.module(url('../modules/account-wallet/user-identity-revocation.js'), {
  namedExports: { revokeUserIdentity: () => ({ abortedRuns: 0, closedSockets: 0, endedInteractiveSessions: 0 }) },
});
mock.module(url('../services/notification-orchestrator.js'), {
  namedExports: { createNotificationEvent: (event: unknown) => event, notifyUserIfEnabled: () => {} },
});
mock.module(url('../utils/client-ip.js'), { namedExports: { clientIp: () => '127.0.0.1' } });

const { initializeDatabase } = await import('../modules/database/init-db.js');
const { stopReconcileScheduler } = await import('../modules/database/project-reconcile.service.js');
const { getConnection } = await import('../modules/database/connection.js');
const { userDb, userIdentitiesDb } = await import('../modules/database/index.js');
const { encryptSsoClientSecret } = await import('../modules/database/sso-secret-envelope.js');
const { clearSsoConfig, writeSsoRow, FIXTURE_ISSUER } = await import('../services/__tests__/sso-config-fixture.js');
const { resetSsoConfigCacheForTests, ssoState } = await import('../services/sso-config.service.js');
const { setSsoNetworkOverridesForTests } = await import('../services/sso-oidc-runtime.service.js');
const { BROWSER_TRANSACTION_COOKIE } = await import('../services/oidc-browser-transaction.js');
await initializeDatabase();
stopReconcileScheduler();

const { default: oidcRouter, beginTestAuthorization } = await import('./oidc.js');
const app = express();
app.use(express.json());
app.use('/api/auth/oidc', oidcRouter);
const server: Server = app.listen(0);
await new Promise<void>((resolve) => server.once('listening', resolve));
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// Repository writers, spied on the shared repository objects the routes call.
const repoSpies = [
  mock.method(userIdentitiesDb, 'markAttested'),
  mock.method(userIdentitiesDb, 'link'),
  mock.method(userDb, 'setRoleIfUnchanged'),
  mock.method(userDb, 'createSsoUser'),
];
const FORBIDDEN_FOR_TEST = ['generateToken', 'oidcCodeStore.put', 'syncExternalRole', 'provisionSsoUser',
  'linkIdentityWithAttestation', 'grantStore.issue'];

function assertNoPrivilegedWrite(label: string) {
  for (const name of FORBIDDEN_FOR_TEST) assert.equal(count(name), 0, `${label}: ${name}`);
  for (const repoSpy of repoSpies) assert.equal(repoSpy.mock.callCount(), 0, `${label}: repository writer`);
}

const db = getConnection();
const owner = userDb.createUser('e2e_owner', 'hash-owner', 'owner');
const secondOwner = userDb.createUser('e2e_owner_two', 'hash-owner', 'owner');
const admin = userDb.createUser('e2e_admin', 'hash-admin', 'admin');
const member = userDb.createUser('e2e_member', 'hash-member', 'user');
let op = createMockOpenIdProvider();
const MEMBER_CLAIMS = { sub: 'sub-member', roles: ['member'], org: 'org-1' };

function useProvider(provider: ReturnType<typeof createMockOpenIdProvider>) {
  op = provider;
  setSsoNetworkOverridesForTests(provider.network);
}

beforeEach(() => {
  clearSsoConfig(db);
  db.exec('DELETE FROM user_identities; DELETE FROM sso_test_results; DELETE FROM sso_apply_proofs;');
  db.prepare('UPDATE users SET role = ? WHERE id IN (?, ?)').run('owner', owner.id, secondOwner.id);
  userIdentitiesDb.link(member.id, FIXTURE_ISSUER, 'sub-member');
  resetSsoConfigCacheForTests();
  useProvider(createMockOpenIdProvider());
  calls.clear();
  for (const repoSpy of repoSpies) repoSpy.mock.resetCalls();
  onGenerateToken = null;
});

const stamp = (userId: number) => (db.prepare('SELECT password_changed_at AS v FROM users WHERE id = ?')
  .get(userId) as { v: number | null }).v;
const draftRow = (overrides = {}) => writeSsoRow(db, { enabled: 0, draft_version: 3, ...overrides }, 'draft');
const activeRow = (overrides = {}) => writeSsoRow(db, overrides);

type Started = { authorizationUrl: string; cookie: string };

async function startTest(ownerUserId: number): Promise<Started | { refusal: string }> {
  let transaction = '';
  const fakeRes = { cookie: (_name: string, value: string) => { transaction = value; }, set: () => fakeRes };
  const started = await beginTestAuthorization(fakeRes as never, ownerUserId);
  if ('refusal' in started) return started;
  return { authorizationUrl: started.authorizationUrl, cookie: `${BROWSER_TRANSACTION_COOKIE}=${transaction}` };
}

async function startLogin(): Promise<Started> {
  const res = await fetch(`${baseUrl}/api/auth/oidc/login`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  return {
    authorizationUrl: res.headers.get('location') ?? '',
    cookie: (res.headers.get('set-cookie') ?? '').split(';', 1)[0] ?? '',
  };
}

function callback(query: Record<string, string>, cookie: string) {
  return fetch(`${baseUrl}/api/auth/oidc/callback?${new URLSearchParams(query)}`, { headers: { cookie }, redirect: 'manual' });
}

/** Signs in at the mock IdP and follows the redirect back to the callback. */
async function complete(started: Started, claims: Record<string, unknown>, extra: Record<string, string> = {}) {
  const { code, state } = op.authorize(started.authorizationUrl, claims);
  return callback({ state, code, ...extra }, started.cookie);
}

function testResultId(res: Response) {
  const location = new URL(res.headers.get('location') ?? '', 'https://app.example');
  assert.equal(location.pathname, '/');
  assert.equal(location.searchParams.get('settings'), 'sso');
  return location.searchParams.get('ssoTest') ?? '';
}

const proofs = () => db.prepare('SELECT * FROM sso_apply_proofs ORDER BY id').all() as Array<Record<string, unknown>>;

// ---------------------------------------------------------------------------
// Test sign-in (D2 test branch)
// ---------------------------------------------------------------------------

test('test sign-in works while login is unavailable, pins only, and writes nothing privileged', async () => {
  const draft = draftRow();
  assert.equal(ssoState(), 'unavailable', 'no active row (a member link keeps the policy enforced)');
  const started = await startTest(owner.id) as Started;
  const res = await complete(started, { ...MEMBER_CLAIMS, sub: 'sub-owner-at-idp' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const id = testResultId(res);
  const result = realTestSignIn.readTestResult(id, owner.id);
  assert.equal(result.mappedRole, 'user');
  assert.equal(result.tenantOk, true);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.roleClaimValue, ['member']);
  assert.equal(realTestSignIn.readTestResult(id, owner.id), null, 'one-time');
  assert.deepEqual(proofs().map((row) => [row.kind, row.passed, row.config_hash, row.draft_version, row.owner_user_id]),
    [['sign_in', 1, draft.config_hash, 3, owner.id]], 'the proof survives reading the display row');
  assert.equal(op.discoveryFetches(), 0, 'no discovery fetch on the test path');
  assert.ok(op.requests.every((request) => request.url !== `${FIXTURE_ISSUER}/.well-known/openid-configuration`));
  assert.equal(count('completeTestSignIn'), 1);
  assertNoPrivilegedWrite('success');
});

test('test sign-in refusal (no role) records a failed proof and writes nothing privileged', async () => {
  draftRow();
  const started = await startTest(owner.id) as Started;
  const id = testResultId(await complete(started, { sub: 'x', roles: ['stranger'], org: 'org-1' }));
  const result = realTestSignIn.readTestResult(id, owner.id);
  assert.equal(result.mappedRole, null);
  assert.deepEqual(result.diagnostics, ['no_recognized_role']);
  assert.deepEqual(proofs().map((row) => row.passed), [0]);
  assertNoPrivilegedWrite('refusal');
});

test('test sign-in: OAuth error and cancel are display-only, consuming the entry first', async () => {
  draftRow();
  for (const [error, expected] of [['access_denied', 'access_denied'], ['bad value!', undefined]] as const) {
    const started = await startTest(owner.id) as Started;
    const state = new URL(started.authorizationUrl).searchParams.get('state') ?? '';
    const res = await callback({ state, error }, started.cookie);
    const result = realTestSignIn.readTestResult(testResultId(res), owner.id);
    assert.deepEqual(result.diagnostics, ['provider_denied']);
    assert.equal(result.oauthError, expected);
    const replay = await callback({ state, code: 'late' }, started.cookie);
    assert.match(replay.headers.get('location') ?? '', /invalid_state/, 'the entry was consumed on the error path');
  }
  assert.deepEqual(proofs(), [], 'no apply proof without a completed sign-in');
  assertNoPrivilegedWrite('oauth error');
});

test('test sign-in: a draft edited after start refuses sso_test_config_changed', async () => {
  const draft = draftRow();
  const started = await startTest(owner.id) as Started;
  draftRow({ extra_scopes: 'groups', draft_version: draft.draft_version + 1 });
  const result = realTestSignIn.readTestResult(testResultId(await complete(started, MEMBER_CLAIMS)), owner.id);
  assert.deepEqual(result.diagnostics, ['sso_test_config_changed']);
  assert.equal(op.requests.filter((request) => request.url.endsWith('/token')).length, 0, 'no code exchange');
  assert.deepEqual(proofs(), []);
  assertNoPrivilegedWrite('config changed');
});

test('test sign-in: start requires pins (sso_test_discovery_required) and an active owner', async () => {
  draftRow({ pinned_endpoints_json: null });
  assert.deepEqual(await startTest(owner.id), { refusal: 'sso_test_discovery_required' });
  draftRow();
  assert.deepEqual(await startTest(admin.id), { refusal: 'sso_test_owner_invalid' });
  assertNoPrivilegedWrite('start refusals');
});

test('test sign-in: RFC 9207 is evaluated against the selected draft config', async () => {
  activeRow();
  draftRow({ discovery_flags_json: JSON.stringify({ authorization_response_iss_parameter_supported: true }) });
  const missing = await complete(await startTest(owner.id) as Started, MEMBER_CLAIMS);
  assert.deepEqual(realTestSignIn.readTestResult(testResultId(missing), owner.id).diagnostics, ['iss_mismatch']);
  const ok = await complete(await startTest(owner.id) as Started, MEMBER_CLAIMS, { iss: FIXTURE_ISSUER });
  assert.deepEqual(realTestSignIn.readTestResult(testResultId(ok), owner.id).diagnostics, []);
  assertNoPrivilegedWrite('iss');
});

test('test sign-in: another browser transaction fails; another owner cannot read the result', async () => {
  draftRow();
  const started = await startTest(owner.id) as Started;
  const { code, state } = op.authorize(started.authorizationUrl, MEMBER_CLAIMS);
  const foreign = await callback({ state, code }, `${BROWSER_TRANSACTION_COOKIE}=${'Z'.repeat(43)}`);
  assert.equal(foreign.headers.get('location'), '/?settings=sso&ssoTestError=transaction_expired');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM sso_test_results').get() as { n: number }).n, 0);

  const mine = await complete(await startTest(owner.id) as Started, MEMBER_CLAIMS);
  const id = testResultId(mine);
  assert.equal(realTestSignIn.readTestResult(id, secondOwner.id), null, 'owner-bound');
  assert.notEqual(realTestSignIn.readTestResult(id, owner.id), null, 'still readable by its owner');
  assertNoPrivilegedWrite('binding');
});

test('test sign-in: an owner demoted after start is refused at the callback', async () => {
  draftRow();
  const started = await startTest(secondOwner.id) as Started;
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(secondOwner.id);
  const res = await complete(started, MEMBER_CLAIMS);
  assert.deepEqual(realTestSignIn.readTestResult(testResultId(res), secondOwner.id).diagnostics, ['sso_test_owner_invalid']);
  assertNoPrivilegedWrite('demoted owner');
});

// ---------------------------------------------------------------------------
// Login, fence, drift, client auth, owner refusal
// ---------------------------------------------------------------------------

test('a login entry signs in through the pinned endpoints and never reaches completeTestSignIn', async () => {
  activeRow();
  const res = await complete(await startLogin(), MEMBER_CLAIMS);
  assert.match(res.headers.get('location') ?? '', /^\/auth\/oidc\/return\?oidc_code=/);
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(count('completeTestSignIn'), 0);
  assert.equal(count('recordTestFailure'), 0);
  assert.equal(count('generateToken'), 1);
  assert.equal(repoSpies[0]?.mock.callCount(), 1, 'attestation stamped');
  const token = op.requests.find((request) => request.url.endsWith('/token'));
  assert.equal(token?.url, `${FIXTURE_ISSUER}/token`, 'the pinned token endpoint');
});

for (const clientAuth of ['client_secret_basic', 'client_secret_post'] as const) {
  test(`confidential client: ${clientAuth} authenticates the token request`, async () => {
    useProvider(createMockOpenIdProvider({ clientAuth, clientSecret: 'p@ss word:1' }));
    const secret = encryptSsoClientSecret('p@ss word:1', { slot: 'active', issuer: FIXTURE_ISSUER, clientId: 'nassaj-client' });
    activeRow({ client_auth: clientAuth, client_secret_enc: secret });
    const res = await complete(await startLogin(), MEMBER_CLAIMS);
    assert.match(res.headers.get('location') ?? '', /oidc_code=/);
    const token = op.requests.find((request) => request.url.endsWith('/token'));
    assert.equal(Boolean(token?.headers.authorization), clientAuth === 'client_secret_basic');
    assert.equal(token?.body.includes('client_secret='), clientAuth === 'client_secret_post');
  });
}

test('N1: start under v, apply v+1, complete → oidc_config_changed and no code', async () => {
  activeRow();
  const started = await startLogin();
  activeRow({ attestation_max_age_hours: 6 });
  const res = await complete(started, MEMBER_CLAIMS);
  assert.equal(res.headers.get('location'), '/auth/oidc/return?error=oidc_config_changed');
  assert.equal(count('oidcCodeStore.put'), 0);
  assert.equal(count('generateToken'), 0);
  assert.equal(repoSpies[0]?.mock.callCount(), 0, 'no attestation stamp');
});

test('N1: an apply between JWT mint and redirect deletes the one-time code', async () => {
  activeRow();
  const started = await startLogin();
  onGenerateToken = () => db.prepare("UPDATE sso_oidc_config SET version = version + 1 WHERE slot = 'active'").run();
  const before = codes.size;
  const res = await complete(started, MEMBER_CLAIMS);
  assert.equal(res.headers.get('location'), '/auth/oidc/return?error=oidc_config_changed');
  assert.equal(count('oidcCodeStore.put'), 1);
  assert.equal(codes.size, before, 'the stored code was discarded');
});

test('drift: a moved endpoint persists runtime_fault and SSO becomes unavailable', async (t) => {
  t.mock.method(process.stderr, 'write', () => true);
  activeRow();
  op.discoveryOverrides.token_endpoint = `${FIXTURE_ISSUER}/moved-token`;
  const res = await fetch(`${baseUrl}/api/auth/oidc/login`, { redirect: 'manual' });
  assert.equal(res.status, 502);
  const row = db.prepare("SELECT runtime_fault AS fault FROM sso_oidc_config WHERE slot = 'active'").get() as { fault: string };
  assert.equal(row.fault, 'discovery_endpoint_changed');
  assert.equal(ssoState(), 'unavailable');
  resetSsoConfigCacheForTests();
  assert.equal(ssoState(), 'unavailable', 'persisted: survives a restart');
  assert.ok(op.requests.every((request) => !request.url.endsWith('/moved-token')), 'the advertised URL is never used');
  const audit = db.prepare("SELECT metadata FROM audit_log WHERE action = 'sso_runtime_fault_recorded'").get() as
    { metadata: string } | undefined;
  assert.ok(audit, 'audited');
});

test('I6: an owner identity is refused for login and nothing is written', async () => {
  activeRow();
  userIdentitiesDb.link(owner.id, FIXTURE_ISSUER, 'sub-owner');
  for (const repoSpy of repoSpies) repoSpy.mock.resetCalls();
  const res = await complete(await startLogin(), { sub: 'sub-owner', roles: ['admin'], org: 'org-1' });
  assert.equal(res.headers.get('location'), '/auth/oidc/return?error=owner_must_sign_in_locally');
  assertNoPrivilegedWrite('owner refused');
});

// ---------------------------------------------------------------------------
// Back channel in broken states (real verification through the pinned jwks_uri)
// ---------------------------------------------------------------------------

async function logout(sub: string) {
  return fetch(`${baseUrl}/api/auth/oidc/backchannel-logout`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ logout_token: op.logoutToken(sub) }),
  });
}

for (const [label, overrides] of [
  ['persisted runtime fault', { runtime_fault: 'discovery_endpoint_changed' }],
  ['undecryptable secret', { client_auth: 'client_secret_basic', client_secret_enc: 'ssooidc:v1:AAAA:AAAA:AAAA' }],
] as const) {
  test(`back channel, broken row (${label}): verified with the pinned jwks_uri, no discovery`, async (t) => {
    t.mock.method(process.stderr, 'write', () => true);
    activeRow(overrides);
    assert.equal(ssoState(), 'unavailable');
    const before = stamp(member.id);
    const res = await logout('sub-member');
    assert.equal(res.status, 200);
    assert.notEqual(stamp(member.id), before, 'the member is revoked');
    assert.equal(op.discoveryFetches(), 0, 'never a fresh discovery');
    assert.ok(op.requests.some((request) => request.url === `${FIXTURE_ISSUER}/jwks`));
  });
}

test('back channel: an owner subject is a 200 no-op', async () => {
  activeRow();
  userIdentitiesDb.link(owner.id, FIXTURE_ISSUER, 'sub-owner');
  const before = stamp(owner.id);
  assert.equal((await logout('sub-owner')).status, 200);
  assert.equal(stamp(owner.id), before);
});

/**
 * T-1939 slice 4: just-in-time account creation on a first SSO sign-in.
 *
 * The database, the PKCE store and the one-time-code store are the REAL ones
 * (a fresh SQLite file per run), so the one-transaction write, the
 * case-insensitive username check and the sentinel hash are exercised end to
 * end. Only the IdP verifier, the token minting, the push channel and the
 * per-user directory provisioning are fakes.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test, { after, beforeEach, mock } from 'node:test';
import { pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';

import { createSsoRuntimeDouble } from '../services/__tests__/sso-runtime-double.js';
import { createSsoConfigDouble, doubleMapping } from '../services/__tests__/sso-config-double.js';

const url = (spec: string) => pathToFileURL(path.resolve(import.meta.dirname, spec)).href;
const sso = createSsoConfigDouble();
mock.module(url('../services/sso-config.service.js'), { namedExports: sso.exports });
const passThrough = (_req: unknown, _res: unknown, next: () => void) => next();
const ISSUER = 'https://issuer.example';
// Project-scoped roles claim in the nested-grant shape (fixture data, neutral name).
const ROLES_CLAIM = 'urn:example:iam:org:project:proj-synth:roles';
const ALLOWED_ORG = '300100200';
const FOREIGN_ORG = '999888777';

/** The active config's mapping: `role_grant_scope` over ROLES_CLAIM with the given scopes (D5). */
function grantScopeMapping(scopes: string[]) {
  return scopes.length === 0
    ? doubleMapping({ role_claim_path: `["${ROLES_CLAIM}"]` })
    : doubleMapping({
      role_claim_path: `["${ROLES_CLAIM}"]`, tenant_mode: 'role_grant_scope', tenant_values_json: JSON.stringify(scopes),
    });
}

const notifications: number[] = [];
const provisionedDirs: number[] = [];
const minted: Array<{ id: number; role: string }> = [];
let claims: Record<string, unknown> = {};

mock.module(url('../middleware/auth.js'), {
  namedExports: {
    authenticateToken: (req: { headers: Record<string, string | undefined>; user?: unknown },
      _res: unknown, next: () => void) => {
      req.user = { id: Number(req.headers['x-test-user-id']), role: String(req.headers['x-test-role']) };
      return next();
    },
    generateToken: (user: { id: number; role: string }) => {
      minted.push({ id: user.id, role: user.role });
      return `jwt-for-${user.id}`;
    },
    invalidateRefreshCache: () => {},
    requireRole: (...roles: string[]) => (
      req: { user?: { role?: string } },
      res: { status: (code: number) => { json: (body: unknown) => void } },
      next: () => void,
    ) => (roles.includes(req.user?.role ?? '') ? next() : res.status(403).json({ error: 'Insufficient permissions' })),
  },
});
mock.module(url('../modules/account-wallet/user-identity-revocation.js'), {
  namedExports: { revokeUserIdentity: () => ({ abortedRuns: 0, closedSockets: 0, endedInteractiveSessions: 0 }) },
});
mock.module(url('../middleware/rate-limit.js'), {
  namedExports: { createRateLimiter: () => passThrough },
});
mock.module(url('../services/notification-orchestrator.js'), {
  namedExports: {
    createNotificationEvent: (event: unknown) => event,
    notifyUserIfEnabled: ({ userId }: { userId: number }) => notifications.push(userId),
  },
});
let provisionFailure = false;
mock.module(url('../services/isolation/provision-user-dirs.js'), {
  namedExports: {
    provisionUserDirs: (userId: number) => {
      if (provisionFailure) throw new Error('synthetic provisioning failure');
      provisionedDirs.push(userId);
    },
  },
});
mock.module(url('../utils/client-ip.js'), { namedExports: { clientIp: () => '127.0.0.1' } });
mock.module(url('../services/oidc-verifier.service.js'), {
  namedExports: {
    parseExactHttpsIssuer: (issuer: string) => issuer,
    idTokenAuthTimeMs: () => null,
  },
});
// ADR-194: the routes read the SSO configuration rows, never OIDC_* env.
const ssoRuntime = createSsoRuntimeDouble(sso, {
  exchangeAuthorizationCode: async () => ({ id_token: 'id-token-synthetic' }),
  verifyIdToken: async () => claims,
  verifyLogoutToken: async () => ({ sub: 'unused' }),
});
mock.module(url('../services/sso-oidc-runtime.service.js'), { namedExports: ssoRuntime.exports });

for (const key of ['OIDC_ISSUER_URL', 'OIDC_CLIENT_ID', 'OIDC_REDIRECT_URI']) delete process.env[key];

const { initializeDatabase } = await import('../modules/database/init-db.js');
const { stopReconcileScheduler } = await import('../modules/database/project-reconcile.service.js');
const { getConnection } = await import('../modules/database/connection.js');
const { auditLogDb, userDb, userIdentitiesDb } = await import('../modules/database/index.js');
const { SSO_ONLY_PASSWORD_HASH } = await import('../services/sso-only-password.js');
const { PROVISION_CAP_PER_HOUR, resetProvisionCap } = await import('../services/oidc-jit-provision.js');
await initializeDatabase();
stopReconcileScheduler();

const { default: oidcRouter } = await import('./oidc.js');
const app = express();
app.use(express.json());
app.use('/api/auth/oidc', oidcRouter);
const server: Server = app.listen(0);
await new Promise<void>((resolve) => server.once('listening', resolve));
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function grant(role: string, orgId = ALLOWED_ORG) {
  return { [ROLES_CLAIM]: { [role]: { [orgId]: 'org.example' } } };
}

beforeEach(() => {
  const db = getConnection();
  db.exec('DELETE FROM user_identities; DELETE FROM audit_log; DELETE FROM users;');
  userDb.createUser('the_owner', 'hash-owner', 'owner');
  notifications.length = 0;
  provisionedDirs.length = 0;
  provisionFailure = false;
  minted.length = 0;
  resetProvisionCap();
  claims = { sub: 'subject-new', preferred_username: 'Sara.Ali@idp.example', ...grant('member') };
  sso.setActive(true);
  sso.state.jitEnabled = true;
  sso.state.mapping = grantScopeMapping([ALLOWED_ORG, 'another-org']);
});

async function signIn(): Promise<Response> {
  const login = await fetch(`${baseUrl}/api/auth/oidc/login`, { redirect: 'manual' });
  assert.equal(login.status, 302);
  const state = new URL(login.headers.get('location') ?? '').searchParams.get('state') ?? '';
  const cookie = (login.headers.get('set-cookie') ?? '').split(';', 1)[0] ?? '';
  return fetch(`${baseUrl}/api/auth/oidc/callback?state=${encodeURIComponent(state)}&code=provider-code`, {
    headers: { cookie },
    redirect: 'manual',
  });
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const auditRows = () => auditLogDb.recent(1000).map((row) => ({
  action: row.action, userId: row.user_id, metadata: row.metadata ? JSON.parse(row.metadata) : null,
}));
const auditActions = () => auditRows().map((row) => row.action);
const userCount = () => (getConnection().prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
const refusalReasons = () => auditRows()
  .filter((row) => row.action === 'oidc_provision_refused')
  .map((row) => row.metadata.reason);

function assertRefused(res: Response, error: string) {
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), `/auth/oidc/return?error=${error}`);
  assert.equal(userCount(), 1, 'only the owner exists: nothing was created');
  assert.equal(userIdentitiesDb.findByIssuerAndSubject(ISSUER, 'subject-new'), undefined);
  assert.deepEqual(minted, []);
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

test('JIT off (default): an unknown subject is redirected with oidc_not_linked', async () => {
  sso.state.jitEnabled = false;
  assertRefused(await signIn(), 'oidc_not_linked');
  assert.ok(!auditActions().includes('oidc_provision_refused'), 'JIT off is not a provisioning event');
});

test('JIT on without a tenant restriction refuses every sign-in (fail-closed)', async () => {
  sso.state.mapping = grantScopeMapping([]);
  assertRefused(await signIn(), 'oidc_not_linked');
  sso.state.mapping = null;
  assertRefused(await signIn(), 'oidc_not_linked');
  assert.deepEqual(refusalReasons(), Array(2).fill('tenant_restriction_missing'));
});

test('a role granted only by a foreign organization is refused', async () => {
  claims = { ...claims, ...grant('admin', FOREIGN_ORG) };
  assertRefused(await signIn(), 'oidc_not_authorized');
  assert.deepEqual(refusalReasons(), ['tenant_not_allowed']);
});

test('a bare role list (no granting organization) is refused', async () => {
  claims = { ...claims, [ROLES_CLAIM]: ['member'] };
  assertRefused(await signIn(), 'oidc_not_authorized');
  assert.deepEqual(refusalReasons(), ['tenant_not_allowed']);
});

test('no roles claim, or only unknown roles, is refused', async () => {
  const { [ROLES_CLAIM]: _dropped, ...withoutRoles } = claims;
  claims = withoutRoles;
  assertRefused(await signIn(), 'oidc_not_authorized');
  claims = { ...withoutRoles, ...grant('superuser') };
  assertRefused(await signIn(), 'oidc_not_authorized');
  claims = { ...withoutRoles, ...grant('owner') };
  assertRefused(await signIn(), 'oidc_not_authorized');
  assert.deepEqual(refusalReasons(), ['no_role', 'no_role', 'no_role']);
});

test('SSO login unavailable refuses the callback (sso_unavailable) and creates nobody', async () => {
  const login = await fetch(`${baseUrl}/api/auth/oidc/login`, { redirect: 'manual' });
  const state = new URL(login.headers.get('location') ?? '').searchParams.get('state') ?? '';
  const cookie = (login.headers.get('set-cookie') ?? '').split(';', 1)[0] ?? '';
  sso.state.loginAvailable = false;
  const res = await fetch(`${baseUrl}/api/auth/oidc/callback?state=${encodeURIComponent(state)}&code=y`, {
    headers: { cookie }, redirect: 'manual',
  });
  assert.equal(res.headers.get('location'), '/auth/oidc/return?error=sso_unavailable');
  assert.equal(userCount(), 1);
});

test('ADR-194 D9: an apply landing before the JIT write creates nobody', async () => {
  ssoRuntime.runtime.fenceVersion = 8;
  try {
    const res = await signIn();
    assert.equal(res.headers.get('location'), '/auth/oidc/return?error=oidc_config_changed');
    assert.equal(userCount(), 1);
    assert.deepEqual(minted, []);
  } finally {
    ssoRuntime.runtime.fenceVersion = null;
  }
});

// ---------------------------------------------------------------------------
// Success
// ---------------------------------------------------------------------------

test('success creates user + link + stamp in one write, audits ids/role, alerts the owner', async () => {
  const before = Date.now();
  const res = await signIn();
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location') ?? '', /^\/auth\/oidc\/return\?oidc_code=/);
  await settle();

  const raw = getConnection().prepare('SELECT * FROM users WHERE username = ?').get('sara_ali') as
    { id: number; role: string; password_hash: string; status: string; invited_by: number | null };
  assert.ok(raw, 'username derived from preferred_username');
  assert.equal(raw.role, 'user', 'member maps to user');
  assert.equal(raw.password_hash, SSO_ONLY_PASSWORD_HASH);
  assert.equal(raw.status, 'active');
  const link = userIdentitiesDb.findByIssuerAndSubject(ISSUER, 'subject-new');
  assert.equal(link?.user_id, raw.id);
  assert.ok((link?.last_attested_at ?? 0) >= before, 'attestation stamped with the link');
  assert.deepEqual(minted, [{ id: raw.id, role: 'user' }]);
  assert.deepEqual(provisionedDirs, [raw.id]);

  const provisioned = auditRows().find((row) => row.action === 'oidc_user_provisioned');
  assert.deepEqual(provisioned, {
    action: 'oidc_user_provisioned', userId: raw.id,
    metadata: { provider: 'oidc', identityId: link?.id, role: 'user' },
  });
  const alert = auditRows().find((row) => row.action === 'oidc_owner_alerted');
  assert.deepEqual(alert?.metadata, { provider: 'oidc', kind: 'user_provisioned', ownerCount: 1 });
  const ownerId = userDb.listActiveOwnerIds()[0];
  assert.deepEqual(notifications, [ownerId]);
  const serialized = JSON.stringify(auditRows());
  assert.ok(!serialized.includes('subject-new') && !serialized.includes('sara'), 'no subject or username audited');
});

test('the mapped role is applied and never owner, even when the IdP attests owner', async () => {
  claims = { ...claims, [ROLES_CLAIM]: {
    owner: { [ALLOWED_ORG]: 'org.example' },
    admin: { [ALLOWED_ORG]: 'org.example' },
  } };
  assert.equal((await signIn()).status, 302);
  assert.deepEqual(minted.map((entry) => entry.role), ['admin']);
});

test('only roles granted by an allowed organization count toward the mapped role', async () => {
  claims = { ...claims, [ROLES_CLAIM]: {
    admin: { [FOREIGN_ORG]: 'foreign.example' },
    viewer: { [ALLOWED_ORG]: 'org.example' },
  } };
  assert.equal((await signIn()).status, 302);
  assert.deepEqual(minted.map((entry) => entry.role), ['user'], 'the foreign admin grant is ignored');
});

test('a second sign-in of the same subject logs in, never provisions again', async () => {
  assert.equal((await signIn()).status, 302);
  assert.equal((await signIn()).status, 302);
  assert.equal(userCount(), 2);
  assert.equal(auditActions().filter((action) => action === 'oidc_user_provisioned').length, 1);
});

test('an existing linked user is unaffected by JIT', async () => {
  const member = userDb.createUser('linked_member', 'hash-m', 'user');
  userIdentitiesDb.link(member.id, ISSUER, 'subject-new');
  assert.equal((await signIn()).status, 302);
  assert.deepEqual(minted, [{ id: member.id, role: 'user' }]);
  assert.equal(userCount(), 2);
  assert.ok(!auditActions().includes('oidc_user_provisioned'));
});

// ---------------------------------------------------------------------------
// Tenant restriction on every later sign-in (qa veto on slice 4)
// ---------------------------------------------------------------------------

const deniedReasons = () => auditRows()
  .filter((row) => row.action === 'oidc_access_denied_no_role')
  .map((row) => row.metadata.reason);

test('a JIT user keeps the allowed-org role when a foreign admin grant appears later', async () => {
  claims = { ...claims, ...grant('viewer') };
  assert.equal((await signIn()).status, 302);
  claims = { ...claims, [ROLES_CLAIM]: {
    viewer: { [ALLOWED_ORG]: 'org.example' },
    admin: { [FOREIGN_ORG]: 'foreign.example' },
  } };
  assert.equal((await signIn()).status, 302);
  assert.deepEqual(minted.map((entry) => entry.role), ['user', 'user']);
  assert.equal(userDb.getUserByUsername('sara_ali')?.role, 'user');
});

test('a later sign-in carrying only a foreign grant is refused and audited', async () => {
  assert.equal((await signIn()).status, 302);
  claims = { ...claims, ...grant('admin', FOREIGN_ORG) };
  const res = await signIn();
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/auth/oidc/return?error=oidc_not_authorized');
  assert.equal(minted.length, 1, 'no credential for the refused sign-in');
  assert.deepEqual(deniedReasons(), ['tenant_not_allowed']);
  assert.equal(userDb.getUserByUsername('sara_ali')?.role, 'user');
});

test('tenant mode none leaves linked-member sign-in unfiltered (unchanged)', async () => {
  const member = userDb.createUser('linked_member', 'hash-m', 'user');
  userIdentitiesDb.link(member.id, ISSUER, 'subject-new');
  sso.state.mapping = grantScopeMapping([]);
  claims = { ...claims, ...grant('admin', FOREIGN_ORG) };
  assert.equal((await signIn()).status, 302);
  assert.deepEqual(minted, [{ id: member.id, role: 'admin' }]);
});

// ---------------------------------------------------------------------------
// Username collisions (qa M4)
// ---------------------------------------------------------------------------

test('a case-insensitive username clash is refused with oidc_account_exists, nothing created', async () => {
  const existing = userDb.createUser('Sara_Ali', 'hash-x', 'user');
  userDb.setStatus(existing.id, 'disabled');
  const res = await signIn();
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/auth/oidc/return?error=oidc_account_exists');
  assert.equal(userCount(), 2);
  assert.equal(userIdentitiesDb.findByIssuerAndSubject(ISSUER, 'subject-new'), undefined);
  assert.equal(userIdentitiesDb.hasAnyLink(existing.id), false, 'never linked to the existing account');
  assert.deepEqual(refusalReasons(), ['username_taken']);
});

test('reserved usernames are refused with oidc_account_exists', async () => {
  for (const name of ['admin@idp.example', 'ROOT', 'Support', 'nassaj', 'api', 'system', 'owner',
    'Administrator', 'superuser', 'guest', 'user', 'null', 'undefined']) {
    claims = { ...claims, preferred_username: name };
    assertRefused(await signIn(), 'oidc_account_exists');
  }
});

test('a failed directory provisioning keeps the account and audits user_dirs_provision_failed', async () => {
  provisionFailure = true;
  assert.equal((await signIn()).status, 302);
  await settle();
  const user = userDb.getUserByUsername('sara_ali');
  assert.ok(user, 'the account survives');
  const row = auditRows().find((entry) => entry.action === 'user_dirs_provision_failed');
  assert.deepEqual(row, { action: 'user_dirs_provision_failed', userId: user.id, metadata: { stage: 'oidc_jit' } });
});

test('no linking by e-mail: an account whose invite e-mail matches is never reached', async () => {
  const other = userDb.createUser('someone_else', 'hash-y', 'user');
  claims = { ...claims, email: 'someone_else@idp.example', preferred_username: 'fresh.name' };
  assert.equal((await signIn()).status, 302);
  assert.equal(userIdentitiesDb.hasAnyLink(other.id), false);
  assert.ok(userDb.getUserByUsername('fresh_name'));
});

// ---------------------------------------------------------------------------
// Process-wide cap
// ---------------------------------------------------------------------------

test(`the ${PROVISION_CAP_PER_HOUR + 1}st provision in an hour is refused (rate_limited) and audited`, async () => {
  for (let index = 0; index < PROVISION_CAP_PER_HOUR; index += 1) {
    claims = { ...claims, sub: `subject-${index}`, preferred_username: `member${index}` };
    assert.equal((await signIn()).status, 302, `provision ${index + 1}`);
  }
  claims = { ...claims, sub: 'subject-over', preferred_username: 'one_too_many' };
  const res = await signIn();
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/auth/oidc/return?error=rate_limited');
  assert.equal(userCount(), PROVISION_CAP_PER_HOUR + 1);
  assert.ok(auditActions().includes('oidc_provision_capped'));
});

// ---------------------------------------------------------------------------
// Unlinking a JIT account
// ---------------------------------------------------------------------------

test('owner unlinking a JIT account succeeds with a clear note and an audit flag', async () => {
  assert.equal((await signIn()).status, 302);
  const jitUser = userDb.getUserByUsername('sara_ali');
  const ownerId = userDb.listActiveOwnerIds()[0];
  const res = await fetch(`${baseUrl}/api/auth/oidc/link/${jitUser?.id}`, {
    method: 'DELETE',
    headers: { 'x-test-user-id': String(ownerId), 'x-test-role': 'owner' },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.note, 'sso_only_account_cannot_sign_in');
  assert.equal(userIdentitiesDb.hasAnyLink(jitUser!.id), false);
  const audit = auditRows().find((row) => row.action === 'oidc_identity_unlinked');
  assert.deepEqual(audit?.metadata, { targetUserId: jitUser?.id, ssoOnlyAccount: true });
});

test('owner unlinking an ordinary member carries no note', async () => {
  const member = userDb.createUser('plain_member', 'hash-p', 'user');
  userIdentitiesDb.link(member.id, ISSUER, 'subject-plain');
  const ownerId = userDb.listActiveOwnerIds()[0];
  const res = await fetch(`${baseUrl}/api/auth/oidc/link/${member.id}`, {
    method: 'DELETE',
    headers: { 'x-test-user-id': String(ownerId), 'x-test-role': 'owner' },
  });
  assert.deepEqual(await res.json(), { message: 'Unlinked' });
});

test('an SSO-only account can never self-unlink', async () => {
  assert.equal((await signIn()).status, 302);
  const jitUser = userDb.getUserByUsername('sara_ali');
  // Even if promoted to owner later, the sentinel account has no credential.
  getConnection().prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(jitUser!.id);
  const res = await fetch(`${baseUrl}/api/auth/oidc/link/self`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json', 'x-test-user-id': String(jitUser?.id), 'x-test-role': 'owner' },
    body: JSON.stringify({ currentPassword: 'anything' }),
  });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'sso_only_account');
  assert.equal(userIdentitiesDb.hasAnyLink(jitUser!.id), true);
});

/**
 * ADR-194 D1 state matrix (C1) through the REAL credential entry points, with
 * the real state model and a real database: password login, passkey login (a
 * software authenticator signing genuine assertions), wallet add, invite
 * create and accept, the JWT REST verifier, the WebSocket verifier and the API
 * key resolver, plus the owner column, in every matrix state.
 *
 * The predicate-level matrix lives in services/sso-config.service.test.ts and
 * the back-channel column in routes/oidc.backchannel-state.test.ts; the route
 * tests of T-1939 use a predicate double. Here nothing about SSO is faked.
 * Mocked boundaries only: rate limiters (pass-through), the step-up quota,
 * live revocation, notifications and the client IP.
 *
 * API keys (ADR-194 D6, S8 decision Q1): the T-1946 window never depends on
 * SSO being on, and while the policy is enforced but login is unavailable
 * (unavailable, paused, read failure) linked non-owners' keys are refused
 * outright (sso_attestation_expired). Owner-disabled and FORCE_OFF fall back to
 * the plain window. The owner's key is never governed.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import test, { after, before, mock } from 'node:test';
import { pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';

import { useWalletOriginEnv } from '../utils/__tests__/wallet-origin-env.js';

const url = (spec: string) => pathToFileURL(path.resolve(import.meta.dirname, spec)).href;
const passThrough = (_req: unknown, _res: unknown, next: () => void) => next();

process.env.NASSAJ_PROVIDER_SECRETS_KEY = crypto.randomBytes(32).toString('base64');
process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
process.env.MULTI_ACCOUNT_SWITCHING = 'true';
for (const key of Object.keys(process.env)) if (key.startsWith('OIDC_')) delete process.env[key];
delete process.env.NASSAJ_SSO_FORCE_OFF;

mock.module(url('../middleware/rate-limit.js'), { namedExports: { createRateLimiter: () => passThrough } });
mock.module(url('../services/step-up-quota.js'), {
  namedExports: { consumeStepUpAttempt: () => ({ allowed: true, retryAfterSeconds: 0 }), refundStepUpAttempt: () => {} },
});
mock.module(url('../modules/account-wallet/user-identity-revocation.js'), {
  namedExports: { revokeUserIdentity: () => ({ abortedRuns: 0, closedSockets: 0, endedInteractiveSessions: 0 }) },
});
mock.module(url('../services/notification-orchestrator.js'), {
  namedExports: { createNotificationEvent: (event: unknown) => event, notifyUserIfEnabled: () => {} },
});
mock.module(url('../utils/client-ip.js'), { namedExports: { clientIp: () => '127.0.0.1' } });
mock.module(url('./oidc.js'), { defaultExport: express.Router() });

const { initializeDatabase } = await import('../modules/database/init-db.js');
const { stopReconcileScheduler } = await import('../modules/database/project-reconcile.service.js');
const { getConnection } = await import('../modules/database/connection.js');
const { apiKeysDb, deviceAccountSessionsDb, userDb, userIdentitiesDb } = await import('../modules/database/index.js');
const { writeDisabledRecordOn } = await import('../modules/database/repositories/sso-oidc-config.js');
const { encryptSsoClientSecret } = await import('../modules/database/sso-secret-envelope.js');
const { hashPassword } = await import('../services/password.service.js');
const { createInvite } = await import('../services/invite.service.js');
const { createRegistrationOptions, verifyRegistration } = await import('../services/webauthn.service.js');
const { createSoftAuthenticator } = await import('../services/webauthn-soft-authenticator.fixture.js');
const { resetSsoConfigCacheForTests, ssoState } = await import('../services/sso-config.service.js');
const { applySsoBootPolicy } = await import('../services/sso-lifecycle.service.js');
const { clearSsoConfig, writeSsoRow, FIXTURE_ISSUER, FIXTURE_CLIENT_ID } = await import('../services/__tests__/sso-config-fixture.js');
await initializeDatabase();
stopReconcileScheduler();

const { default: authRouter } = await import('./auth.js');
const { default: webauthnRouter } = await import('./webauthn.js');
const { authenticateToken, authenticateWebSocket, generateToken } = await import('../middleware/auth.js');

const app = express();
app.use(express.json());
app.use('/api/auth', authRouter);
app.use('/api/webauthn', webauthnRouter);
app.get('/probe', authenticateToken, (req, res) => res.json({ id: (req as { user: { id: number } }).user.id }));
const server: Server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const { origin, restore: restoreOriginEnv } = useWalletOriginEnv((server.address() as AddressInfo).port);
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  restoreOriginEnv();
});

const db = getConnection();
const PASSWORD = 'correct horse battery matrix';
type User = { id: number; username: string; role: string };
let owner: User;
let member: User;
let ownerPasskey: ReturnType<typeof createSoftAuthenticator>;
let memberPasskey: ReturnType<typeof createSoftAuthenticator>;
let memberApiKey = '';
let ownerApiKey = '';
let sequence = 0;

async function enroll(user: User) {
  const authenticator = createSoftAuthenticator();
  const options = await createRegistrationOptions(user);
  await verifyRegistration(user, authenticator.register(options.challenge));
  return authenticator;
}

before(async () => {
  const hash = await hashPassword(PASSWORD);
  owner = userDb.createUser('matrix_owner', hash, 'owner') as User;
  member = userDb.createUser('matrix_member@example.test', hash, 'admin') as User;
  ownerPasskey = await enroll(owner);
  memberPasskey = await enroll(member);
  memberApiKey = String(apiKeysDb.createApiKey(member.id, 'matrix-key').apiKey);
  ownerApiKey = String(apiKeysDb.createApiKey(owner.id, 'matrix-owner-key').apiKey);
});

const post = (route: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${origin}${route}`, {
  method: 'POST', headers: { 'content-type': 'application/json', origin, ...headers }, body: JSON.stringify(body),
});
const codeOf = async (res: Response) => ((await res.json().catch(() => ({}))) as { code?: string }).code;

async function passwordLogin(user: User) {
  const res = await post('/api/auth/login', { username: user.username, password: PASSWORD });
  return { status: res.status, code: await codeOf(res) };
}

async function passkeyLogin(authenticator: ReturnType<typeof createSoftAuthenticator>) {
  const options = await (await post('/api/webauthn/login/options', {})).json() as { challenge: string };
  const res = await post('/api/webauthn/login/verify', { response: authenticator.assert(options.challenge) });
  return { status: res.status, code: await codeOf(res) };
}

/** The owner's device wallet adds the member with the member's password. */
async function walletAdd() {
  const device = deviceAccountSessionsDb.create(owner.id, 60_000);
  const cookie = `__Host-nassaj_device=${device.secret}`;
  const csrf = await (await fetch(`${origin}/api/auth/accounts/csrf?action=add`, { headers: { cookie, origin } }))
    .json() as { csrfToken: string };
  const res = await post('/api/auth/accounts/add', { email: member.username, password: PASSWORD, expectedGeneration: 1 },
    { cookie, 'x-csrf-token': csrf.csrfToken });
  return { status: res.status, code: await codeOf(res) };
}

async function invites() {
  const created = await post('/api/auth/invites', { role: 'user' }, { authorization: `Bearer ${tokenFor(owner)}` });
  const { token } = await createInvite(owner, { role: 'user' });
  sequence += 1;
  const accepted = await post('/api/auth/invite/accept', { token, username: `matrix_invitee_${sequence}`, password: PASSWORD });
  return { create: created.status, accept: accepted.status, acceptCode: await codeOf(accepted) };
}

/** A JWT minted from the current row (generation and password stamp as a real login would). */
const tokenFor = (user: User) => generateToken(userDb.getUserById(user.id));

async function jwtProbe(user: User) {
  const res = await fetch(`${origin}/probe`, { headers: { authorization: `Bearer ${tokenFor(user)}` } });
  return { status: res.status, code: await codeOf(res) };
}

function linkMember() {
  const id = userIdentitiesDb.link(member.id, FIXTURE_ISSUER, `sub-${crypto.randomUUID()}`);
  userIdentitiesDb.markAttested(id, member.id, Date.now());
}

function resetState() {
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'sso_oidc_config'").get()) {
    db.exec('ALTER TABLE sso_oidc_config_hidden RENAME TO sso_oidc_config');
  }
  clearSsoConfig(db);
  db.exec('DELETE FROM user_identities');
  for (const key of Object.keys(process.env)) if (key.startsWith('OIDC_')) delete process.env[key];
  delete process.env.NASSAJ_SSO_FORCE_OFF;
  resetSsoConfigCacheForTests();
}

type Row = { label: string; setup: () => void; state: string; governed: boolean; closed: boolean; stale: boolean };

const ROWS: Row[] = [
  { label: 'fresh install (no link)', setup: () => {}, state: 'off', governed: false, closed: false, stale: false },
  { label: 'no row, no env, non-owner link', setup: linkMember, state: 'unavailable', governed: true, closed: true, stale: true },
  { label: 'active, valid, enabled', setup: () => { linkMember(); writeSsoRow(db); },
    state: 'active', governed: true, closed: true, stale: false },
  { label: 'broken row (pins missing)', setup: () => { linkMember(); writeSsoRow(db, { pinned_endpoints_json: null }); },
    state: 'unavailable', governed: true, closed: true, stale: true },
  { label: 'broken row (persisted runtime_fault)', setup: () => {
    linkMember(); writeSsoRow(db, { runtime_fault: 'discovery_endpoint_changed' });
  }, state: 'unavailable', governed: true, closed: true, stale: true },
  { label: 'secret decrypt failure (draft AAD on active)', setup: () => {
    linkMember();
    const cipher = encryptSsoClientSecret('s3cret', { slot: 'draft', issuer: FIXTURE_ISSUER, clientId: FIXTURE_CLIENT_ID });
    writeSsoRow(db, { client_auth: 'client_secret_basic', client_secret_enc: cipher });
  }, state: 'unavailable', governed: true, closed: true, stale: true },
  { label: 'unreadable config table', setup: () => {
    linkMember(); writeSsoRow(db); db.exec('ALTER TABLE sso_oidc_config RENAME TO sso_oidc_config_hidden');
  }, state: 'unavailable', governed: true, closed: true, stale: true },
  { label: 'legacy env (OIDC_ENABLED=true, no row)', setup: () => { linkMember(); process.env.OIDC_ENABLED = 'true'; },
    state: 'paused', governed: true, closed: true, stale: true },
  { label: 'owner disabled (sso.disabled present)', setup: () => {
    linkMember(); writeSsoRow(db, { enabled: 0 }); writeDisabledRecordOn(db, 'owner', Date.now());
  }, state: 'off', governed: false, closed: false, stale: false },
  { label: 'FORCE_OFF (after its boot transition)', setup: () => {
    linkMember(); writeSsoRow(db); process.env.NASSAJ_SSO_FORCE_OFF = '1';
    applySsoBootPolicy({ afterCommit: () => {} });
  },
    state: 'off', governed: false, closed: false, stale: false },
];

for (const row of ROWS) {
  test(`C1 matrix through the real entry points: ${row.label}`, async () => {
    resetState();
    try {
      row.setup();
      assert.equal(ssoState(), row.state, 'state');
      const refused = { status: 403, code: 'sso_required' };

      const password = await passwordLogin(member);
      const passkey = await passkeyLogin(memberPasskey);
      const wallet = await walletAdd();
      if (row.governed) {
        assert.deepEqual(password, refused, 'member password');
        assert.deepEqual(passkey, refused, 'member passkey');
        assert.deepEqual(wallet, refused, 'wallet add of the member');
      } else {
        assert.equal(password.status, 200, 'member password allowed');
        assert.equal(passkey.status, 200, 'member passkey allowed');
        assert.equal(wallet.status, 201, 'wallet add allowed');
      }

      const invite = await invites();
      if (row.closed) {
        assert.equal(invite.create, 403, 'invite create closed');
        assert.equal(invite.accept, 403, 'invite accept closed');
        assert.equal(invite.acceptCode, 'sso_required_for_new_accounts');
      } else {
        assert.equal(invite.create, 201, 'invite create open');
        assert.equal(invite.accept, 200, 'invite accept open');
      }

      const jwt = await jwtProbe(member);
      assert.equal(jwt.status, row.stale ? 401 : 200, 'member JWT attestation');
      if (row.stale) assert.equal(jwt.code, 'sso_reauth_required');
      assert.equal(authenticateWebSocket(tokenFor(member)) === null, row.stale, 'member WebSocket attestation');
      const memberKey = apiKeysDb.resolveApiKey(memberApiKey) as { ok: boolean; reason?: string };
      if (row.stale) {
        assert.deepEqual([memberKey.ok, memberKey.reason], [false, 'sso_attestation_expired'],
          'API key refused while SSO is enforced but unavailable (D6), though attested just now');
      } else {
        assert.equal(memberKey.ok, true, 'API key: plain T-1946 window (attested just now)');
      }
      assert.equal(apiKeysDb.resolveApiKey(ownerApiKey).ok, true, 'owner API key never governed');

      assert.equal((await passwordLogin(owner)).status, 200, 'owner password never SSO-gated');
      assert.equal((await passkeyLogin(ownerPasskey)).status, 200, 'owner passkey never SSO-gated');
      assert.equal((await jwtProbe(owner)).status, 200, 'owner JWT never governed');
      assert.notEqual(authenticateWebSocket(tokenFor(owner)), null, 'owner WebSocket never governed');
    } finally {
      resetState();
    }
  });
}

test('C1: a never-attested linked member\'s API key is refused in every enforced state (T-1946)', () => {
  resetState();
  try {
    userIdentitiesDb.link(member.id, FIXTURE_ISSUER, 'sub-never-attested');
    writeSsoRow(db);
    assert.equal(apiKeysDb.resolveApiKey(memberApiKey).ok, false);
    assert.equal((apiKeysDb.resolveApiKey(memberApiKey) as { reason?: string }).reason, 'sso_attestation_expired');
  } finally {
    resetState();
  }
});

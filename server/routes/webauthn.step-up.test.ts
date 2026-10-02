/**
 * B-1407 route contract (T-1939 slice 6A): a bare JWT can no longer enroll a
 * passkey, and passkey login mints a connector owner session only for a
 * step-up-eligible passkey used with user verification. Real database, real
 * services, real signatures (software authenticator); only the JWT middleware
 * and the connector session writer are replaced.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, mock, test } from 'node:test';
import { pathToFileURL } from 'node:url';

import express from 'express';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { userIdentitiesDb } from '@/modules/database/repositories/user-identities.js';
import { userDb } from '@/modules/database/repositories/users.js';

import { hashPassword } from '../services/password.service.js';
import { createSoftAuthenticator } from '../services/webauthn-soft-authenticator.fixture.js';

const url = (spec: string) => pathToFileURL(path.resolve(import.meta.dirname, spec)).href;
const connectorRecords: Array<{ userId: number; method: string }> = [];

mock.module(url('../middleware/auth.js'), {
  namedExports: {
    authenticateToken: (req: express.Request & { user?: unknown }, res: express.Response,
      next: () => void) => {
      const user = userDb.getUserById(Number(req.headers['x-test-user']));
      if (!user) return res.status(401).json({ error: 'Access denied' });
      req.user = user;
      return next();
    },
    generateToken: () => 'passkey-jwt',
  },
});
mock.module(url('../modules/connectors/connector-owner-auth-session.js'), {
  namedExports: {
    recordConnectorOwnerAuthentication: (_res: unknown, userId: number, method: string) => {
      connectorRecords.push({ userId, method });
    },
  },
});

const { default: router } = await import('./webauthn.js');

const PASSWORD = 'correct horse battery';
let tempDirectory = '';
let previousDatabasePath: string | undefined;
let passwordHash = '';
let userSeq = 0;
let server: ReturnType<express.Express['listen']>;
let base = '';

before(async () => {
  previousDatabasePath = process.env.DATABASE_PATH;
  tempDirectory = await mkdtemp(path.join(tmpdir(), 'webauthn-step-up-route-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'db.sqlite');
  await initializeDatabase();
  passwordHash = await hashPassword(PASSWORD);
  const app = express();
  app.use(express.json());
  app.use('/webauthn', router);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  base = `http://127.0.0.1:${address.port}/webauthn`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeConnection();
  if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = previousDatabasePath;
  await rm(tempDirectory, { recursive: true, force: true });
});

const newUser = (role: 'owner' | 'user' = 'user') => {
  userSeq += 1;
  return userDb.createUser(`route_${userSeq}`, passwordHash, role);
};

async function post(route: string, body: unknown, userId?: number) {
  const response = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(userId ? { 'x-test-user': String(userId) } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });
  return { status: response.status, body: await response.json() };
}

const denials = (userId: number) => getConnection()
  .prepare("SELECT metadata FROM audit_log WHERE action = 'passkey_registration_denied' AND user_id = ?")
  .all(userId)
  .map((row) => JSON.parse((row as { metadata: string }).metadata));

/** Password step-up → registration options → hardened registration. */
async function enrollWithPassword(userId: number) {
  const options = await post('/register/options', { stepUp: { method: 'password', password: PASSWORD } }, userId);
  assert.equal(options.status, 200);
  const authenticator = createSoftAuthenticator();
  const verify = await post('/register/verify', { response: authenticator.register(options.body.challenge) }, userId);
  assert.equal(verify.status, 201);
  return { authenticator, credential: verify.body.credential, options: options.body };
}

async function withOidc(run: () => Promise<void>) {
  const saved = process.env.OIDC_ENABLED;
  process.env.OIDC_ENABLED = 'true';
  try { await run(); } finally {
    if (saved === undefined) delete process.env.OIDC_ENABLED;
    else process.env.OIDC_ENABLED = saved;
  }
}

test('JWT-only register/options → 403 step_up_required, audited without evidence', async () => {
  const user = newUser();
  const { status, body } = await post('/register/options', {}, user.id);
  assert.equal(status, 403);
  assert.equal(body.code, 'step_up_required');
  assert.equal(body.challenge, undefined);
  assert.deepEqual(denials(user.id), [{ method: 'none', code: 'step_up_required' }]);
});

test('wrong password → 401 with a non-session code; the password never reaches the audit', async () => {
  const user = newUser();
  const { status, body } = await post('/register/options',
    { stepUp: { method: 'password', password: 'not-the-password' } }, user.id);
  assert.equal(status, 401);
  assert.equal(body.code, 'step_up_failed');
  const rows = denials(user.id);
  assert.deepEqual(rows, [{ method: 'password', code: 'step_up_failed' }]);
  assert.ok(!JSON.stringify(rows).includes('not-the-password'));
});

test('correct password → UV-required options; registration stores an eligible passkey', async () => {
  const user = newUser();
  const { options, credential } = await enrollWithPassword(user.id);
  assert.equal(options.authenticatorSelection.userVerification, 'required');
  assert.equal(credential.step_up_eligible, 1);
});

test('an eligible passkey step-up authorizes another registration; audience is validated', async () => {
  const user = newUser();
  const { authenticator } = await enrollWithPassword(user.id);
  assert.equal((await post('/step-up/options', { audience: 'root' }, user.id)).status, 400);

  const stepUp = await post('/step-up/options', { audience: 'passkey_registration' }, user.id);
  assert.equal(stepUp.status, 200);
  assert.deepEqual(stepUp.body.allowCredentials.map((entry: { id: string }) => entry.id), [authenticator.id]);
  const options = await post('/register/options', {
    stepUp: { method: 'passkey', response: authenticator.assert(stepUp.body.challenge) },
  }, user.id);
  assert.equal(options.status, 200);
  assert.ok(options.body.challenge);
});

test('step-up/options without an eligible passkey → 409 no_eligible_passkey', async () => {
  const user = newUser();
  const { status, body } = await post('/step-up/options', { audience: 'passkey_registration' }, user.id);
  assert.equal(status, 409);
  assert.equal(body.code, 'no_eligible_passkey');
});

test('passkey login: legacy passkey signs in without a connector session; eligible+UV mints one', async () => {
  const user = newUser('owner');
  const { authenticator } = await enrollWithPassword(user.id);

  connectorRecords.length = 0;
  const eligible = await post('/login/options', {});
  const hardened = await post('/login/verify', { response: authenticator.assert(eligible.body.challenge) });
  assert.equal(hardened.status, 200);
  assert.deepEqual(connectorRecords, [{ userId: user.id, method: 'webauthn' }]);

  connectorRecords.length = 0;
  const noUv = await post('/login/options', {});
  const withoutUv = await post('/login/verify', {
    response: authenticator.assert(noUv.body.challenge, { uv: false }),
  });
  assert.equal(withoutUv.status, 200);
  assert.deepEqual(connectorRecords, [], 'no UV → no connector session');

  getConnection().prepare('UPDATE webauthn_credentials SET step_up_eligible = 0 WHERE id = ?')
    .run(authenticator.id);
  const legacyOptions = await post('/login/options', {});
  const legacy = await post('/login/verify', { response: authenticator.assert(legacyOptions.body.challenge) });
  assert.equal(legacy.status, 200);
  assert.equal(legacy.body.token, 'passkey-jwt');
  assert.deepEqual(connectorRecords, [], 'legacy passkey → no connector session');
});

test('SSO-linked member: register/options and step-up/options answer sso_step_up_required', async () => {
  const member = newUser('user');
  const owner = newUser('owner');
  userIdentitiesDb.link(member.id, 'https://idp.example', `sub-${member.id}`);
  userIdentitiesDb.link(owner.id, 'https://idp.example', `sub-${owner.id}`);
  await withOidc(async () => {
    const register = await post('/register/options',
      { stepUp: { method: 'password', password: PASSWORD } }, member.id);
    assert.equal(register.status, 403);
    assert.equal(register.body.code, 'sso_step_up_required');
    const stepUp = await post('/step-up/options', { audience: 'passkey_registration' }, member.id);
    assert.equal(stepUp.status, 403);
    assert.equal(stepUp.body.code, 'sso_step_up_required');
    // The linked owner stays local (break-glass).
    const ownerOptions = await post('/register/options',
      { stepUp: { method: 'password', password: PASSWORD } }, owner.id);
    assert.equal(ownerOptions.status, 200);
  });
});

test('a passkey step-up response is single-use: replay to register/options → 401', async () => {
  const user = newUser();
  const { authenticator } = await enrollWithPassword(user.id);
  const stepUp = await post('/step-up/options', { audience: 'passkey_registration' }, user.id);
  const evidence = { method: 'passkey', response: authenticator.assert(stepUp.body.challenge) };

  assert.equal((await post('/register/options', { stepUp: evidence }, user.id)).status, 200);
  const replay = await post('/register/options', { stepUp: evidence }, user.id);
  assert.equal(replay.status, 401);
  assert.equal(replay.body.code, 'step_up_failed');
  assert.equal(replay.body.challenge, undefined);
});

test('a captured step-up response replayed to login/verify is rejected', async () => {
  const user = newUser('owner');
  const { authenticator } = await enrollWithPassword(user.id);
  const stepUp = await post('/step-up/options', { audience: 'passkey_registration' }, user.id);
  const captured = authenticator.assert(stepUp.body.challenge);

  connectorRecords.length = 0;
  const login = await post('/login/verify', { response: captured });
  assert.equal(login.status, 401);
  assert.equal(login.body.token, undefined);
  assert.deepEqual(connectorRecords, [], 'no connector session from a step-up assertion');
});

test('per-user route limiter caps step-up requests before they reach the audit', async () => {
  const user = newUser();
  const other = newUser();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    assert.equal((await post('/register/options', {}, user.id)).status, 403);
  }
  const capped = await post('/register/options', {}, user.id);
  assert.equal(capped.status, 429);
  assert.equal(capped.body.code, 'step_up_rate_limited');
  const stepUp = await post('/step-up/options', { audience: 'passkey_registration' }, user.id);
  assert.equal(stepUp.status, 429, 'the cap is shared by both step-up routes');
  assert.equal(denials(user.id).length, 20, 'capped requests write no audit row');
  assert.equal((await post('/register/options', {}, other.id)).status, 403, 'keyed per user');
});

test('repeated step_up_rate_limited refusals write one audit row per window', async () => {
  const user = newUser();
  const wrong = { stepUp: { method: 'password', password: 'not-the-password' } };
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal((await post('/register/options', wrong, user.id)).status, 401);
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const limited = await post('/register/options', wrong, user.id);
    assert.equal(limited.status, 429);
    assert.equal(limited.body.code, 'step_up_rate_limited');
  }
  const codes = denials(user.id).map((row) => row.code);
  assert.equal(codes.filter((code) => code === 'step_up_failed').length, 5);
  assert.equal(codes.filter((code) => code === 'step_up_rate_limited').length, 1);
});

/**
 * Step-up service + hardened passkey ceremonies (T-1939 slice 6A, B-1407),
 * against a real database and a software authenticator whose signatures
 * @simplewebauthn/server verifies for real.
 *
 * One database for the whole file: the per-user step-up limiter is a module
 * singleton, so every test works on its own freshly created user.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { userIdentitiesDb } from '@/modules/database/repositories/user-identities.js';
import { userDb } from '@/modules/database/repositories/users.js';
import { webauthnCredentialsDb } from '@/modules/database/repositories/webauthn-credentials.js';

import { oidcStepUpGrantStore } from './oidc-step-up-grant.store.js';
import { hashPassword } from './password.service.js';
import { StepUpError, verifyStepUpEvidence } from './step-up.service.js';
import {
  WebAuthnError,
  createAuthenticationOptions,
  createRegistrationOptions,
  createStepUpOptions,
  verifyAuthentication,
  verifyRegistration,
} from './webauthn.service.js';
import { createSoftAuthenticator } from './webauthn-soft-authenticator.fixture.js';

const PASSWORD = 'correct horse battery';
let tempDirectory = '';
let previousDatabasePath: string | undefined;
let passwordHash = '';
let userSeq = 0;

before(async () => {
  previousDatabasePath = process.env.DATABASE_PATH;
  tempDirectory = await mkdtemp(path.join(tmpdir(), 'step-up-svc-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'db.sqlite');
  await initializeDatabase();
  passwordHash = await hashPassword(PASSWORD);
});

after(async () => {
  closeConnection();
  if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = previousDatabasePath;
  await rm(tempDirectory, { recursive: true, force: true });
});

const newUser = (role: 'owner' | 'admin' | 'user' = 'user') => {
  userSeq += 1;
  return userDb.createUser(`stepup_${userSeq}`, passwordHash, role);
};

const stepUp = (user: { id: number }, evidence: unknown, audience = 'passkey_registration') =>
  verifyStepUpEvidence({} as never, user, audience as 'passkey_registration', evidence);

async function rejectsCode(promise: Promise<unknown>, code: string, reason?: string) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof StepUpError, `StepUpError expected, got ${String(error)}`);
    assert.equal(error.code, code);
    if (reason) assert.equal(error.reason, reason);
    return true;
  });
}

/** Enrolls an eligible passkey through the hardened registration ceremony. */
async function enroll(user: { id: number; username: string }) {
  const authenticator = createSoftAuthenticator();
  const options = await createRegistrationOptions(user);
  await verifyRegistration(user, authenticator.register(options.challenge), 'key');
  return authenticator;
}

async function withOidc(run: () => Promise<void>) {
  const saved = { enabled: process.env.OIDC_ENABLED, project: process.env.OIDC_ROLE_PROJECT_ID };
  process.env.OIDC_ENABLED = 'true';
  process.env.OIDC_ROLE_PROJECT_ID = 'proj-synth';
  try { await run(); } finally {
    for (const [key, value] of [['OIDC_ENABLED', saved.enabled], ['OIDC_ROLE_PROJECT_ID', saved.project]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('password evidence: correct → password method; wrong → 401 step_up_failed; none → 403', async () => {
  const user = newUser();
  const result = await stepUp(user, { method: 'password', password: PASSWORD });
  assert.equal(result.authMethod, 'password');
  assert.ok(Math.abs(result.authTimeMs - Date.now()) < 5000);

  await rejectsCode(stepUp(user, { method: 'password', password: 'nope-nope' }), 'step_up_failed');
  await rejectsCode(stepUp(user, undefined), 'step_up_required');
  await rejectsCode(stepUp(user, { method: 'magic' }), 'step_up_invalid_request');
  const failed = new StepUpError('step_up_failed');
  assert.equal(failed.status, 401);
  assert.equal(new StepUpError('step_up_required').status, 403);
});

test('password evidence is refused while must_change_password=1', async () => {
  const user = newUser();
  userDb.resetPassword(user.id, passwordHash, Date.now());
  await rejectsCode(stepUp(user, { method: 'password', password: PASSWORD }), 'password_change_required');
});

test('an inactive user cannot step up', async () => {
  const user = newUser();
  userDb.setStatus(user.id, 'disabled');
  await rejectsCode(stepUp(user, { method: 'password', password: PASSWORD }), 'step_up_failed', 'user_inactive');
});

test('SSO: a linked member gets sso_step_up_required; linked owner and OIDC-off keep local step-up', async () => {
  const member = newUser('user');
  const owner = newUser('owner');
  userIdentitiesDb.link(member.id, 'https://idp.example', `sub-${member.id}`);
  userIdentitiesDb.link(owner.id, 'https://idp.example', `sub-${owner.id}`);
  await withOidc(async () => {
    await rejectsCode(stepUp(member, { method: 'password', password: PASSWORD }), 'sso_step_up_required');
    await rejectsCode(stepUp(member, { method: 'passkey', response: {} }), 'sso_step_up_required');
    assert.equal((await stepUp(owner, { method: 'password', password: PASSWORD })).authMethod, 'password');
  });
  assert.equal((await stepUp(member, { method: 'password', password: PASSWORD })).authMethod, 'password');
});

test('registration requires UV, sets step_up_eligible=1 and a registration challenge is user-bound', async () => {
  const user = newUser();
  const options = await createRegistrationOptions(user);
  assert.equal(options.authenticatorSelection?.userVerification, 'required');
  const authenticator = createSoftAuthenticator();
  const credential = await verifyRegistration(user, authenticator.register(options.challenge), 'k');
  assert.equal((credential as { step_up_eligible: number }).step_up_eligible, 1);
  assert.equal(webauthnCredentialsDb.getById(authenticator.id)?.step_up_eligible, 1);

  const noUv = createSoftAuthenticator();
  const second = await createRegistrationOptions(user);
  await assert.rejects(
    verifyRegistration(user, noUv.register(second.challenge, { uv: false }), null),
    (error: unknown) => error instanceof WebAuthnError && error.reason === 'verification_failed'
  );
  assert.equal(webauthnCredentialsDb.getById(noUv.id), undefined, 'nothing persisted without UV');
});

test('passkey evidence: eligible credential with UV satisfies the audience it was issued for', async () => {
  const user = newUser();
  const authenticator = await enroll(user);
  const options = await createStepUpOptions(user, 'passkey_registration');
  assert.equal(options.userVerification, 'required');
  assert.deepEqual(options.allowCredentials?.map((entry) => entry.id), [authenticator.id]);
  const result = await stepUp(user, { method: 'passkey', response: authenticator.assert(options.challenge) });
  assert.equal(result.authMethod, 'webauthn');
});

test('passkey evidence: a challenge for another audience is rejected', async () => {
  const user = newUser();
  const authenticator = await enroll(user);
  const options = await createStepUpOptions(user, 'connector_owner');
  await rejectsCode(stepUp(user, { method: 'passkey', response: authenticator.assert(options.challenge) },
    'passkey_registration'), 'step_up_failed', 'challenge_invalid');
});

test('passkey evidence: assertion without UV is rejected', async () => {
  const user = newUser();
  const authenticator = await enroll(user);
  const options = await createStepUpOptions(user, 'passkey_registration');
  await rejectsCode(stepUp(user, {
    method: 'passkey', response: authenticator.assert(options.challenge, { uv: false }),
  }), 'step_up_failed', 'verification_failed');
});

test('passkey evidence: a legacy (non-eligible) passkey cannot step up and gets no options', async () => {
  const user = newUser();
  const authenticator = await enroll(user);
  const options = await createStepUpOptions(user, 'passkey_registration');
  getConnection().prepare('UPDATE webauthn_credentials SET step_up_eligible = 0 WHERE id = ?')
    .run(authenticator.id);
  await rejectsCode(stepUp(user, { method: 'passkey', response: authenticator.assert(options.challenge) }),
    'step_up_failed', 'credential_not_eligible');
  await assert.rejects(createStepUpOptions(user, 'passkey_registration'),
    (error: unknown) => error instanceof WebAuthnError && error.status === 409);
});

test("passkey evidence: another user's eligible credential is rejected", async () => {
  const alice = newUser();
  const bob = newUser();
  await enroll(alice);
  const bobKey = await enroll(bob);
  const options = await createStepUpOptions(alice, 'passkey_registration');
  await rejectsCode(stepUp(alice, { method: 'passkey', response: bobKey.assert(options.challenge) }),
    'step_up_failed', 'credential_not_owned');
});

test('passkey evidence: a signature-counter regression is rejected', async () => {
  const user = newUser();
  const authenticator = await enroll(user);
  const first = await createStepUpOptions(user, 'passkey_registration');
  await stepUp(user, { method: 'passkey', response: authenticator.assert(first.challenge, { signCount: 7 }) });
  assert.equal(webauthnCredentialsDb.getById(authenticator.id)?.counter, 7);
  const second = await createStepUpOptions(user, 'passkey_registration');
  await rejectsCode(stepUp(user, {
    method: 'passkey', response: authenticator.assert(second.challenge, { signCount: 7 }),
  }), 'step_up_failed', 'verification_failed');
});

test('one pending step-up per user: a new challenge replaces the previous one', async () => {
  const user = newUser();
  const authenticator = await enroll(user);
  const stale = await createStepUpOptions(user, 'passkey_registration');
  const fresh = await createStepUpOptions(user, 'passkey_registration');
  await rejectsCode(stepUp(user, { method: 'passkey', response: authenticator.assert(stale.challenge) }),
    'step_up_failed', 'challenge_invalid');
  assert.equal((await stepUp(user, {
    method: 'passkey', response: authenticator.assert(fresh.challenge),
  })).authMethod, 'webauthn');
});

test('cross-purpose challenge reuse is rejected in every direction', async () => {
  const user = newUser();
  const authenticator = await enroll(user);

  // login → step_up
  const login = await createAuthenticationOptions();
  await rejectsCode(stepUp(user, { method: 'passkey', response: authenticator.assert(login.challenge) }),
    'step_up_failed', 'challenge_invalid');
  // step_up → login
  const stepUpOptions = await createStepUpOptions(user, 'passkey_registration');
  await assert.rejects(verifyAuthentication(authenticator.assert(stepUpOptions.challenge)),
    (error: unknown) => error instanceof WebAuthnError && error.reason === 'challenge_invalid');
  // registration → step_up
  const registration = await createRegistrationOptions(user);
  await rejectsCode(stepUp(user, { method: 'passkey', response: authenticator.assert(registration.challenge) }),
    'step_up_failed', 'challenge_invalid');
  // step_up → registration
  const stepUpAgain = await createStepUpOptions(user, 'passkey_registration');
  await assert.rejects(
    verifyRegistration(user, createSoftAuthenticator().register(stepUpAgain.challenge), null),
    (error: unknown) => error instanceof WebAuthnError && error.reason === 'challenge_invalid'
  );
  // login → registration
  const loginAgain = await createAuthenticationOptions();
  await assert.rejects(
    verifyRegistration(user, createSoftAuthenticator().register(loginAgain.challenge), null),
    (error: unknown) => error instanceof WebAuthnError && error.reason === 'challenge_invalid'
  );
});

test('login verify reports userVerified and eligibility (legacy vs hardened passkey)', async () => {
  const user = newUser();
  const authenticator = await enroll(user);
  const first = await createAuthenticationOptions();
  const hardened = await verifyAuthentication(authenticator.assert(first.challenge));
  assert.equal(hardened.userVerified, true);
  assert.equal(hardened.stepUpEligible, true);

  getConnection().prepare('UPDATE webauthn_credentials SET step_up_eligible = 0 WHERE id = ?')
    .run(authenticator.id);
  const second = await createAuthenticationOptions();
  const legacy = await verifyAuthentication(authenticator.assert(second.challenge, { uv: false }));
  assert.equal(legacy.userVerified, false);
  assert.equal(legacy.stepUpEligible, false);
});

test('per-user limiter: the 6th attempt in the window is refused even with the right password', async () => {
  const user = newUser();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await rejectsCode(stepUp(user, { method: 'password', password: 'wrong-wrong' }), 'step_up_failed');
  }
  await rejectsCode(stepUp(user, { method: 'password', password: PASSWORD }), 'step_up_rate_limited');
  // The limiter is shared across audiences.
  await rejectsCode(stepUp(user, { method: 'password', password: PASSWORD }, 'connector_owner'),
    'step_up_rate_limited');
});

test('login challenge cap is reached independently of registration: 503, registration unaffected', async () => {
  const user = newUser();
  for (let index = 0; index < 1000; index += 1) {
    await createAuthenticationOptions();
  }
  await assert.rejects(createAuthenticationOptions(), (error: unknown) =>
    error instanceof WebAuthnError && error.status === 503 && error.code === 'challenge_store_full');
  const options = await createRegistrationOptions(user);
  assert.ok(options.challenge);
});

// ---------------------------------------------------------------------------
// T-1939 6B: OIDC step-up grant as connector_owner evidence
// ---------------------------------------------------------------------------

const TXN = 'T'.repeat(43);
const txnRequest = (cookie?: string) => ({ headers: cookie === undefined ? {} : { cookie } }) as never;
const grantStep = (user: { id: number }, grant: string, cookie: string | null = `__Host-oidc-txn=${TXN}`,
  audience = 'connector_owner') => verifyStepUpEvidence(txnRequest(cookie ?? undefined), user,
  audience as 'connector_owner', { method: 'oidc_grant', grant });
const issueGrant = (userId: number, browserTransaction = TXN) =>
  oidcStepUpGrantStore.issue({ userId, audience: 'connector_owner', browserTransaction }) as string;

test('oidc_grant: a linked member redeems a grant once, for itself, from the same browser only', async () => {
  const member = newUser('user');
  const other = newUser('user');
  userIdentitiesDb.link(member.id, 'https://idp.example', `sub-${member.id}`);
  userIdentitiesDb.link(other.id, 'https://idp.example', `sub-${other.id}`);
  await withOidc(async () => {
    const grant = issueGrant(member.id);
    const verdict = await grantStep(member, grant);
    assert.equal(verdict.authMethod, 'oidc');
    assert.ok(Math.abs(verdict.authTimeMs - Date.now()) < 5000);
    await rejectsCode(grantStep(member, grant), 'step_up_failed', 'oidc_grant_invalid');

    const stolen = issueGrant(member.id);
    await rejectsCode(grantStep(other, stolen), 'step_up_failed', 'oidc_grant_invalid');
    // The wrong-user attempt burned it: the rightful owner cannot use it either.
    await rejectsCode(grantStep(member, stolen), 'step_up_failed', 'oidc_grant_invalid');

    await rejectsCode(grantStep(member, issueGrant(member.id), `__Host-oidc-txn=${'U'.repeat(43)}`),
      'step_up_failed', 'oidc_grant_invalid');
    await rejectsCode(grantStep(member, issueGrant(member.id), null), 'step_up_failed', 'oidc_grant_invalid');
    await rejectsCode(grantStep(member, issueGrant(member.id), `__Host-oidc-txn=${TXN}; __Host-oidc-txn=${TXN}`),
      'step_up_failed', 'oidc_grant_invalid');
    await rejectsCode(grantStep(member, issueGrant(member.id), null, 'passkey_registration'),
      'sso_step_up_required');
    await rejectsCode(grantStep(member, 'x'.repeat(129)), 'step_up_invalid_request');
  });
});

test('oidc_grant: refused for accounts that are not SSO-linked, and never counted on the limiter', async () => {
  const local = newUser('user');
  await rejectsCode(grantStep(local, issueGrant(local.id)), 'step_up_invalid_request');
  const member = newUser('user');
  userIdentitiesDb.link(member.id, 'https://idp.example', `sub-${member.id}`);
  await withOidc(async () => {
    for (let index = 0; index < 6; index += 1) {
      await rejectsCode(grantStep(member, `bogus-${index}`), 'step_up_failed', 'oidc_grant_invalid');
    }
    assert.equal((await grantStep(member, issueGrant(member.id))).authMethod, 'oidc',
      'the IdP round trip was counted at /step-up/start, not here');
  });
});

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { userDb } from '@/modules/database/repositories/users.js';
import { webauthnCredentialsDb } from '@/modules/database/repositories/webauthn-credentials.js';

import {
  WebAuthnError,
  createAuthenticationOptions,
  createRegistrationOptions,
  verifyAuthentication,
  verifyRegistration,
} from './webauthn.service.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'webauthn-svc-'));
  const databasePath = path.join(tempDirectory, 'db.sqlite');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/** Builds an AuthenticationResponseJSON-shaped object whose clientDataJSON
 *  carries the given challenge. Signature material is bogus — every test here
 *  must be rejected BEFORE signature verification is reached. */
function fakeAuthResponse(challenge: string, credentialId: string) {
  const clientDataJSON = Buffer.from(
    JSON.stringify({ type: 'webauthn.get', challenge, origin: 'http://localhost:5173' })
  ).toString('base64url');
  return {
    id: credentialId,
    rawId: credentialId,
    type: 'public-key',
    response: { clientDataJSON, authenticatorData: 'AAAA', signature: 'AAAA', userHandle: null },
    clientExtensionResults: {},
  };
}

async function assertRejectsWebAuthn(
  promise: Promise<unknown>,
  expected: { status: number; reason: string }
) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof WebAuthnError, 'WebAuthnError expected');
    assert.equal((error as WebAuthnError & { status: number }).status, expected.status);
    assert.equal((error as WebAuthnError & { reason: string }).reason, expected.reason);
    return true;
  });
}

test('login verify: unknown credential is rejected with a generic 401', async () => {
  await withIsolatedDatabase(async () => {
    const options = await createAuthenticationOptions();
    await assertRejectsWebAuthn(
      verifyAuthentication(fakeAuthResponse(options.challenge, 'no-such-credential')),
      { status: 401, reason: 'unknown_credential' }
    );
  });
});

test('login verify: disabled user is rejected even with a known credential', async () => {
  await withIsolatedDatabase(async () => {
    const user = userDb.createUser('mallory', 'hash', 'user');
    webauthnCredentialsDb.create({ id: 'cred-1', userId: user.id, publicKey: Buffer.from([1]) });
    userDb.setStatus(user.id, 'disabled');

    const options = await createAuthenticationOptions();
    await assertRejectsWebAuthn(
      verifyAuthentication(fakeAuthResponse(options.challenge, 'cred-1')),
      { status: 401, reason: 'user_inactive' }
    );
  });
});

test('login verify: is_active=0 user is rejected even with a known credential', async () => {
  await withIsolatedDatabase(async () => {
    const user = userDb.createUser('inactive', 'hash', 'user');
    webauthnCredentialsDb.create({ id: 'cred-2', userId: user.id, publicKey: Buffer.from([1]) });
    getConnection().prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(user.id);

    const options = await createAuthenticationOptions();
    await assertRejectsWebAuthn(
      verifyAuthentication(fakeAuthResponse(options.challenge, 'cred-2')),
      { status: 401, reason: 'user_inactive' }
    );
  });
});

test('login verify: replayed challenge is rejected (single use)', async () => {
  await withIsolatedDatabase(async () => {
    const options = await createAuthenticationOptions();

    // First use consumes the challenge (fails later, at credential lookup).
    await assertRejectsWebAuthn(
      verifyAuthentication(fakeAuthResponse(options.challenge, 'whatever')),
      { status: 401, reason: 'unknown_credential' }
    );
    // Replay of the same challenge fails earlier, at the challenge gate.
    await assertRejectsWebAuthn(
      verifyAuthentication(fakeAuthResponse(options.challenge, 'whatever')),
      { status: 401, reason: 'challenge_invalid' }
    );
  });
});

test('login verify: never-issued (or expired) challenge is rejected', async () => {
  await withIsolatedDatabase(async () => {
    await assertRejectsWebAuthn(
      verifyAuthentication(fakeAuthResponse('bogus-challenge-value', 'whatever')),
      { status: 401, reason: 'challenge_invalid' }
    );
  });
});

test('login verify: a registration challenge cannot be replayed into login', async () => {
  await withIsolatedDatabase(async () => {
    const user = userDb.createUser('alice', 'hash', 'user');
    const regOptions = await createRegistrationOptions({ id: user.id, username: user.username });

    await assertRejectsWebAuthn(
      verifyAuthentication(fakeAuthResponse(regOptions.challenge, 'whatever')),
      { status: 401, reason: 'challenge_invalid' }
    );
  });
});

test('login verify: malformed response (no clientDataJSON) is rejected', async () => {
  await withIsolatedDatabase(async () => {
    await assertRejectsWebAuthn(
      verifyAuthentication({ id: 'x', response: {} }),
      { status: 401, reason: 'malformed_response' }
    );
  });
});

test('registration options: bound to the user and excludes existing credentials', async () => {
  await withIsolatedDatabase(async () => {
    const user = userDb.createUser('alice', 'hash', 'user');
    webauthnCredentialsDb.create({
      id: 'existing-cred',
      userId: user.id,
      publicKey: Buffer.from([1]),
      transports: ['internal'],
    });

    const options = await createRegistrationOptions({ id: user.id, username: user.username });

    // rpID is captured from env at module load, so neutralize the ambient
    // WEBAUTHN_RP_ID (e.g. from .env) instead of asserting a hardcoded fallback.
    assert.equal(options.rp.id, process.env.WEBAUTHN_RP_ID || 'localhost', 'dev fallback rpID');
    assert.equal(options.user.name, 'alice');
    assert.deepEqual(
      options.excludeCredentials?.map((c) => c.id),
      ['existing-cred']
    );
    assert.equal(options.authenticatorSelection?.residentKey, 'preferred');
    assert.equal(options.authenticatorSelection?.userVerification, 'preferred');
    assert.ok(typeof options.challenge === 'string' && options.challenge.length > 0);
  });
});

test("registration verify: another user's challenge is rejected", async () => {
  await withIsolatedDatabase(async () => {
    const alice = userDb.createUser('alice', 'hash', 'user');
    const bob = userDb.createUser('bob', 'hash', 'user');

    const aliceOptions = await createRegistrationOptions({ id: alice.id, username: 'alice' });
    const response = fakeAuthResponse(aliceOptions.challenge, 'new-cred');

    await assertRejectsWebAuthn(
      verifyRegistration({ id: bob.id }, response, null),
      { status: 400, reason: 'challenge_invalid' }
    );
  });
});

test('registration verify: garbage attestation fails closed after challenge consumption', async () => {
  await withIsolatedDatabase(async () => {
    const user = userDb.createUser('alice', 'hash', 'user');
    const options = await createRegistrationOptions({ id: user.id, username: 'alice' });

    // Challenge is valid and bound to alice, but the attestation payload is
    // garbage → verifyRegistrationResponse throws → mapped to a generic 400.
    const response = fakeAuthResponse(options.challenge, 'new-cred');
    await assertRejectsWebAuthn(
      verifyRegistration({ id: user.id }, response, 'My key'),
      { status: 400, reason: 'verification_failed' }
    );

    assert.equal(webauthnCredentialsDb.listByUserId(user.id).length, 0, 'nothing persisted');
  });
});

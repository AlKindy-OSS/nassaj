/**
 * WebAuthn (passkey) service (B-PK-3 / B-PK-4, hardened by B-1407).
 *
 * Wraps @simplewebauthn/server v13 with this app's persistence and challenge
 * bookkeeping. Three ceremonies, each bound to its own challenge purpose:
 *
 *   Registration (authenticated, after a step-up proof checked by the route):
 *   createRegistrationOptions stores a user-bound 'registration' challenge and
 *   requires user verification; verifyRegistration consumes it, verifies the
 *   attestation WITH user verification and persists the credential as
 *   step-up eligible.
 *
 *   Authentication (anonymous, discoverable credentials): the options carry an
 *   empty allowCredentials list and an anonymous 'login' challenge; the verify
 *   step resolves the credential by the ID in the assertion, enforces the
 *   owning user is active, verifies the signature and advances the counter.
 *   UV stays 'preferred' here (login must not strand authenticators without
 *   UV); callers read `userVerified` + `stepUpEligible` from the result.
 *
 *   Step-up (authenticated): createStepUpOptions lists only the caller's
 *   eligible credentials and requires UV; the assertion itself is checked by
 *   services/step-up.service.js through verifyAssertionCore.
 *
 * The challenge is recovered from the response's clientDataJSON (it is what
 * the authenticator actually signed), then consumed single-use from the store
 * with the exact expected purpose — a replayed or cross-ceremony assertion
 * therefore fails before any crypto work.
 *
 * Error policy: WebAuthnError.message is generic and safe for clients (never
 * reveals whether a credential exists); the machine-readable `reason` is for
 * audit metadata only.
 */

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';

import {
  WEBAUTHN_ORIGINS,
  WEBAUTHN_RP_ID,
  WEBAUTHN_RP_NAME,
} from '../constants/webauthn.js';
import { userDb, webauthnCredentialsDb } from '../modules/database/index.js';

import { ChallengeStoreFullError, webauthnChallengeStore } from './webauthn-challenge.store.js';

/**
 * Errors thrown by the service. `status` drives the HTTP layer, `message` is
 * client-safe and generic, `reason` is internal (audit metadata only).
 */
export class WebAuthnError extends Error {
  constructor(status, message, reason, code) {
    super(message);
    this.status = status;
    this.reason = reason;
    this.code = code;
  }
}

export const GENERIC_LOGIN_ERROR = 'Passkey authentication failed';

/** Stores a challenge; a full store becomes a client-safe 503. */
function storeChallenge(challenge, binding) {
  try {
    webauthnChallengeStore.store(challenge, binding);
  } catch (error) {
    if (error instanceof ChallengeStoreFullError) {
      throw new WebAuthnError(
        503, 'Passkeys are busy, please try again shortly', 'challenge_store_full', 'challenge_store_full'
      );
    }
    throw error;
  }
}

/** Parses the stored JSON transports column back into an array (or undefined). */
function parseTransports(transportsJson) {
  if (!transportsJson) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(transportsJson);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Extracts the base64url challenge the authenticator signed from a
 * registration/authentication response's clientDataJSON. Returns null on any
 * malformed input (never throws).
 */
export function extractClientChallenge(response) {
  try {
    const clientDataJSON = response?.response?.clientDataJSON;
    if (typeof clientDataJSON !== 'string') {
      return null;
    }
    const clientData = JSON.parse(Buffer.from(clientDataJSON, 'base64url').toString('utf8'));
    return typeof clientData.challenge === 'string' && clientData.challenge.length > 0
      ? clientData.challenge
      : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Registration (authenticated user adds a passkey)
// ---------------------------------------------------------------------------

/**
 * Generates registration options for the authenticated user and stores a
 * 'registration' challenge bound to their id. The caller (route) must already
 * have checked a step-up proof. User verification is required. Only
 * step-up-eligible credentials are excluded: a legacy (pre-B-1407) passkey must
 * stay re-registrable on the same authenticator so the user can upgrade it and
 * then delete the legacy entry (the settings UI guides exactly that).
 *
 * @param {{ id:number, username:string }} user
 * @returns {Promise<import('@simplewebauthn/server').PublicKeyCredentialCreationOptionsJSON>}
 */
export async function createRegistrationOptions(user) {
  const eligible = webauthnCredentialsDb.listStepUpEligibleByUserId(user.id);

  const options = await generateRegistrationOptions({
    rpName: WEBAUTHN_RP_NAME,
    rpID: WEBAUTHN_RP_ID,
    userName: user.username,
    userID: new TextEncoder().encode(String(user.id)),
    attestationType: 'none',
    excludeCredentials: eligible.map((credential) => ({
      id: credential.id,
      transports: parseTransports(credential.transports),
    })),
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'required',
    },
  });

  storeChallenge(options.challenge, { userId: user.id, purpose: 'registration' });
  return options;
}

/**
 * Verifies a registration response (user verification required) and persists
 * the new credential as step-up eligible.
 *
 * @param {{ id:number }} user authenticated owner of the ceremony
 * @param {object} response RegistrationResponseJSON from the browser
 * @param {string|null} [name] optional user-supplied label
 * @returns {Promise<object>} the stored credential summary (no public key)
 * @throws {WebAuthnError}
 */
export async function verifyRegistration(user, response, name = null) {
  const challenge = extractClientChallenge(response);
  if (!challenge) {
    throw new WebAuthnError(400, 'Invalid registration response', 'malformed_response');
  }

  const entry = webauthnChallengeStore.consume(challenge, {
    purpose: 'registration', userId: user.id,
  });
  if (!entry) {
    throw new WebAuthnError(
      400,
      'Registration challenge is invalid or has expired',
      'challenge_invalid'
    );
  }

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: WEBAUTHN_ORIGINS,
      expectedRPID: WEBAUTHN_RP_ID,
      requireUserVerification: true,
    });
  } catch {
    throw new WebAuthnError(400, 'Passkey registration could not be verified', 'verification_failed');
  }

  if (
    !verification.verified ||
    !verification.registrationInfo ||
    verification.registrationInfo.userVerified !== true
  ) {
    throw new WebAuthnError(400, 'Passkey registration could not be verified', 'not_verified');
  }

  const { credential, credentialDeviceType, credentialBackedUp, aaguid } =
    verification.registrationInfo;

  try {
    webauthnCredentialsDb.create({
      id: credential.id,
      userId: user.id,
      publicKey: Buffer.from(credential.publicKey),
      counter: credential.counter,
      transports: credential.transports ?? null,
      deviceType: credentialDeviceType ?? null,
      backedUp: credentialBackedUp === true,
      aaguid: aaguid ?? null,
      name: name ?? null,
      stepUpEligible: true,
    });
  } catch (error) {
    // UNIQUE violation → this authenticator is already registered.
    if (String(error?.message ?? '').includes('UNIQUE')) {
      throw new WebAuthnError(409, 'This passkey is already registered', 'duplicate_credential');
    }
    throw error;
  }

  const stored = webauthnCredentialsDb
    .listByUserId(user.id)
    .find((row) => row.id === credential.id);
  return stored ?? { id: credential.id, name: name ?? null };
}

// ---------------------------------------------------------------------------
// Authentication (anonymous login with a discoverable credential)
// ---------------------------------------------------------------------------

/**
 * Generates anonymous authentication options (discoverable credentials —
 * empty allowCredentials) and stores the challenge unbound (userId=null).
 *
 * @returns {Promise<import('@simplewebauthn/server').PublicKeyCredentialRequestOptionsJSON>}
 */
export async function createAuthenticationOptions() {
  const options = await generateAuthenticationOptions({
    rpID: WEBAUTHN_RP_ID,
    allowCredentials: [],
    userVerification: 'preferred',
  });

  storeChallenge(options.challenge, { userId: null, purpose: 'login' });
  return options;
}

/**
 * Verifies one assertion against a stored credential row: signature, origin,
 * RP ID, challenge and signature-counter regression (a counter that does not
 * advance is rejected by @simplewebauthn as a cloned-authenticator signal).
 * On success advances the counter and stamps last_used_at.
 *
 * @param {{ row: object, response: object, challenge: string, requireUV: boolean }} input
 * @returns {Promise<{ userVerified: boolean }>}
 * @throws {WebAuthnError} 401 generic, `userId` set to the credential owner
 */
export async function verifyAssertionCore({ row, response, challenge, requireUV }) {
  const fail = (reason) => {
    const error = new WebAuthnError(401, GENERIC_LOGIN_ERROR, reason);
    error.userId = row.user_id;
    return error;
  };

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: WEBAUTHN_ORIGINS,
      expectedRPID: WEBAUTHN_RP_ID,
      credential: {
        id: row.id,
        publicKey: new Uint8Array(row.public_key),
        counter: row.counter,
        transports: parseTransports(row.transports),
      },
      requireUserVerification: requireUV === true,
    });
  } catch {
    throw fail('verification_failed');
  }

  if (!verification.verified) {
    throw fail('not_verified');
  }

  webauthnCredentialsDb.updateCounterAndLastUsed(
    row.id,
    verification.authenticationInfo.newCounter
  );
  return { userVerified: verification.authenticationInfo.userVerified === true };
}

/**
 * Verifies an anonymous login assertion and resolves the owning user.
 * Enforces: single-use 'login' challenge, known credential, active user
 * (status='active' AND is_active=1 via userDb.getUserById), valid signature.
 *
 * @param {object} response AuthenticationResponseJSON from the browser
 * @returns {Promise<{ user: object, credentialId: string, userVerified: boolean,
 *   stepUpEligible: boolean }>}
 * @throws {WebAuthnError} always 401 with a generic message on auth failure
 */
export async function verifyAuthentication(response) {
  const challenge = extractClientChallenge(response);
  if (!challenge) {
    throw new WebAuthnError(401, GENERIC_LOGIN_ERROR, 'malformed_response');
  }

  // Single-use and purpose-bound: a registration or step-up challenge can
  // never be replayed into login.
  const entry = webauthnChallengeStore.consume(challenge, { purpose: 'login', userId: null });
  if (!entry) {
    throw new WebAuthnError(401, GENERIC_LOGIN_ERROR, 'challenge_invalid');
  }

  const credentialId = typeof response?.id === 'string' ? response.id : null;
  const row = credentialId ? webauthnCredentialsDb.getById(credentialId) : undefined;
  if (!row) {
    throw new WebAuthnError(401, GENERIC_LOGIN_ERROR, 'unknown_credential');
  }

  // Active-user gate: getUserById filters on is_active = 1 AND status = 'active'.
  const user = userDb.getUserById(row.user_id);
  if (!user) {
    const error = new WebAuthnError(401, GENERIC_LOGIN_ERROR, 'user_inactive');
    error.userId = row.user_id;
    throw error;
  }

  const { userVerified } = await verifyAssertionCore({
    row, response, challenge, requireUV: false,
  });
  return {
    user,
    credentialId: row.id,
    userVerified,
    stepUpEligible: row.step_up_eligible === 1,
  };
}

// ---------------------------------------------------------------------------
// Step-up (authenticated user re-proves presence with an eligible passkey)
// ---------------------------------------------------------------------------

/**
 * Generates step-up options: allowCredentials lists ONLY the caller's
 * step-up-eligible passkeys, UV is required, and the challenge is bound to
 * (user, 'step_up', audience). A new step-up challenge replaces the user's
 * previous pending one.
 *
 * @param {{ id:number }} user
 * @param {string} audience validated by the caller
 * @returns {Promise<import('@simplewebauthn/server').PublicKeyCredentialRequestOptionsJSON>}
 * @throws {WebAuthnError} 409 when the user has no eligible passkey
 */
export async function createStepUpOptions(user, audience) {
  const eligible = webauthnCredentialsDb.listStepUpEligibleByUserId(user.id);
  if (eligible.length === 0) {
    throw new WebAuthnError(
      409, 'No passkey is eligible for this check', 'no_eligible_credential', 'no_eligible_passkey'
    );
  }
  const options = await generateAuthenticationOptions({
    rpID: WEBAUTHN_RP_ID,
    allowCredentials: eligible.map((credential) => ({
      id: credential.id,
      transports: parseTransports(credential.transports),
    })),
    userVerification: 'required',
  });
  storeChallenge(options.challenge, { userId: user.id, purpose: 'step_up', audience });
  return options;
}

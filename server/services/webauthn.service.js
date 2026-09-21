/**
 * WebAuthn (passkey) service (B-PK-3 / B-PK-4).
 *
 * Wraps @simplewebauthn/server v13 with this app's persistence and challenge
 * bookkeeping. Two ceremonies:
 *
 *   Registration (authenticated): createRegistrationOptions stores a
 *   user-bound challenge; verifyRegistration consumes it, verifies the
 *   attestation and persists the credential.
 *
 *   Authentication (anonymous, discoverable credentials): the options carry an
 *   empty allowCredentials list and an anonymous (userId=null) challenge; the
 *   verify step resolves the credential by the ID in the assertion, enforces
 *   the owning user is active, verifies the signature and advances the counter.
 *
 * The challenge is recovered from the response's clientDataJSON (it is what
 * the authenticator actually signed), then consumed single-use from the store
 * — a replayed assertion therefore fails before any crypto work.
 *
 * Error policy: WebAuthnError.message is generic and safe for clients (never
 * reveals whether a credential exists); the machine-readable `reason` is for
 * audit metadata only.
 *
 * Note: requireUserVerification is false on both verifies because the options
 * request userVerification 'preferred' — per simplewebauthn guidance, requiring
 * UV while only preferring it strands authenticators that skip UV.
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

import { webauthnChallengeStore } from './webauthn-challenge.store.js';

/**
 * Errors thrown by the service. `status` drives the HTTP layer, `message` is
 * client-safe and generic, `reason` is internal (audit metadata only).
 */
export class WebAuthnError extends Error {
  constructor(status, message, reason) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

const GENERIC_LOGIN_ERROR = 'Passkey authentication failed';

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
function extractClientChallenge(response) {
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
 * Generates registration options for the authenticated user and stores the
 * challenge bound to their id. Existing credentials are excluded so the same
 * authenticator is not registered twice.
 *
 * @param {{ id:number, username:string }} user
 * @returns {Promise<import('@simplewebauthn/server').PublicKeyCredentialCreationOptionsJSON>}
 */
export async function createRegistrationOptions(user) {
  const existing = webauthnCredentialsDb.listByUserId(user.id);

  const options = await generateRegistrationOptions({
    rpName: WEBAUTHN_RP_NAME,
    rpID: WEBAUTHN_RP_ID,
    userName: user.username,
    userID: new TextEncoder().encode(String(user.id)),
    attestationType: 'none',
    excludeCredentials: existing.map((credential) => ({
      id: credential.id,
      transports: parseTransports(credential.transports),
    })),
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
  });

  webauthnChallengeStore.store(options.challenge, user.id);
  return options;
}

/**
 * Verifies a registration response and persists the new credential.
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

  const entry = webauthnChallengeStore.consume(challenge);
  if (!entry || entry.userId !== user.id) {
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
      requireUserVerification: false,
    });
  } catch {
    throw new WebAuthnError(400, 'Passkey registration could not be verified', 'verification_failed');
  }

  if (!verification.verified || !verification.registrationInfo) {
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

  webauthnChallengeStore.store(options.challenge, null);
  return options;
}

/**
 * Verifies an authentication assertion and resolves the owning user.
 * Enforces: single-use anonymous challenge, known credential, active user
 * (status='active' AND is_active=1 via userDb.getUserById), valid signature.
 * Advances the signature counter and stamps last_used_at on success.
 *
 * @param {object} response AuthenticationResponseJSON from the browser
 * @returns {Promise<{ user: object, credentialId: string }>}
 * @throws {WebAuthnError} always 401 with a generic message on auth failure
 */
export async function verifyAuthentication(response) {
  const challenge = extractClientChallenge(response);
  if (!challenge) {
    throw new WebAuthnError(401, GENERIC_LOGIN_ERROR, 'malformed_response');
  }

  // Single-use: a consumed/expired/never-issued challenge fails here, and a
  // registration challenge (bound to a userId) cannot be replayed into login.
  const entry = webauthnChallengeStore.consume(challenge);
  if (!entry || entry.userId !== null) {
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
      requireUserVerification: false,
    });
  } catch {
    const error = new WebAuthnError(401, GENERIC_LOGIN_ERROR, 'verification_failed');
    error.userId = user.id;
    throw error;
  }

  if (!verification.verified) {
    const error = new WebAuthnError(401, GENERIC_LOGIN_ERROR, 'not_verified');
    error.userId = user.id;
    throw error;
  }

  webauthnCredentialsDb.updateCounterAndLastUsed(
    row.id,
    verification.authenticationInfo.newCounter
  );

  return { user, credentialId: row.id };
}

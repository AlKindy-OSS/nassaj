/**
 * Shared step-up verification (T-1939 slice 6A, B-1407).
 *
 * A step-up re-proves that the person behind an already-authenticated request
 * is the account holder before a sensitive action. A bearer token alone never
 * suffices: a stolen JWT could otherwise enroll a passkey and later turn it
 * into a connector owner session.
 *
 * Audiences:
 *   passkey_registration  enrolling a new passkey (routes/webauthn.js)
 *   connector_owner       connector recent-auth sessions (slice 6B)
 *
 * Evidence (exactly one):
 *   { method: 'password', password }   the current local password
 *   { method: 'passkey',  response }  an assertion from an ELIGIBLE passkey,
 *                                     answering a step_up challenge issued for
 *                                     the same user and audience, with UV
 *   { method: 'oidc_grant', grant }   SSO-linked members only, connector_owner
 *                                     only: the one-time grant the OIDC
 *                                     step-up callback issued for this user,
 *                                     audience and browser transaction
 *
 * Order (fixed, tested): reload the active user from the database → an
 * SSO-linked member may present only an oidc_grant (anything else is
 * sso_step_up_required) and nobody else may → validate the evidence shape →
 * count one attempt on the shared per-user limiter `stepup:<id>` BEFORE any
 * argon2 or signature work → verify. An oidc_grant is not counted again: its
 * IdP round trip was counted when POST /api/auth/oidc/step-up/start issued it.
 *
 * passkey_registration stays blocked for SSO-linked members: they can neither
 * sign in nor step up with a passkey, so enrolling one would be inert.
 */

import { userDb, webauthnCredentialsDb } from '../modules/database/index.js';

import { readBrowserTransaction } from './oidc-browser-transaction.js';
import { oidcStepUpGrantStore } from './oidc-step-up-grant.store.js';
import { verifyPassword } from './password.service.js';
import { requiresSsoLogin } from './sso-only-policy.js';
import { consumeStepUpAttempt } from './step-up-quota.js';
import { webauthnChallengeStore } from './webauthn-challenge.store.js';
import { WebAuthnError, extractClientChallenge, verifyAssertionCore } from './webauthn.service.js';

export const STEP_UP_AUDIENCES = Object.freeze(['passkey_registration', 'connector_owner']);

const MAX_PASSWORD_LENGTH = 1024;
const MAX_GRANT_LENGTH = 128;

/** HTTP status per code; every 401 carries a code so the SPA keeps the session. */
const STATUS_BY_CODE = Object.freeze({
  step_up_invalid_request: 400,
  step_up_failed: 401,
  step_up_required: 403,
  sso_step_up_required: 403,
  password_change_required: 403,
  step_up_rate_limited: 429,
});

const MESSAGE_BY_CODE = Object.freeze({
  step_up_invalid_request: 'Invalid verification request',
  step_up_failed: 'Verification failed',
  step_up_required: 'Confirm your identity to continue',
  sso_step_up_required: 'Confirm your identity through SSO to continue',
  password_change_required: 'Change your password before continuing',
  step_up_rate_limited: 'Too many verification attempts, please try again later',
});

/** Client-safe step-up refusal; `code` is stable and machine-readable. */
export class StepUpError extends Error {
  /**
   * @param {keyof typeof STATUS_BY_CODE} code
   * @param {{ retryAfterSeconds?: number, reason?: string }} [details]
   */
  constructor(code, details = {}) {
    super(MESSAGE_BY_CODE[code] ?? 'Verification failed');
    this.code = code;
    this.status = STATUS_BY_CODE[code] ?? 401;
    this.retryAfterSeconds = details.retryAfterSeconds;
    this.reason = details.reason ?? code;
  }
}

/** Returns the normalized evidence or throws step_up_required / invalid_request. */
function parseEvidence(evidence) {
  if (evidence === undefined || evidence === null) {
    throw new StepUpError('step_up_required');
  }
  if (typeof evidence !== 'object' || Array.isArray(evidence)) {
    throw new StepUpError('step_up_invalid_request');
  }
  if (evidence.method === 'password') {
    const { password } = evidence;
    if (typeof password !== 'string' || !password || password.length > MAX_PASSWORD_LENGTH) {
      throw new StepUpError('step_up_invalid_request');
    }
    return { method: 'password', password };
  }
  if (evidence.method === 'passkey') {
    const { response } = evidence;
    if (!response || typeof response !== 'object' || Array.isArray(response)) {
      throw new StepUpError('step_up_invalid_request');
    }
    return { method: 'passkey', response };
  }
  if (evidence.method === 'oidc_grant') {
    const { grant } = evidence;
    if (typeof grant !== 'string' || !grant || grant.length > MAX_GRANT_LENGTH) {
      throw new StepUpError('step_up_invalid_request');
    }
    return { method: 'oidc_grant', grant };
  }
  throw new StepUpError('step_up_invalid_request');
}

async function verifyPasswordEvidence(dbUser, password) {
  if (dbUser.must_change_password === 1) {
    throw new StepUpError('password_change_required');
  }
  const raw = userDb.getRawById(dbUser.id);
  // SSO-only accounts carry a sentinel hash that verifyPassword always rejects
  // after the same argon2 work, so their timing matches a wrong password.
  const valid = raw ? await verifyPassword(raw.password_hash, password) : false;
  if (!valid) {
    throw new StepUpError('step_up_failed', { reason: 'bad_password' });
  }
  return { authMethod: 'password', authTimeMs: Date.now() };
}

async function verifyPasskeyEvidence(dbUser, audience, response) {
  const challenge = extractClientChallenge(response);
  const entry = challenge
    ? webauthnChallengeStore.consume(challenge, { purpose: 'step_up', audience, userId: dbUser.id })
    : null;
  if (!entry) {
    throw new StepUpError('step_up_failed', { reason: 'challenge_invalid' });
  }
  const credentialId = typeof response.id === 'string' ? response.id : null;
  const row = credentialId ? webauthnCredentialsDb.getById(credentialId) : undefined;
  if (!row || row.user_id !== dbUser.id) {
    throw new StepUpError('step_up_failed', { reason: 'credential_not_owned' });
  }
  if (row.step_up_eligible !== 1) {
    throw new StepUpError('step_up_failed', { reason: 'credential_not_eligible' });
  }
  let userVerified;
  try {
    ({ userVerified } = await verifyAssertionCore({ row, response, challenge, requireUV: true }));
  } catch (error) {
    if (error instanceof WebAuthnError) {
      throw new StepUpError('step_up_failed', { reason: error.reason });
    }
    throw error;
  }
  if (userVerified !== true) {
    throw new StepUpError('step_up_failed', { reason: 'user_not_verified' });
  }
  return { authMethod: 'webauthn', authTimeMs: Date.now() };
}

function verifyOidcGrantEvidence(req, user, audience, grant) {
  const consumed = oidcStepUpGrantStore.consume(grant, {
    userId: user.id, audience, browserTransaction: readBrowserTransaction(req),
  });
  if (!consumed) {
    throw new StepUpError('step_up_failed', { reason: 'oidc_grant_invalid' });
  }
  return { authMethod: 'oidc', authTimeMs: Date.now() };
}

/**
 * Verifies step-up evidence for `audience`.
 *
 * @param {import('express').Request} req the request (its OIDC transaction cookie binds an oidc_grant)
 * @param {{ id: number }} dbUser the authenticated principal (reloaded here)
 * @param {'passkey_registration' | 'connector_owner'} audience
 * @param {unknown} evidence client-supplied evidence (see module doc)
 * @returns {Promise<{ authMethod: 'password' | 'webauthn' | 'oidc', authTimeMs: number }>}
 * @throws {StepUpError}
 */
export async function verifyStepUpEvidence(req, dbUser, audience, evidence) {
  if (!STEP_UP_AUDIENCES.includes(audience)) {
    throw new Error('step_up_audience_invalid');
  }
  const user = Number.isSafeInteger(dbUser?.id) ? userDb.getUserById(dbUser.id) : undefined;
  if (!user) {
    throw new StepUpError('step_up_failed', { reason: 'user_inactive' });
  }
  const ssoLinked = requiresSsoLogin(user);
  const oidcGrant = evidence?.method === 'oidc_grant';
  if (ssoLinked && (!oidcGrant || audience !== 'connector_owner')) {
    throw new StepUpError('sso_step_up_required');
  }
  const parsed = parseEvidence(evidence);
  if (parsed.method === 'oidc_grant') {
    if (!ssoLinked) throw new StepUpError('step_up_invalid_request');
    return verifyOidcGrantEvidence(req, user, audience, parsed.grant);
  }

  const verdict = consumeStepUpAttempt(user.id);
  if (!verdict.allowed) {
    throw new StepUpError('step_up_rate_limited', { retryAfterSeconds: verdict.retryAfterSeconds });
  }

  return parsed.method === 'password'
    ? verifyPasswordEvidence(user, parsed.password)
    : verifyPasskeyEvidence(user, audience, parsed.response);
}

/**
 * useWebAuthn — client-side passkey ceremonies (C-PK-1).
 *
 * Wraps @simplewebauthn/browser's startRegistration/startAuthentication
 * around the /api/auth/webauthn endpoints and classifies failures so the
 * views stay free of WebAuthn-specific error handling:
 *  - user cancellation (NotAllowedError / aborted ceremony) → `cancelled`,
 *    callers are expected to stay silent;
 *  - duplicate authenticator on registration → `duplicate` (client
 *    InvalidStateError or server 409);
 *  - a refused step-up proof on registration (B-1407) → `stepUp` with the
 *    server's machine-readable `code` (step_up_failed, step_up_rate_limited…);
 *  - everything else → `failed` / `network` with an optional server message.
 *
 * The session side of a passkey login (token persistence, identity hydration,
 * onboarding/mustChangePassword gates) is owned by AuthContext.loginWithPasskey.
 */

import {
  WebAuthnError,
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
} from '@simplewebauthn/browser';
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import { useCallback, useMemo } from 'react';

import { api } from '../../../utils/api';
import { useAuth } from '../context/AuthContext';
import type { ApiErrorPayload, PasskeyCredentialSummary } from '../types';
import { parseJsonSafely } from '../utils';

export type WebAuthnFailureKind = 'cancelled' | 'duplicate' | 'failed' | 'network' | 'stepUp';

/**
 * How the user proves it is them before enrolling a passkey: the current
 * password, or an assertion from one of their step-up-eligible passkeys.
 */
export type PasskeyStepUpInput = { method: 'password'; password: string } | { method: 'passkey' };

export type StepUpEvidence =
  | { method: 'password'; password: string }
  | { method: 'passkey'; response: unknown };

/** Step-up audiences the server accepts (services/step-up.service.js). */
export type StepUpAudience = 'passkey_registration' | 'connector_owner';

export type WebAuthnLoginResult =
  | { success: true }
  | { success: false; kind: WebAuthnFailureKind; error?: string };

export type WebAuthnRegisterResult =
  | { success: true; credential: PasskeyCredentialSummary }
  | { success: false; kind: WebAuthnFailureKind; error?: string; code?: string; retryAfterSeconds?: number };

export type EvidenceResult =
  | { ok: true; evidence: StepUpEvidence }
  | { ok: false; failure: Extract<WebAuthnRegisterResult, { success: false }> };

/** Server codes (routes/webauthn.js, services/step-up.service.js) for a refused step-up. */
export const STEP_UP_CODES: ReadonlySet<string> = new Set([
  'step_up_required',
  'step_up_failed',
  'step_up_invalid_request',
  'step_up_rate_limited',
  'sso_step_up_required',
  'password_change_required',
  'no_eligible_passkey',
]);

/** Parses a failed response into a register failure, keeping the server code. */
async function toFailure(
  response: Response,
): Promise<Extract<WebAuthnRegisterResult, { success: false }>> {
  const payload = await parseJsonSafely<ApiErrorPayload>(response);
  const code = payload?.code;
  // A 429 carries its wait time; the caller shows it and holds the buttons.
  const retryAfterSeconds = Number(response.headers?.get?.('Retry-After'));
  return {
    success: false,
    kind: code && STEP_UP_CODES.has(code) ? 'stepUp' : 'failed',
    error: payload?.error ?? payload?.message,
    code,
    ...(Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
      ? { retryAfterSeconds: Math.ceil(retryAfterSeconds) } : {}),
  };
}

/**
 * Turns the chosen step-up input into evidence for `audience`. For a passkey
 * this runs the step-up ceremony (only the user's eligible passkeys, UV
 * required); the challenge is bound to that audience server-side.
 */
export async function collectStepUpEvidence(
  input: PasskeyStepUpInput,
  audience: StepUpAudience,
): Promise<EvidenceResult> {
  if (input.method === 'password') {
    return { ok: true, evidence: input };
  }
  let optionsJSON: PublicKeyCredentialRequestOptionsJSON;
  try {
    const optionsResponse = await api.auth.webauthn.stepUpOptions(audience);
    if (!optionsResponse.ok) {
      return { ok: false, failure: await toFailure(optionsResponse) };
    }
    const parsed = await parseJsonSafely<PublicKeyCredentialRequestOptionsJSON>(optionsResponse);
    if (!parsed) {
      return { ok: false, failure: { success: false, kind: 'failed' } };
    }
    optionsJSON = parsed;
  } catch (caughtError) {
    console.error('Passkey step-up options error:', caughtError);
    return { ok: false, failure: { success: false, kind: 'network' } };
  }
  try {
    const response = await startAuthentication({ optionsJSON });
    return { ok: true, evidence: { method: 'passkey', response } };
  } catch (caughtError) {
    if (isUserCancellation(caughtError)) {
      return { ok: false, failure: { success: false, kind: 'cancelled' } };
    }
    console.error('Passkey step-up ceremony error:', caughtError);
    return { ok: false, failure: { success: false, kind: 'failed' } };
  }
}

/** True when the user dismissed/aborted the ceremony — callers stay silent. */
function isUserCancellation(error: unknown): boolean {
  if (error instanceof WebAuthnError) {
    // NotAllowedError is passed through with its original name; explicit
    // aborts get the dedicated code.
    return error.code === 'ERROR_CEREMONY_ABORTED' || error.name === 'NotAllowedError';
  }
  return error instanceof Error && (error.name === 'NotAllowedError' || error.name === 'AbortError');
}

/** InvalidStateError → the authenticator already holds a passkey for this user. */
function isDuplicateAuthenticator(error: unknown): boolean {
  return (
    (error instanceof WebAuthnError && error.code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED') ||
    (error instanceof Error && error.name === 'InvalidStateError')
  );
}

export function useWebAuthn() {
  const { loginWithPasskey: completePasskeyLogin } = useAuth();

  // Stable per mount; browser capability does not change at runtime.
  const isSupported = useMemo(() => browserSupportsWebAuthn(), []);

  /**
   * Full passkey sign-in: anonymous options → authenticator assertion →
   * AuthContext session exchange. Discoverable credentials only (the server
   * sends an empty allowCredentials list), so no username is needed.
   */
  const loginWithPasskey = useCallback(async (): Promise<WebAuthnLoginResult> => {
    let optionsJSON: PublicKeyCredentialRequestOptionsJSON;
    try {
      const optionsResponse = await api.auth.webauthn.loginOptions();
      if (!optionsResponse.ok) {
        const payload = await parseJsonSafely<ApiErrorPayload>(optionsResponse);
        return { success: false, kind: 'failed', error: payload?.error ?? payload?.message };
      }
      const parsed = await parseJsonSafely<PublicKeyCredentialRequestOptionsJSON>(optionsResponse);
      if (!parsed) {
        return { success: false, kind: 'failed' };
      }
      optionsJSON = parsed;
    } catch (caughtError) {
      console.error('Passkey login options error:', caughtError);
      return { success: false, kind: 'network' };
    }

    let assertionResponse;
    try {
      assertionResponse = await startAuthentication({ optionsJSON });
    } catch (caughtError) {
      if (isUserCancellation(caughtError)) {
        return { success: false, kind: 'cancelled' };
      }
      console.error('Passkey authentication ceremony error:', caughtError);
      return { success: false, kind: 'failed' };
    }

    const result = await completePasskeyLogin(assertionResponse);
    if (!result.success) {
      return { success: false, kind: 'failed', error: result.error };
    }
    return { success: true };
  }, [completePasskeyLogin]);

  /**
   * Registers a new passkey for the signed-in user after a step-up proof
   * (B-1407). `name` is an optional user-facing label stored alongside the
   * credential.
   */
  const registerPasskey = useCallback(
    async (name: string | undefined, stepUp: PasskeyStepUpInput): Promise<WebAuthnRegisterResult> => {
      const collected = await collectStepUpEvidence(stepUp, 'passkey_registration');
      if (!collected.ok) {
        return collected.failure;
      }
      let optionsJSON: PublicKeyCredentialCreationOptionsJSON;
      try {
        const optionsResponse = await api.auth.webauthn.registerOptions(collected.evidence);
        if (!optionsResponse.ok) {
          return toFailure(optionsResponse);
        }
        const parsed = await parseJsonSafely<PublicKeyCredentialCreationOptionsJSON>(
          optionsResponse,
        );
        if (!parsed) {
          return { success: false, kind: 'failed' };
        }
        optionsJSON = parsed;
      } catch (caughtError) {
        console.error('Passkey registration options error:', caughtError);
        return { success: false, kind: 'network' };
      }

      let registrationResponse;
      try {
        registrationResponse = await startRegistration({ optionsJSON });
      } catch (caughtError) {
        if (isUserCancellation(caughtError)) {
          return { success: false, kind: 'cancelled' };
        }
        if (isDuplicateAuthenticator(caughtError)) {
          return { success: false, kind: 'duplicate' };
        }
        console.error('Passkey registration ceremony error:', caughtError);
        return { success: false, kind: 'failed' };
      }

      try {
        const verifyResponse = await api.auth.webauthn.registerVerify(
          registrationResponse,
          name?.trim() || undefined,
        );
        const payload = await parseJsonSafely<
          ApiErrorPayload & { success?: boolean; credential?: PasskeyCredentialSummary }
        >(verifyResponse);

        if (!verifyResponse.ok || !payload?.credential) {
          return {
            success: false,
            kind: verifyResponse.status === 409 ? 'duplicate' : 'failed',
            error: payload?.error ?? payload?.message,
          };
        }
        return { success: true, credential: payload.credential };
      } catch (caughtError) {
        console.error('Passkey registration verify error:', caughtError);
        return { success: false, kind: 'network' };
      }
    },
    [],
  );

  return { isSupported, loginWithPasskey, registerPasskey };
}

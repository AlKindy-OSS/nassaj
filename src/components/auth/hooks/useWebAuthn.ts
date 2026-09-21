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

export type WebAuthnFailureKind = 'cancelled' | 'duplicate' | 'failed' | 'network';

export type WebAuthnLoginResult =
  | { success: true }
  | { success: false; kind: WebAuthnFailureKind; error?: string };

export type WebAuthnRegisterResult =
  | { success: true; credential: PasskeyCredentialSummary }
  | { success: false; kind: WebAuthnFailureKind; error?: string };

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
   * Registers a new passkey for the signed-in user. `name` is an optional
   * user-facing label stored alongside the credential.
   */
  const registerPasskey = useCallback(
    async (name?: string): Promise<WebAuthnRegisterResult> => {
      let optionsJSON: PublicKeyCredentialCreationOptionsJSON;
      try {
        const optionsResponse = await api.auth.webauthn.registerOptions();
        if (!optionsResponse.ok) {
          const payload = await parseJsonSafely<ApiErrorPayload>(optionsResponse);
          return { success: false, kind: 'failed', error: payload?.error ?? payload?.message };
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

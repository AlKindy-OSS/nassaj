import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { useAuth } from '../context/AuthContext';
import {
  OIDC_CODE_PARAM,
  OIDC_ERROR_PARAM,
  reasonFromReturnError,
  startOidcLogin,
} from '../oidc';
import type { OidcFailureReason } from '../oidc';

import AuthErrorAlert from './AuthErrorAlert';
import AuthScreenLayout from './AuthScreenLayout';

type ReturnPhase =
  | { status: 'verifying'; code: string }
  | { status: 'failed'; reason: OidcFailureReason };

// i18n key (auth namespace) for every failure the page can show.
const REASON_MESSAGE_KEYS: Readonly<Record<OidcFailureReason, string>> = {
  missing_code: 'sso.errors.missingCode',
  invalid_state: 'sso.errors.invalidState',
  provider_denied: 'sso.errors.providerDenied',
  transaction_expired: 'sso.errors.transactionExpired',
  not_linked: 'sso.errors.notLinked',
  account_unavailable: 'sso.errors.accountUnavailable',
  disabled: 'sso.errors.disabled',
  rate_limited: 'sso.errors.rateLimited',
  provider_unavailable: 'sso.errors.providerUnavailable',
  session_failed: 'sso.errors.sessionFailed',
  network: 'sso.errors.network',
};

// Retrying SSO cannot fix these; only an administrator (or the flag) can.
const NON_RETRYABLE_REASONS: ReadonlySet<OidcFailureReason> = new Set([
  'not_linked',
  'account_unavailable',
  'disabled',
]);

function readReturnPhase(params: URLSearchParams): ReturnPhase {
  const error = params.get(OIDC_ERROR_PARAM);
  if (error) {
    return { status: 'failed', reason: reasonFromReturnError(error) };
  }
  const code = params.get(OIDC_CODE_PARAM);
  return code ? { status: 'verifying', code } : { status: 'failed', reason: 'missing_code' };
}

/**
 * SSO return page (`/auth/oidc/return`, B-728).
 *
 * Public route: the server callback lands here with a one-time `oidc_code`
 * (or an `error`). The code is read once, scrubbed from the address bar so it
 * never lingers in history, and redeemed exactly once — a second POST would
 * only fail, since the code is single-use (StrictMode re-runs effects).
 * Success enters the app; every failure is named, with the password sign-in
 * one click away.
 */
export default function OidcReturnPage() {
  const { t } = useTranslation('auth');
  const { loginWithOidcCode } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [phase, setPhase] = useState<ReturnPhase>(() => readReturnPhase(searchParams));
  const hasStarted = useRef(false);

  useEffect(() => {
    if (hasStarted.current) {
      return;
    }
    hasStarted.current = true;
    setSearchParams({}, { replace: true });
    if (phase.status !== 'verifying') {
      return;
    }
    void loginWithOidcCode(phase.code).then((result) => {
      if (result.success) {
        navigate('/', { replace: true });
        return;
      }
      setPhase({ status: 'failed', reason: result.reason });
    });
  }, [loginWithOidcCode, navigate, phase, setSearchParams]);

  const handleBackToLogin = useCallback(() => {
    navigate('/', { replace: true });
  }, [navigate]);

  if (phase.status === 'verifying') {
    return (
      <AuthScreenLayout
        title={t('sso.return.title')}
        description={t('sso.return.verifyingDescription')}
        footerText={t('sso.return.footer')}
      >
        <p
          role="status"
          className="flex items-center justify-center gap-2 text-sm text-muted-foreground"
        >
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          {t('sso.return.verifying')}
        </p>
      </AuthScreenLayout>
    );
  }

  const canRetry = !NON_RETRYABLE_REASONS.has(phase.reason);

  return (
    <AuthScreenLayout
      title={t('sso.return.failedTitle')}
      description={t('sso.return.failedDescription')}
      footerText={t('sso.return.footer')}
    >
      <div role="alert">
        <AuthErrorAlert errorMessage={t(REASON_MESSAGE_KEYS[phase.reason])} />
      </div>

      <div className="space-y-3">
        {canRetry && (
          <button
            type="button"
            onClick={startOidcLogin}
            className="flex w-full items-center justify-center gap-2 rounded-md border border-border bg-background px-4 py-2 font-medium text-foreground transition-colors duration-200 hover:bg-accent hover:text-accent-foreground"
          >
            <ShieldCheck className="h-4 w-4" aria-hidden />
            {t('sso.return.retry')}
          </button>
        )}
        <button
          type="button"
          onClick={handleBackToLogin}
          className="w-full rounded-md bg-blue-600 px-4 py-2 font-medium text-white transition-colors duration-200 hover:bg-blue-700"
        >
          {t('sso.return.backToLogin')}
        </button>
      </div>
    </AuthScreenLayout>
  );
}

import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { AlertTriangle, KeyRound, ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { IS_PLATFORM } from '../../../constants/config';
import { useBranding } from '../../../contexts/BrandingContext';
import { useAuth } from '../context/AuthContext';
import { useSsoStatus } from '../hooks/useOidcAvailability';
import { useWebAuthn } from '../hooks/useWebAuthn';
import type { WebAuthnLoginResult } from '../hooks/useWebAuthn';
import { startOidcLogin } from '../oidc';
import { consumeSsoReauthNotice, hasSsoReauthNotice } from '../ssoReauth';

import AuthErrorAlert from './AuthErrorAlert';
import AuthInputField from './AuthInputField';
import AuthScreenLayout from './AuthScreenLayout';

type LoginFormState = {
  username: string;
  password: string;
};

const initialState: LoginFormState = {
  username: '',
  password: '',
};

/**
 * i18n key for a failed passkey sign-in. Wallet mode (ADR-163 amendment 1)
 * refuses an account under forced rotation with `password_change_required`:
 * only the password sign-in can rotate it. Every other refusal, including a
 * rejected origin, stays generic.
 */
function passkeyFailureKey(result: Extract<WebAuthnLoginResult, { success: false }>): string {
  if (result.kind === 'network') return 'login.errors.networkError';
  if (result.code === 'password_change_required') return 'passkey.errors.passwordChangeRequired';
  return 'passkey.errors.failed';
}

/**
 * Login form component.
 * Handles credential input with browser autofill support (`autocomplete`
 * attributes) so that password managers can offer to fill saved credentials.
 *
 * When the browser supports WebAuthn (and we are not on the platform build),
 * a secondary "sign in with a passkey" button is offered below the password
 * form (C-PK-2). Password sign-in remains the default path; user-cancelled
 * passkey prompts are silent by design.
 *
 * Passkey button visibility rules:
 *  - IS_PLATFORM: button is hidden entirely (platform does not use passkeys).
 *  - Insecure context (window.isSecureContext === false): button is shown but
 *    disabled with a tooltip and hint text explaining that HTTPS is required.
 *    This covers HTTP deployments where browserSupportsWebAuthn() returns false
 *    not because the browser lacks support, but because the context is unsafe.
 *  - Secure context + WebAuthn not supported (rare): button is hidden entirely,
 *    as there is nothing actionable the user can do.
 *  - Secure context + WebAuthn supported: button is shown and active.
 *
 * The "sign in with SSO" button (B-728) appears only once the server is known
 * to have OIDC enabled; it hands the whole page to the server-driven redirect.
 * Password sign-in stays on screen regardless — it is the break-glass path when
 * the identity provider is down or an account is not linked.
 */
export default function LoginForm() {
  const { t } = useTranslation('auth');
  const { login } = useAuth();
  const { isSupported: isPasskeySupported, loginWithPasskey } = useWebAuthn();
  const ssoStatus = useSsoStatus();
  const isSsoAvailable = ssoStatus?.loginAvailable === true;
  // ADR-194 D1: SSO is enforced but cannot sign anyone in right now
  // (`unavailable`, or `paused` on a legacy-env node awaiting import).
  const isSsoUnavailable = ssoStatus?.state === 'unavailable' || ssoStatus?.state === 'paused';
  // Custom branding title (if configured) is interpolated into the description
  // copy (`{{appName}}`) so the login screen never names the stock product.
  const { title: brandingTitle } = useBranding();
  const appName = brandingTitle ?? t('app.title', { ns: 'sidebar', defaultValue: 'ـنسَّاجـ' });

  const [formState, setFormState] = useState<LoginFormState>(initialState);
  // T-1939: a member sent back here after their SSO attestation aged out sees
  // why, once. Read in the initializer (pure), cleared after mount.
  const [errorMessage, setErrorMessage] = useState(
    () => (hasSsoReauthNotice() ? t('login.errors.ssoReauthRequired') : ''),
  );
  useEffect(() => {
    consumeSsoReauthNotice();
  }, []);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isPasskeySubmitting, setIsPasskeySubmitting] = useState(false);
  const [isSsoRedirecting, setIsSsoRedirecting] = useState(false);

  // isSecureContext is a stable browser property — no state needed.
  const isSecureContext = window.isSecureContext;
  // Insecure context (plain HTTP, not localhost): show the button disabled with
  // a hint so users understand why it is unavailable. This is distinct from a
  // browser that genuinely does not implement WebAuthn (where hiding is correct).
  const showPasskeyDisabled = !IS_PLATFORM && !isSecureContext;
  const showPasskeyButton = !IS_PLATFORM && (isPasskeySupported || showPasskeyDisabled);
  const isBusy = isSubmitting || isPasskeySubmitting || isSsoRedirecting;
  const showAlternatives = showPasskeyButton || isSsoAvailable;

  const updateField = useCallback((field: keyof LoginFormState, value: string) => {
    setFormState((previous) => ({ ...previous, [field]: value }));
  }, []);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setErrorMessage('');

      // Keep form validation local so each auth screen owns its own UI feedback.
      if (!formState.username.trim() || !formState.password) {
        setErrorMessage(t('login.errors.requiredFields'));
        return;
      }

      setIsSubmitting(true);
      const result = await login(formState.username.trim(), formState.password);
      if (!result.success) {
        // T-1939: a linked team account signs in through the IdP (SSO button below).
        setErrorMessage(result.code === 'sso_required' ? t('login.errors.ssoRequired') : result.error);
      }
      setIsSubmitting(false);
    },
    [formState.password, formState.username, login, t],
  );

  const handlePasskeyLogin = useCallback(async () => {
    setErrorMessage('');
    setIsPasskeySubmitting(true);
    const result = await loginWithPasskey();
    setIsPasskeySubmitting(false);

    // A dismissed passkey prompt is not an error — stay silent.
    if (!result.success && result.kind !== 'cancelled') {
      setErrorMessage(t(passkeyFailureKey(result)));
    }
  }, [loginWithPasskey, t]);

  // Back from the IdP can restore this page from the back/forward cache with
  // the "redirecting" state still set, which would leave every button disabled.
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        setIsSsoRedirecting(false);
      }
    };
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, []);

  const handleSsoLogin = useCallback(() => {
    setErrorMessage('');
    setIsSsoRedirecting(true);
    startOidcLogin();
  }, []);

  return (
    <AuthScreenLayout
      title={t('login.title')}
      description={t('login.description', { appName })}
      footerText={t('login.footer')}
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <AuthInputField
          id="username"
          label={t('login.username')}
          value={formState.username}
          onChange={(value) => updateField('username', value)}
          placeholder={t('login.placeholders.username')}
          isDisabled={isBusy}
          autoComplete="username"
        />

        <AuthInputField
          id="password"
          label={t('login.password')}
          value={formState.password}
          onChange={(value) => updateField('password', value)}
          placeholder={t('login.placeholders.password')}
          isDisabled={isBusy}
          type="password"
          autoComplete="current-password"
        />

        <AuthErrorAlert errorMessage={errorMessage} />

        <button
          type="submit"
          disabled={isBusy}
          className="w-full rounded-md bg-blue-600 px-4 py-2 font-medium text-white transition-colors duration-200 hover:bg-blue-700 disabled:bg-blue-400"
        >
          {isSubmitting ? t('login.loading') : t('login.submit')}
        </button>

        {showAlternatives && (
          <div className="flex items-center gap-3" aria-hidden>
            <div className="h-px flex-1 bg-border" />
            <span className="text-xs uppercase text-muted-foreground">{t('passkey.divider')}</span>
            <div className="h-px flex-1 bg-border" />
          </div>
        )}

        {isSsoUnavailable && (
          <p role="status" className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 p-3 text-sm text-foreground">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
            {t('sso.unavailableNotice')}
          </p>
        )}

        {isSsoAvailable && (
          <button
            type="button"
            onClick={handleSsoLogin}
            disabled={isBusy}
            aria-busy={isSsoRedirecting || undefined}
            className="flex w-full items-center justify-center gap-2 rounded-md border border-border bg-background px-4 py-2 font-medium text-foreground transition-colors duration-200 hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50"
          >
            <ShieldCheck className="h-4 w-4" aria-hidden />
            {isSsoRedirecting ? t('sso.redirecting') : t('sso.loginButton')}
          </button>
        )}

        {showPasskeyButton && (
          <>
            <button
              type="button"
              onClick={showPasskeyDisabled ? undefined : handlePasskeyLogin}
              disabled={isBusy || showPasskeyDisabled}
              title={showPasskeyDisabled ? t('passkey.requiresSecureContext') : undefined}
              aria-disabled={showPasskeyDisabled || undefined}
              className="flex w-full items-center justify-center gap-2 rounded-md border border-border bg-background px-4 py-2 font-medium text-foreground transition-colors duration-200 hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              <KeyRound className="h-4 w-4" aria-hidden />
              {isPasskeySubmitting ? t('passkey.loginLoading') : t('passkey.loginButton')}
            </button>

            {showPasskeyDisabled && (
              <p className="text-center text-xs text-muted-foreground" role="note">
                {t('passkey.requiresSecureContext')}
              </p>
            )}
          </>
        )}

        {!IS_PLATFORM && (
          <p className="text-center text-xs text-muted-foreground" role="note">
            {t('login.requestAccountHint')}
          </p>
        )}
      </form>
    </AuthScreenLayout>
  );
}

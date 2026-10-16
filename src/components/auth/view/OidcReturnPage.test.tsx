import { StrictMode } from 'react';
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import arAuth from '../../../i18n/locales/ar/auth.json';
import enAuth from '../../../i18n/locales/en/auth.json';
import type { OidcLoginResult } from '../types';

function lookup(tree: unknown, key: string): string | undefined {
  const value = key.split('.').reduce<unknown>(
    (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
    tree,
  );
  return typeof value === 'string' ? value : undefined;
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => lookup(enAuth, key) ?? key }),
}));

const loginWithOidcCode = vi.fn<(code: string) => Promise<OidcLoginResult>>();
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ loginWithOidcCode }),
}));

const startOidcLogin = vi.fn();
vi.mock('../oidc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../oidc')>()),
  startOidcLogin: (...args: unknown[]) => startOidcLogin(...args),
}));

// The real layout reads theme/RTL/branding contexts that are out of scope here.
vi.mock('./AuthScreenLayout', () => ({
  default: ({ title, children }: { title: string; children: ReactNode }) => (
    <main>
      <h1>{title}</h1>
      {children}
    </main>
  ),
}));

import OidcReturnPage from './OidcReturnPage';

let lastLocation = '';
function LocationProbe() {
  const location = useLocation();
  lastLocation = `${location.pathname}${location.search}`;
  return null;
}

function renderAt(url: string) {
  return render(
    <StrictMode>
      <MemoryRouter initialEntries={[url]}>
        <LocationProbe />
        <Routes>
          <Route path="/auth/oidc/return" element={<OidcReturnPage />} />
          <Route path="/" element={<p>app-home</p>} />
        </Routes>
      </MemoryRouter>
    </StrictMode>,
  );
}

beforeEach(() => {
  loginWithOidcCode.mockReset();
  startOidcLogin.mockReset();
  lastLocation = '';
});

afterEach(() => {
  cleanup();
});

describe('OidcReturnPage', () => {
  it('redeems the code exactly once (StrictMode), scrubs it from the URL, and enters the app', async () => {
    loginWithOidcCode.mockResolvedValue({ success: true });
    renderAt('/auth/oidc/return?oidc_code=one-time-code');

    expect(screen.getByRole('status').textContent).toContain(enAuth.sso.return.verifying);
    await screen.findByText('app-home');
    expect(loginWithOidcCode).toHaveBeenCalledTimes(1);
    expect(loginWithOidcCode).toHaveBeenCalledWith('one-time-code');
    expect(lastLocation).toBe('/');
  });

  it('removes the one-time code from the address bar while verifying', async () => {
    loginWithOidcCode.mockReturnValue(new Promise(() => {}));
    renderAt('/auth/oidc/return?oidc_code=one-time-code');
    await waitFor(() => expect(lastLocation).toBe('/auth/oidc/return'));
  });

  it.each([
    ['transaction_expired', enAuth.sso.errors.transactionExpired],
    ['rate_limited', enAuth.sso.errors.rateLimited],
    ['session_failed', enAuth.sso.errors.sessionFailed],
    ['network', enAuth.sso.errors.network],
  ] as const)('names an exchange failure (%s) and offers SSO retry', async (reason, message) => {
    loginWithOidcCode.mockResolvedValue({ success: false, reason });
    renderAt('/auth/oidc/return?oidc_code=stale');

    expect((await screen.findByRole('alert')).textContent).toContain(message);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(enAuth.sso.return.retry) }));
    expect(startOidcLogin).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['access_denied', enAuth.sso.errors.providerDenied],
    ['invalid_state', enAuth.sso.errors.invalidState],
    ['transaction_expired', enAuth.sso.errors.transactionExpired],
    ['rate_limited', enAuth.sso.errors.rateLimited],
    ['something_new', enAuth.sso.errors.providerUnavailable],
  ])('shows a callback error (%s) without calling the exchange', async (error, message) => {
    renderAt(`/auth/oidc/return?error=${error}&oidc_code=ignored`);

    expect((await screen.findByRole('alert')).textContent).toContain(message);
    expect(loginWithOidcCode).not.toHaveBeenCalled();
  });

  it('reports a missing code', async () => {
    renderAt('/auth/oidc/return');
    expect((await screen.findByRole('alert')).textContent).toContain(enAuth.sso.errors.missingCode);
    expect(loginWithOidcCode).not.toHaveBeenCalled();
  });

  it.each([
    ['oidc_not_linked', enAuth.sso.errors.notLinked],
    ['oidc_not_authorized', enAuth.sso.errors.notAuthorized],
    ['oidc_account_exists', enAuth.sso.errors.accountExists],
  ])('names a server login refusal (%s) without retry or exchange', async (error, message) => {
    renderAt(`/auth/oidc/return?error=${error}`);

    expect((await screen.findByRole('alert')).textContent).toContain(message);
    expect(screen.queryByRole('button', { name: new RegExp(enAuth.sso.return.retry) })).toBeNull();
    expect(screen.getByRole('button', { name: enAuth.sso.return.backToLogin })).toBeTruthy();
    expect(loginWithOidcCode).not.toHaveBeenCalled();
  });

  it('tells a clashing account to sign in and link SSO from the profile, in Arabic too', () => {
    expect(arAuth.sso.errors.accountExists).toContain('سجّل الدخول بحسابك ثم اربط مزوّد الهوية من ملفك');
  });

  it('hides SSO retry when only an administrator can fix it, keeping password sign-in', async () => {
    loginWithOidcCode.mockResolvedValue({ success: false, reason: 'not_linked' });
    renderAt('/auth/oidc/return?oidc_code=unlinked');

    expect((await screen.findByRole('alert')).textContent).toContain(enAuth.sso.errors.notLinked);
    expect(screen.queryByRole('button', { name: new RegExp(enAuth.sso.return.retry) })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: enAuth.sso.return.backToLogin }));
    await screen.findByText('app-home');
  });
});

describe('ADR-194 A1 owner refusals', () => {
  beforeEach(() => window.localStorage.clear());

  it.each([
    ['owner_sso_key_required', enAuth.sso.errors.ownerKeyRequired],
    ['owner_sso_reauth_required', enAuth.sso.errors.ownerReauthRequired],
  ])('offers a passkey re-authentication for %s', async (error, message) => {
    renderAt(`/auth/oidc/return?error=${error}`);
    expect((await screen.findByRole('alert')).textContent).toContain(message);
    expect(screen.queryByRole('button', { name: new RegExp(enAuth.sso.return.retry) })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: enAuth.sso.return.reauthWithPasskey }));
    expect(startOidcLogin).toHaveBeenCalledWith(true);
  });

  it.each([
    ['owner_must_sign_in_locally', enAuth.sso.errors.ownerLocalOnly],
    ['password_change_required', enAuth.sso.errors.passwordChangeRequired],
    ['sso_unavailable', enAuth.sso.errors.ssoUnavailable],
  ])('names %s with password sign-in and no SSO retry', async (error, message) => {
    renderAt(`/auth/oidc/return?error=${error}`);
    expect((await screen.findByRole('alert')).textContent).toContain(message);
    expect(screen.queryByRole('button', { name: new RegExp(enAuth.sso.return.retry) })).toBeNull();
    expect(screen.queryByRole('button', { name: enAuth.sso.return.reauthWithPasskey })).toBeNull();
    expect(screen.getByRole('button', { name: enAuth.sso.return.backToLogin })).toBeTruthy();
  });

  it.each([
    ['oidc_config_changed', enAuth.sso.errors.configChanged],
    ['oidc_login_not_initiated', enAuth.sso.errors.loginNotInitiated],
  ])('names %s and offers a plain SSO retry', async (error, message) => {
    renderAt(`/auth/oidc/return?error=${error}`);
    expect((await screen.findByRole('alert')).textContent).toContain(message);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(enAuth.sso.return.retry) }));
    expect(startOidcLogin).toHaveBeenCalledWith();
  });

  it('owner_must_sign_in_locally clears the re-authentication hint; other refusals keep it', async () => {
    window.localStorage.setItem('nassaj.sso.reauthHint', '1');
    renderAt('/auth/oidc/return?error=owner_sso_reauth_required');
    await screen.findByRole('alert');
    expect(window.localStorage.getItem('nassaj.sso.reauthHint')).toBe('1');
    cleanup();
    renderAt('/auth/oidc/return?error=owner_must_sign_in_locally');
    await screen.findByRole('alert');
    expect(window.localStorage.getItem('nassaj.sso.reauthHint')).toBeNull();
  });

  it('ships the owner strings in Arabic', () => {
    expect(arAuth.sso.return.reauthWithPasskey).toContain('مفتاح المرور');
    expect(arAuth.sso.errors.ownerKeyRequired).toMatch(/\S/);
    expect(arAuth.sso.errors.ownerReauthRequired).toMatch(/\S/);
    expect(arAuth.sso.errors.ownerLocalOnly).toMatch(/\S/);
  });
});

describe('SSO locale parity', () => {
  it('ships every SSO string in Arabic and English', () => {
    const keysOf = (node: unknown, prefix = ''): string[] =>
      Object.entries(node as Record<string, unknown>).flatMap(([key, value]) =>
        value && typeof value === 'object' ? keysOf(value, `${prefix}${key}.`) : [`${prefix}${key}`],
      );
    const enKeys = keysOf(enAuth.sso).sort();
    expect(keysOf(arAuth.sso).sort()).toEqual(enKeys);
    for (const key of enKeys) {
      expect(lookup(arAuth.sso, key)).toMatch(/\S/);
    }
  });
});

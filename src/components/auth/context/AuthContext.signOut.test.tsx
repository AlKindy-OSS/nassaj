// T-2035 (ADR-212): sign-out must reach the server WITH the token it ends
// (qa critical: clearSession ran first, so the request left without
// Authorization and the epoch was never bumped), and a throttle lock is a
// form error carrying its wait — never a session failure.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';

import { AUTH_TOKEN_STORAGE_KEY } from '../constants';
import { SIGNED_OUT_EVERYWHERE_NOTICE_KEY } from '../loginLock';
import type { AuthActionResult } from '../types';

import { AuthProvider, useAuth } from './AuthContext';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

function installFetch(extra: Handler = () => json({})) {
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/auth/status')) return json({ needsSetup: false });
    if (url.endsWith('/api/auth/user')) {
      return json({ user: { id: 7, username: 'member', role: 'user', status: 'active' }, isMultiUser: false });
    }
    if (url.includes('/api/user/onboarding-status')) return json({ hasCompletedOnboarding: true });
    return extra(url, init);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

let auth: ReturnType<typeof useAuth> | null = null;
function Probe() {
  auth = useAuth();
  return <span data-testid="token">{auth.token ?? 'null'}</span>;
}

async function renderProvider() {
  render(<AuthProvider><Probe /></AuthProvider>);
  await waitFor(() => expect(auth?.isLoading).toBe(false));
}

const logoutCall = (fetchMock: ReturnType<typeof installFetch>) =>
  fetchMock.mock.calls.find(([url]) => String(url).endsWith('/api/auth/logout'));

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  auth = null;
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AuthProvider sign-out (T-2035)', () => {
  it('sends the captured token on /logout even though the session is cleared first', async () => {
    localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, 'token-synthetic');
    const fetchMock = installFetch((url) => (url.endsWith('/api/auth/logout')
      ? json({ success: true, scope: 'all' }) : json({})));
    await renderProvider();
    expect(screen.getByTestId('token').textContent).toBe('token-synthetic');

    await act(async () => { auth!.logout(); });

    expect(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).toBeNull();
    expect(screen.getByTestId('token').textContent).toBe('null');
    const call = logoutCall(fetchMock);
    expect(call).toBeTruthy();
    const headers = new Headers(call![1]?.headers);
    expect(headers.get('Authorization')).toBe('Bearer token-synthetic');
    expect(call![1]?.method).toBe('POST');
    await waitFor(() => expect(sessionStorage.getItem(SIGNED_OUT_EVERYWHERE_NOTICE_KEY)).toBe('1'));
  });

  it('a normal (device) sign-out sends the token and shows no "signed out everywhere" notice', async () => {
    localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, 'token-synthetic');
    const fetchMock = installFetch((url) => (url.endsWith('/api/auth/logout')
      ? json({ success: true, scope: 'device' }) : json({})));
    await renderProvider();
    await act(async () => { auth!.logout(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(new Headers(logoutCall(fetchMock)![1]?.headers).get('Authorization')).toBe('Bearer token-synthetic');
    expect(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).toBeNull();
    expect(sessionStorage.getItem(SIGNED_OUT_EVERYWHERE_NOTICE_KEY)).toBeNull();
  });

  it('leaves no "signed out everywhere" notice when the server did not confirm scope all', async () => {
    localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, 'token-synthetic');
    installFetch((url) => (url.endsWith('/api/auth/logout') ? json({ error: 'x' }, 500) : json({})));
    await renderProvider();
    await act(async () => { auth!.logout(); });
    await act(async () => { await Promise.resolve(); });
    expect(sessionStorage.getItem(SIGNED_OUT_EVERYWHERE_NOTICE_KEY)).toBeNull();
  });
});

describe('AuthProvider sign-out in wallet mode (ADR-194 A3)', () => {
  it('a bearer tab ends its bearer session even when wallet mode is on, never the wallet', async () => {
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/api/auth/status')) return json({ needsSetup: false, deviceAccountSessionsEnabled: true });
      if (url.endsWith('/api/auth/user')) {
        return json({ user: { id: 7, username: 'member', role: 'user', status: 'active' }, isMultiUser: true });
      }
      if (url.includes('/api/user/onboarding-status')) return json({ hasCompletedOnboarding: true });
      if (url.endsWith('/api/auth/logout')) return json({ success: true, scope: 'device' });
      return json({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);
    await renderProvider();
    expect(auth!.deviceAccountSessionsEnabled).toBe(true);
    expect(screen.getByTestId('token').textContent).toBe('null');
    // A bearer written after mount (another tab's sign-in) outranks the cookie.
    localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, 'token-bearer');
    const walletReads = () => fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/auth/accounts')).length;
    const readsBefore = walletReads();

    await act(async () => { auth!.logout(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    const call = logoutCall(fetchMock as unknown as ReturnType<typeof installFetch>);
    expect(call).toBeTruthy();
    expect(new Headers(call![1]?.headers).get('Authorization')).toBe('Bearer token-bearer');
    expect(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).toBeNull();
    expect(auth!.user).toBeNull();
    expect(walletReads()).toBe(readsBefore);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/auth/logout'))).toHaveLength(1);
  });
});

describe('AuthProvider SSO sign-out (ADR-H20 N1/N4)', () => {
  it('an SSO sign-out goes on to the IdP end_session URL and marks the explicit sign-out', async () => {
    localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, 'token-synthetic');
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    installFetch((url) => (url.endsWith('/api/auth/logout')
      ? json({ success: true, scope: 'device', endSessionUrl: 'https://id.example/oidc/v1/end_session?client_id=c' })
      : json({})));
    await renderProvider();
    await act(async () => { auth!.logout(); });
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://id.example/oidc/v1/end_session?client_id=c'));
    expect(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem('nassaj:sso-explicit-sign-out')).not.toBeNull();
  });

  it('a password sign-out (no endSessionUrl) stays local', async () => {
    localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, 'token-synthetic');
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    installFetch((url) => (url.endsWith('/api/auth/logout') ? json({ success: true, scope: 'device' }) : json({})));
    await renderProvider();
    await act(async () => { auth!.logout(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(assign).not.toHaveBeenCalled();
  });
});

describe('AuthProvider login lock (T-2035)', () => {
  it('maps a 429 login_temporarily_locked to a coded result with the wait, without signing out', async () => {
    installFetch((url) => (url.endsWith('/api/auth/login')
      ? json({ error: 'locked', code: 'login_temporarily_locked', retryAfterSeconds: 90 }, 429, { 'Retry-After': '90' })
      : json({})));
    const onUnauthorized = vi.fn();
    window.addEventListener('auth:unauthorized', onUnauthorized);
    try {
      await renderProvider();
      let result: AuthActionResult | null = null;
      await act(async () => { result = await auth!.login('member', 'wrong'); });
      expect(result).toEqual({
        success: false, error: 'locked', code: 'login_temporarily_locked', retryAfterSeconds: 90,
      });
    } finally {
      window.removeEventListener('auth:unauthorized', onUnauthorized);
    }
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('maps a locked password change the same way and keeps the session', async () => {
    localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, 'token-synthetic');
    installFetch((url) => (url.endsWith('/api/auth/me/password')
      ? json({ error: 'locked', code: 'login_temporarily_locked', retryAfterSeconds: 30 }, 429)
      : json({})));
    await renderProvider();
    let result: AuthActionResult | null = null;
    await act(async () => { result = await auth!.changePassword('wrong', 'another long password'); });
    expect(result).toMatchObject({ success: false, code: 'login_temporarily_locked', retryAfterSeconds: 30 });
    expect(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).toBe('token-synthetic');
  });
});

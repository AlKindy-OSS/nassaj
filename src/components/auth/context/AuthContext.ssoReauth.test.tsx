// T-1939 slice 3: a 401 `sso_reauth_required` makes AuthProvider drop the
// refused token and restart SSO — not the `auth:unauthorized` logout loop.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

import { AUTH_TOKEN_STORAGE_KEY } from '../constants';
import {
  resetSsoRedirectInFlight, SSO_REAUTH_EVENT, SSO_REAUTH_NOTICE_KEY, SSO_REAUTH_REDIRECT_AT_KEY,
} from '../ssoReauth';

import { AuthProvider, useAuth } from './AuthContext';

const oidcMock = vi.hoisted(() => ({ start: vi.fn() }));
// Every fallback navigation to the login page goes through shareLoginPath; jsdom
// cannot observe a path navigation, so the call count stands in for it.
const loginPathMock = vi.hoisted(() => ({ calls: vi.fn() }));
vi.mock('../../document-sharing/share-navigation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../document-sharing/share-navigation')>();
  return {
    ...actual,
    shareLoginPath: (pathname: string) => {
      loginPathMock.calls(pathname);
      return actual.shareLoginPath(pathname);
    },
  };
});
vi.mock('../oidc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../oidc')>()),
  startOidcLogin: () => oidcMock.start(),
}));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function installFetch() {
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes('/api/auth/status')) return json({ needsSetup: false });
    if (url.includes('/api/auth/user')) {
      return json({ error: 'Sign in again through SSO', code: 'sso_reauth_required' }, 401);
    }
    return json({});
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function Probe() {
  const { token, isLoading } = useAuth();
  return (
    <div>
      <span data-testid="token">{token ?? 'null'}</span>
      <span data-testid="loading">{String(isLoading)}</span>
    </div>
  );
}

async function renderProvider() {
  render(<AuthProvider><Probe /></AuthProvider>);
  await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'));
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  oidcMock.start.mockReset();
  loginPathMock.calls.mockReset();
  resetSsoRedirectInFlight();
  window.history.replaceState({}, '', '/login');
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AuthProvider on sso_reauth_required', () => {
  it('clears the refused token and starts SSO once, without auth:unauthorized or a refresh', async () => {
    localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, 'token-synthetic');
    const fetchMock = installFetch();
    const onUnauthorized = vi.fn();
    window.addEventListener('auth:unauthorized', onUnauthorized);
    try {
      await renderProvider();
      await waitFor(() => expect(oidcMock.start).toHaveBeenCalledTimes(1));
    } finally {
      window.removeEventListener('auth:unauthorized', onUnauthorized);
    }
    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).toBeNull();
    expect(screen.getByTestId('token').textContent).toBe('null');
    expect(sessionStorage.getItem(SSO_REAUTH_NOTICE_KEY)).toBe('1');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/auth/refresh'))).toBe(false);
  });

  it('an IdP bounce inside the cooldown stays on /login with the notice (no redirect loop)', async () => {
    localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, 'token-synthetic');
    sessionStorage.setItem(SSO_REAUTH_REDIRECT_AT_KEY, String(Date.now()));
    installFetch();
    await renderProvider();
    await waitFor(() => expect(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).toBeNull());
    expect(oidcMock.start).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(SSO_REAUTH_NOTICE_KEY)).toBe('1');
    expect(window.location.pathname).toBe('/login');
  });

  it('a burst of refusals in one task navigates exactly once, to the SSO login', async () => {
    installFetch();
    await renderProvider();
    window.history.replaceState({}, '', '/projects/p1');
    const onUnauthorized = vi.fn();
    window.addEventListener('auth:unauthorized', onUnauthorized);
    try {
      // Cookie-session path (no bearer token) — both events in the same task.
      window.dispatchEvent(new CustomEvent(SSO_REAUTH_EVENT, { detail: { token: null } }));
      window.dispatchEvent(new CustomEvent(SSO_REAUTH_EVENT, { detail: { token: null } }));
      window.dispatchEvent(new CustomEvent('auth:unauthorized', { detail: { token: null } }));
    } finally {
      window.removeEventListener('auth:unauthorized', onUnauthorized);
    }
    expect(oidcMock.start).toHaveBeenCalledTimes(1);
    expect(loginPathMock.calls).not.toHaveBeenCalled();
  });
});

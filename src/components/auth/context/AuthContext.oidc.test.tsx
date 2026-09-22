import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AUTH_TOKEN_STORAGE_KEY } from '../constants';
import type { AuthContextValue } from '../types';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const apiMock = vi.hoisted(() => ({
  exchange: vi.fn<(code: string) => Promise<Response>>(),
  onboardingStatus: vi.fn<() => Promise<Response>>(),
}));

vi.mock('../../../utils/api', () => ({
  api: {
    auth: {
      status: async () => json({ needsSetup: false }),
      user: async () => json({}, 401),
      refresh: async () => null,
      logout: async () => json({}),
      oidc: { exchange: apiMock.exchange },
    },
    user: { onboardingStatus: apiMock.onboardingStatus },
  },
}));
vi.mock('../../../preferences/preferencesSync', () => ({
  hydratePreferencesFromServer: async () => undefined,
}));
vi.mock('../../chat/utils/messageOutbox', () => ({
  clearOutbox: () => undefined,
  setOutboxUser: () => undefined,
}));
vi.mock('../../chat/hooks/useOutboxDurableRecovery', () => ({
  useOutboxDurableRecovery: () => undefined,
}));

import { AuthProvider, useAuth } from './AuthContext';

let auth: AuthContextValue | null = null;
function Capture() {
  auth = useAuth();
  return null;
}

async function mountProvider() {
  render(
    <AuthProvider>
      <Capture />
    </AuthProvider>,
  );
  await waitFor(() => expect(auth?.isLoading).toBe(false));
}

const identityFetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

beforeEach(() => {
  localStorage.clear();
  auth = null;
  apiMock.exchange.mockReset();
  apiMock.onboardingStatus.mockReset().mockResolvedValue(json({ hasCompletedOnboarding: true }));
  identityFetch.mockReset();
  vi.stubGlobal('fetch', identityFetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AuthContext.loginWithOidcCode', () => {
  it('stores the exchanged token through the normal session path and hydrates the user', async () => {
    apiMock.exchange.mockResolvedValue(json({ token: 'jwt-synthetic', userId: 12 }));
    identityFetch.mockResolvedValue(
      json({ user: { id: 12, username: 'linked', role: 'user', mustChangePassword: true }, isMultiUser: true }),
    );
    await mountProvider();

    let result: Awaited<ReturnType<AuthContextValue['loginWithOidcCode']>> | undefined;
    await act(async () => {
      result = await auth!.loginWithOidcCode('one-time');
    });

    expect(result).toEqual({ success: true });
    expect(apiMock.exchange).toHaveBeenCalledWith('one-time');
    expect(identityFetch).toHaveBeenCalledWith('/api/auth/user', {
      headers: { Authorization: 'Bearer jwt-synthetic' },
    });
    expect(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).toBe('jwt-synthetic');
    expect(auth!.token).toBe('jwt-synthetic');
    expect(auth!.user?.username).toBe('linked');
    // The forced password-change gate engages exactly as after a password login.
    expect(auth!.mustChangePassword).toBe(true);
    expect(auth!.isMultiUser).toBe(true);
    expect(apiMock.onboardingStatus).toHaveBeenCalled();
  });

  it('leaves storage untouched when the code is rejected', async () => {
    apiMock.exchange.mockResolvedValue(json({ error: 'Invalid or expired code' }, 401));
    await mountProvider();

    let result: Awaited<ReturnType<AuthContextValue['loginWithOidcCode']>> | undefined;
    await act(async () => {
      result = await auth!.loginWithOidcCode('stale');
    });

    expect(result).toEqual({ success: false, reason: 'transaction_expired' });
    expect(identityFetch).not.toHaveBeenCalled();
    expect(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).toBeNull();
    expect(auth!.user).toBeNull();
  });

  it('never persists a token whose identity cannot be loaded', async () => {
    apiMock.exchange.mockResolvedValue(json({ token: 'jwt-unusable', userId: 12 }));
    identityFetch.mockResolvedValue(json({ error: 'Token invalidated' }, 401));
    await mountProvider();

    let result: Awaited<ReturnType<AuthContextValue['loginWithOidcCode']>> | undefined;
    await act(async () => {
      result = await auth!.loginWithOidcCode('one-time');
    });

    expect(result).toEqual({ success: false, reason: 'session_failed' });
    expect(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).toBeNull();
    expect(auth!.token).toBeNull();
  });
});

import { act, cleanup, render, waitFor } from '@testing-library/react';
import type { AuthenticationResponseJSON } from '@simplewebauthn/browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AUTH_TOKEN_STORAGE_KEY } from '../constants';
import type { AuthContextValue } from '../types';

// Passkey sign-in answers (server/routes/webauthn.js POST /login/verify): the
// legacy JWT contract with MULTI_ACCOUNT_SWITCHING off, and the wallet contract
// (device cookie, no token) with it on — ADR-163 amendment 1, slice A.

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const apiMock = vi.hoisted(() => ({
  loginVerify: vi.fn<(assertion: unknown) => Promise<Response>>(),
  user: vi.fn<() => Promise<Response>>(),
  onboardingStatus: vi.fn<() => Promise<Response>>(),
  cookieKinds: [] as string[],
}));

vi.mock('../../../utils/api', () => ({
  api: {
    auth: {
      status: async () => json({ needsSetup: false }),
      user: apiMock.user,
      refresh: async () => null,
      logout: async () => json({}),
      webauthn: { loginVerify: apiMock.loginVerify },
    },
    user: { onboardingStatus: apiMock.onboardingStatus },
  },
  setCookieSessionKind: (kind: string) => {
    apiMock.cookieKinds.push(kind);
  },
}));
vi.mock('../../../preferences/preferencesSync', () => ({
  hydratePreferencesFromServer: async () => undefined,
  setPreferenceIdentityAuthenticated: () => undefined,
}));
vi.mock('../../chat/utils/messageOutbox', () => ({
  clearOutbox: () => undefined,
  setOutboxUser: () => undefined,
}));
vi.mock('../../chat/hooks/useOutboxDurableRecovery', () => ({
  useOutboxDurableRecovery: () => undefined,
}));

import { AuthProvider, useAuth } from './AuthContext';

const assertion = { id: 'cred', rawId: 'cred', type: 'public-key' } as unknown as AuthenticationResponseJSON;
const member = { id: 7, username: 'member', role: 'user' };
const wallet = {
  generation: 1,
  activeSlotId: 'slot-a',
  accounts: [{ slotId: 'slot-a', displayName: 'member', isActive: true, lastUsedAt: 1 }],
};

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

async function signInWithPasskey() {
  let result: Awaited<ReturnType<AuthContextValue['loginWithPasskey']>> | undefined;
  await act(async () => {
    result = await auth!.loginWithPasskey(assertion);
  });
  return result;
}

beforeEach(() => {
  localStorage.clear();
  auth = null;
  apiMock.cookieKinds.length = 0;
  apiMock.loginVerify.mockReset();
  apiMock.user.mockReset().mockResolvedValue(json({}, 401));
  apiMock.onboardingStatus.mockReset().mockResolvedValue(json({ hasCompletedOnboarding: true }));
});

afterEach(() => {
  cleanup();
});

describe('AuthContext.loginWithPasskey', () => {
  it('flag off: stores the legacy JWT exactly as before', async () => {
    apiMock.loginVerify.mockResolvedValue(json({ success: true, user: member, token: 'jwt-passkey' }));
    await mountProvider();
    apiMock.user.mockResolvedValue(json({ user: member, isMultiUser: false }));

    expect(await signInWithPasskey()).toEqual({ success: true });
    expect(apiMock.loginVerify).toHaveBeenCalledWith(assertion);
    expect(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).toBe('jwt-passkey');
    expect(auth!.token).toBe('jwt-passkey');
    expect(auth!.user?.username).toBe('member');
    expect(auth!.deviceAccountSessionsEnabled).toBe(false);
    expect(apiMock.cookieKinds.at(-1)).toBe('none');
  });

  it('wallet mode: adopts the device cookie session like the password path', async () => {
    localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, 'jwt-stale');
    await mountProvider();
    apiMock.loginVerify.mockResolvedValue(
      json({ success: true, user: member, wallet, csrfToken: 'csrf-synthetic' }),
    );
    apiMock.user.mockResolvedValue(json({ user: member, isMultiUser: true }));

    expect(await signInWithPasskey()).toEqual({ success: true });
    expect(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).toBeNull();
    expect(auth!.token).toBeNull();
    expect(auth!.user?.username).toBe('member');
    expect(auth!.deviceAccountSessionsEnabled).toBe(true);
    expect(auth!.isMultiUser).toBe(true);
    expect(apiMock.cookieKinds.at(-1)).toBe('device');
    expect(apiMock.onboardingStatus).toHaveBeenCalled();
  });

  it('wallet mode: surfaces password_change_required without a session', async () => {
    await mountProvider();
    apiMock.loginVerify.mockResolvedValue(json(
      { error: 'Sign in with your password to change it', code: 'password_change_required' },
      403,
    ));

    expect(await signInWithPasskey()).toEqual({
      success: false,
      error: 'Sign in with your password to change it',
      code: 'password_change_required',
    });
    expect(auth!.user).toBeNull();
    expect(auth!.token).toBeNull();
    expect(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).toBeNull();
  });

  it('wallet mode: an origin refusal is a plain failure with its code', async () => {
    await mountProvider();
    apiMock.loginVerify.mockResolvedValue(json({ error: 'Request rejected', code: 'origin_rejected' }, 403));

    const result = await signInWithPasskey();
    expect(result).toMatchObject({ success: false, code: 'origin_rejected' });
    expect(auth!.user).toBeNull();
  });

  it('rejects a 200 that carries neither a token nor a wallet', async () => {
    await mountProvider();
    apiMock.loginVerify.mockResolvedValue(json({ success: true, user: member }));

    expect(await signInWithPasskey()).toMatchObject({ success: false });
    expect(auth!.user).toBeNull();
  });
});

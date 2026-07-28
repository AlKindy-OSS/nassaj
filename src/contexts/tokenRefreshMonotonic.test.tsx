/**
 * اختبارات الرتابة الزمنية B-163 — كاتب monotonic وتبنٍّ monotonic.
 *
 * يثبت:
 *   (1) applyRefreshedToken (api.js): لا تكتب ولا تُطلق حدثاً إذا كان التوكن
 *       القادم أقدم من أو مساوٍ للمخزون (بمقارنة exp)؛ تكتب وتُطلق حدثاً
 *       واحداً فقط إذا كان أحدث فعلياً؛ تتجاهل التوكن المطابق حرفياً.
 *   (2) AuthContext/AuthProvider: لا يتبنّى توكناً أقدم من التوكن الحالي في
 *       الحالة؛ حدثان بنفس التوكن لا يُحدثان تبدّلاً ثانياً.
 *
 * الاختبارات تستدعي دوال الإنتاج نفسها (applyRefreshedToken / AuthProvider) —
 * لا محاكاة للمنطق الداخلي. تشترك في بُناة JWT من tokenRefreshProactive.test.tsx
 * (معرَّفة محلياً لتجنّب الاعتماد المتبادل بين ملفات الاختبار).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';

import { AuthProvider, useAuth } from '../components/auth/context/AuthContext';
import { AUTH_TOKEN_STORAGE_KEY } from '../components/auth/constants';
import { applyRefreshedToken } from '../utils/api';

// ---------------------------------------------------------------------------
// JWT builders (base64url payload only — header/signature are placeholders).
// ---------------------------------------------------------------------------

const nowSec = () => Math.floor(Date.now() / 1000);
const SEVEN_DAYS_SEC = 7 * 24 * 60 * 60;

const base64url = (obj: object): string =>
  btoa(JSON.stringify(obj))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

/** Build a JWT with explicit iat/exp (seconds). */
const makeJwt = (iat: number, exp: number): string =>
  `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url({ iat, exp, userId: 1, username: 'tester', role: 'user' })}.sig`;

/** freshly issued (iat=now, exp=now+7d) */
const freshToken = (): string => makeJwt(nowSec(), nowSec() + SEVEN_DAYS_SEC);

/** issued 4 days ago (past half-life, not expired) */
const staleToken = (): string => {
  const iat = nowSec() - 4 * 24 * 60 * 60;
  return makeJwt(iat, iat + SEVEN_DAYS_SEC);
};

// ---------------------------------------------------------------------------
// Minimal fetch stub — routes AuthProvider bootstrap calls so mount-time
// auth checks never wipe the token under test.
// ---------------------------------------------------------------------------

type MockResponse = {
  ok: boolean;
  status: number;
  headers: { get: (name: string) => string | null };
  json: () => Promise<unknown>;
};

const makeResponse = (body: unknown, ok = true, status = 200): MockResponse => ({
  ok,
  status,
  headers: { get: () => null },
  json: async () => body,
});

function installFetchStub() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown): Promise<MockResponse> => {
      const url = String(input);
      if (url.includes('/api/auth/status')) return makeResponse({ needsSetup: false });
      if (url.includes('/api/auth/user') || url.includes('/api/auth/me')) {
        return makeResponse({ user: { id: 1, username: 'tester', role: 'user' } });
      }
      if (url.includes('/api/user/onboarding-status')) {
        return makeResponse({ hasCompletedOnboarding: true });
      }
      return makeResponse({ preferences: {} });
    }),
  );
}

// ---------------------------------------------------------------------------
// Test helper — renders AuthProvider + a token probe, waits for boot.
// ---------------------------------------------------------------------------

function TokenProbe() {
  const { token, isLoading } = useAuth();
  return (
    <div>
      <span data-testid="token">{token ?? 'null'}</span>
      <span data-testid="loading">{String(isLoading)}</span>
    </div>
  );
}

async function renderAuthProbe() {
  render(
    <AuthProvider>
      <TokenProbe />
    </AuthProvider>,
  );
  await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'));
}

const tokenText = () => screen.getByTestId('token').textContent;

const TOKEN_REFRESH_EVENT = 'auth:token-refreshed';

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, '', '/');
  installFetchStub();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ===========================================================================
// Section 1 — applyRefreshedToken: monotonic write (B-163)
// ===========================================================================

describe('MK-1 — applyRefreshedToken: identical token string is a no-op', () => {
  it('does not write to localStorage and does not dispatch an event', () => {
    const tok = 'some-opaque-token';
    localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, tok);

    const events: string[] = [];
    const listener = (e: Event) => {
      const detail = (e as CustomEvent<{ token?: string }>).detail;
      if (detail?.token) events.push(detail.token);
    };
    window.addEventListener(TOKEN_REFRESH_EVENT, listener);
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');

    try {
      applyRefreshedToken(tok); // same string as stored
    } finally {
      window.removeEventListener(TOKEN_REFRESH_EVENT, listener);
    }

    expect(events).toHaveLength(0);
    // setItem must NOT have been called for the auth token key
    expect(
      setItemSpy.mock.calls.filter(([k]) => k === AUTH_TOKEN_STORAGE_KEY),
    ).toHaveLength(0);
  });
});

describe('MK-2 — applyRefreshedToken: token with strictly older exp is ignored', () => {
  it('does not write and does not dispatch when incoming exp < stored exp', () => {
    const newerExp = nowSec() + SEVEN_DAYS_SEC;       // stored: newer
    const olderExp = newerExp - 3600;                  // incoming: 1 h older

    const storedJwt = makeJwt(nowSec() - 1000, newerExp);
    const olderJwt = makeJwt(nowSec() - 4000, olderExp);
    localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, storedJwt);

    const events: string[] = [];
    const listener = (e: Event) => {
      const detail = (e as CustomEvent<{ token?: string }>).detail;
      if (detail?.token) events.push(detail.token);
    };
    window.addEventListener(TOKEN_REFRESH_EVENT, listener);
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');

    try {
      applyRefreshedToken(olderJwt);
    } finally {
      window.removeEventListener(TOKEN_REFRESH_EVENT, listener);
    }

    expect(events).toHaveLength(0);
    expect(
      setItemSpy.mock.calls.filter(([k]) => k === AUTH_TOKEN_STORAGE_KEY),
    ).toHaveLength(0);
    // localStorage still holds the newer token
    expect(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).toBe(storedJwt);
  });

  it('does not write and does not dispatch when incoming exp === stored exp (same second)', () => {
    const sharedExp = nowSec() + SEVEN_DAYS_SEC;

    const storedJwt = makeJwt(nowSec() - 1000, sharedExp);
    const sameExpJwt = makeJwt(nowSec() - 500, sharedExp); // different iat, same exp
    localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, storedJwt);

    const events: string[] = [];
    const listener = (e: Event) => {
      const detail = (e as CustomEvent<{ token?: string }>).detail;
      if (detail?.token) events.push(detail.token);
    };
    window.addEventListener(TOKEN_REFRESH_EVENT, listener);

    try {
      applyRefreshedToken(sameExpJwt);
    } finally {
      window.removeEventListener(TOKEN_REFRESH_EVENT, listener);
    }

    expect(events).toHaveLength(0);
    expect(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).toBe(storedJwt);
  });
});

describe('MK-3 — applyRefreshedToken: strictly newer token writes and dispatches once', () => {
  it('writes to localStorage and fires exactly one event when exp is strictly newer', () => {
    const storedJwt = staleToken();          // exp ≈ now + 3 days
    const newerJwt = freshToken();           // exp ≈ now + 7 days
    localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, storedJwt);

    const events: string[] = [];
    const listener = (e: Event) => {
      const detail = (e as CustomEvent<{ token?: string }>).detail;
      if (detail?.token) events.push(detail.token);
    };
    window.addEventListener(TOKEN_REFRESH_EVENT, listener);

    try {
      applyRefreshedToken(newerJwt);
    } finally {
      window.removeEventListener(TOKEN_REFRESH_EVENT, listener);
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toBe(newerJwt);
    expect(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).toBe(newerJwt);
  });
});

describe('MK-4 — applyRefreshedToken: fail-open when either token is not a valid JWT', () => {
  it('always writes when stored token is a non-JWT opaque string', () => {
    // Stored: opaque string with no decodable exp.
    // Incoming: also opaque but different — must still be written (fail-open).
    localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, 'opaque-token-old');

    const events: string[] = [];
    const listener = (e: Event) => {
      const detail = (e as CustomEvent<{ token?: string }>).detail;
      if (detail?.token) events.push(detail.token);
    };
    window.addEventListener(TOKEN_REFRESH_EVENT, listener);

    try {
      applyRefreshedToken('opaque-token-new');
    } finally {
      window.removeEventListener(TOKEN_REFRESH_EVENT, listener);
    }

    // Guard fails open (null exp on both sides) → write proceeds.
    expect(events).toHaveLength(1);
    expect(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).toBe('opaque-token-new');
  });

  it('writes when stored token is a valid JWT but incoming token has no exp', () => {
    // If only one side is decodable, fail-open and allow the write.
    localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, freshToken());

    const events: string[] = [];
    const listener = (e: Event) => {
      const detail = (e as CustomEvent<{ token?: string }>).detail;
      if (detail?.token) events.push(detail.token);
    };
    window.addEventListener(TOKEN_REFRESH_EVENT, listener);

    try {
      applyRefreshedToken('not-a-jwt');
    } finally {
      window.removeEventListener(TOKEN_REFRESH_EVENT, listener);
    }

    expect(events).toHaveLength(1);
    expect(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).toBe('not-a-jwt');
  });
});

// ===========================================================================
// Section 2 — AuthProvider: monotonic adoption (B-163 defense-in-depth)
// ===========================================================================

describe('MA-1 — AuthProvider: two events with same token trigger only one state adoption', () => {
  it('dispatching auth:token-refreshed twice with same string leaves state correct and idempotent', async () => {
    localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, freshToken()); // pre-seed a valid session
    await renderAuthProbe();

    const TOKEN = freshToken();

    // First event — new value relative to current state (null initially).
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(TOKEN_REFRESH_EVENT, { detail: { token: TOKEN } }),
      );
    });
    await waitFor(() => expect(tokenText()).toBe(TOKEN));

    // Spy AFTER first adoption — ensures second event causes no additional write.
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');

    // Second event — identical string: setToken updater returns `current`.
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(TOKEN_REFRESH_EVENT, { detail: { token: TOKEN } }),
      );
    });

    // State is still the same token.
    expect(tokenText()).toBe(TOKEN);
    // persistToken IS called (it's outside the updater), but the updater must
    // not change state. We cannot directly count setToken calls, but we can
    // confirm the DOM value is stable.
    // The auth key write from persistToken is idempotent.
    const authWrites = setItemSpy.mock.calls.filter(([k]) => k === AUTH_TOKEN_STORAGE_KEY);
    // At most 1 write from persistToken — same value as already stored.
    expect(authWrites.length).toBeLessThanOrEqual(1);
  });
});

describe('MA-2 — AuthProvider: older-exp token event does not regress state', () => {
  it('state stays at newer token after an event carrying an older JWT', async () => {
    await renderAuthProbe();
    expect(tokenText()).toBe('null');

    const olderExp = nowSec() + 3 * 24 * 60 * 60; // +3 days
    const newerExp = nowSec() + SEVEN_DAYS_SEC;    // +7 days

    const olderJwt = makeJwt(nowSec() - 4 * 24 * 60 * 60, olderExp);
    const newerJwt = makeJwt(nowSec(), newerExp);

    // Adopt the newer token first.
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(TOKEN_REFRESH_EVENT, { detail: { token: newerJwt } }),
      );
    });
    await waitFor(() => expect(tokenText()).toBe(newerJwt));

    // Dispatch the older token — the AuthContext updater must keep newerJwt.
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(TOKEN_REFRESH_EVENT, { detail: { token: olderJwt } }),
      );
    });

    // Allow any async effects to settle.
    await act(async () => {
      await Promise.resolve();
    });

    expect(tokenText()).toBe(newerJwt);
  });
});

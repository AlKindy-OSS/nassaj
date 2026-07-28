/**
 * اختبار انحدار B-131 / F-API41 — «تسجيل الخروج العشوائي».
 *
 * السبب الجذري:
 *   الخادم يجدّد الـJWT عبر ترويسة `X-Refreshed-Token` بعد تجاوز نصف عمره.
 *   العميل كان يكتب التوكن المجدَّد إلى localStorage فقط دون تحديث حالة React في
 *   AuthContext، فيبقى WebSocket الرئيسي يتصل بالتوكن القديم حتى ينتهي (اليوم 7)
 *   → رفض `expired` → حلقة إعادة اتصال دائمة بينما REST/shell ينجوان (انفصام).
 *
 * الإصلاح المُختبَر هنا (مسارات الإنتاج الفعلية — لا محاكاة):
 *   (ب) applyRefreshedToken (utils/api) = كاتب موحّد: localStorage + بثّ
 *       `auth:token-refreshed`. وAuthContext يتبنّى الحدث في حالة React.
 *   (ج) resolveWebSocketUrl (WebSocketContext) يبني الرابط من أحدث توكن في
 *       localStorage، فينجو من التجديد حتى على إعادة اتصال backoff.
 *
 * كل الاختبارات تستدعي دوال الإنتاج نفسها التي يستدعيها connect() و
 * authenticatedFetch، فلا انحراف بين الاختبار والكود الفعلي.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';

import { AuthProvider, useAuth } from '../components/auth/context/AuthContext';
import { AUTH_TOKEN_STORAGE_KEY } from '../components/auth/constants';
import { applyRefreshedToken } from '../utils/api';
import { resolveWebSocketUrl } from './WebSocketContext';

const TOKEN_REFRESH_EVENT = 'auth:token-refreshed';

// ---------------------------------------------------------------------------
// Benign, URL-aware fetch stub. AuthProvider runs `checkAuthStatus` on mount
// (and again whenever `token` changes, because the callback closes over it), so
// the auth endpoints must resolve to a VALID identity — otherwise the re-check
// after our refresh event would call clearSession() and wipe the token we just
// adopted, masking the behaviour under test.
// ---------------------------------------------------------------------------

type StubResponse = {
  ok: boolean;
  status: number;
  headers: { get: () => null };
  json: () => Promise<unknown>;
};

const jsonResponse = (body: unknown, ok = true, status = 200): StubResponse => ({
  ok,
  status,
  headers: { get: () => null }, // no X-Refreshed-Token on these stubbed responses
  json: async () => body,
});

function installFetchStub() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown): Promise<StubResponse> => {
      const url = String(input);
      if (url.includes('/api/auth/user') || url.includes('/api/auth/me')) {
        return jsonResponse({ user: { id: 1, username: 'tester', role: 'user' } });
      }
      if (url.includes('/api/user/onboarding-status')) {
        return jsonResponse({ hasCompletedOnboarding: true });
      }
      if (url.includes('/api/auth/status')) {
        return jsonResponse({ needsSetup: false });
      }
      // Preference sync GET/PUT and any other authenticated probe.
      return jsonResponse({ preferences: {} });
    }),
  );
}

function TokenProbe() {
  const { token, isLoading } = useAuth();
  return (
    <div>
      <span data-testid="auth-token-value">{token ?? 'null'}</span>
      <span data-testid="auth-loading">{String(isLoading)}</span>
    </div>
  );
}

/** Render AuthProvider and wait for the mount-time auth check to settle. */
async function renderAuthProbe() {
  render(
    <AuthProvider>
      <TokenProbe />
    </AuthProvider>,
  );
  await waitFor(() =>
    expect(screen.getByTestId('auth-loading').textContent).toBe('false'),
  );
}

beforeEach(() => {
  localStorage.clear();
  installFetchStub();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ===========================================================================
// A — AuthContext adopts `auth:token-refreshed` into React state (requirement ب)
// ===========================================================================

describe('A — AuthContext adopts auth:token-refreshed', () => {
  it('A-1: updates the in-context token AND persists it to localStorage', async () => {
    await renderAuthProbe();
    expect(screen.getByTestId('auth-token-value').textContent).toBe('null');

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(TOKEN_REFRESH_EVENT, { detail: { token: 'fresh-jwt-001' } }),
      );
    });
    // The mount-driven re-check must NOT clear the freshly adopted token.
    await waitFor(() =>
      expect(screen.getByTestId('auth-loading').textContent).toBe('false'),
    );

    expect(screen.getByTestId('auth-token-value').textContent).toBe('fresh-jwt-001');
    expect(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).toBe('fresh-jwt-001');
  });

  it('A-2: adopts a subsequent rotation (token changes again)', async () => {
    await renderAuthProbe();

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(TOKEN_REFRESH_EVENT, { detail: { token: 'jwt-first' } }),
      );
    });
    await waitFor(() =>
      expect(screen.getByTestId('auth-token-value').textContent).toBe('jwt-first'),
    );

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(TOKEN_REFRESH_EVENT, { detail: { token: 'jwt-second' } }),
      );
    });
    await waitFor(() =>
      expect(screen.getByTestId('auth-token-value').textContent).toBe('jwt-second'),
    );
    expect(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).toBe('jwt-second');
  });

  it('A-3: ignores an event with no token in the payload (no-op)', async () => {
    await renderAuthProbe();

    await act(async () => {
      window.dispatchEvent(new CustomEvent(TOKEN_REFRESH_EVENT, { detail: {} }));
    });

    expect(screen.getByTestId('auth-token-value').textContent).toBe('null');
    expect(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).toBeNull();
  });
});

// ===========================================================================
// B — resolveWebSocketUrl reads the freshest localStorage token (requirement ج)
// ===========================================================================

describe('B — resolveWebSocketUrl uses the latest localStorage token', () => {
  it('B-1: builds a ws(s) URL carrying the stored token', () => {
    localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, 'latest-jwt-b1');
    const url = resolveWebSocketUrl();
    expect(url).toMatch(/^wss?:\/\//);
    expect(url).toContain('/ws?token=latest-jwt-b1');
  });

  it('B-2: reflects a rotated token on the NEXT call (the reconnect fix)', () => {
    localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, 'old-jwt');
    expect(resolveWebSocketUrl()).toContain('token=old-jwt');

    // Simulate the server rotation persisting a new token mid-session.
    localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, 'rotated-jwt');
    // A backoff reconnect calling resolveWebSocketUrl() again must pick it up.
    expect(resolveWebSocketUrl()).toContain('token=rotated-jwt');
    expect(resolveWebSocketUrl()).not.toContain('old-jwt');
  });

  it('B-3: returns null when no token is stored', () => {
    expect(resolveWebSocketUrl()).toBeNull();
  });

  it('B-4: URL-encodes tokens with reserved characters', () => {
    localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, 'a b+c/d=');
    expect(resolveWebSocketUrl()).toContain(`token=${encodeURIComponent('a b+c/d=')}`);
  });
});

// ===========================================================================
// C — End-to-end causal chain through the REAL applyRefreshedToken helper.
//     Proves: server-rotated token → api.js writer → AuthContext state → the
//     exact URL a WS (re)connect would dial. This is F-API41 closed.
// ===========================================================================

describe('C — applyRefreshedToken → AuthContext → WS URL (full chain)', () => {
  it('C-1: a rotation flows to AuthContext state, localStorage, and the WS URL', async () => {
    await renderAuthProbe();
    expect(screen.getByTestId('auth-token-value').textContent).toBe('null');

    await act(async () => {
      applyRefreshedToken('rotated-xyz');
    });
    await waitFor(() =>
      expect(screen.getByTestId('auth-loading').textContent).toBe('false'),
    );

    // (a) AuthContext React state adopted it (WS effect will reconnect).
    expect(screen.getByTestId('auth-token-value').textContent).toBe('rotated-xyz');
    // (b) localStorage holds it (REST/shell already read this).
    expect(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).toBe('rotated-xyz');
    // (c) the WS URL a (re)connect builds now carries the FRESH token.
    expect(resolveWebSocketUrl()).toContain('token=rotated-xyz');
  });

  it('C-2: applyRefreshedToken(null) is a no-op (session untouched)', async () => {
    await renderAuthProbe();

    await act(async () => {
      applyRefreshedToken(null as unknown as string);
    });

    expect(screen.getByTestId('auth-token-value').textContent).toBe('null');
    expect(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).toBeNull();
  });
});

// ===========================================================================
// D — applyRefreshedToken writer contract, isolated (no React).
// ===========================================================================

describe('D — applyRefreshedToken writer contract', () => {
  it('D-1: writes localStorage and dispatches auth:token-refreshed with the token', () => {
    const received: string[] = [];
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<{ token?: string }>).detail;
      if (detail?.token) received.push(detail.token);
    };
    window.addEventListener(TOKEN_REFRESH_EVENT, listener);
    try {
      applyRefreshedToken('contract-jwt');
    } finally {
      window.removeEventListener(TOKEN_REFRESH_EVENT, listener);
    }

    expect(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).toBe('contract-jwt');
    expect(received).toEqual(['contract-jwt']);
  });

  it('D-2: falsy token neither writes nor dispatches', () => {
    let dispatched = false;
    const listener = () => {
      dispatched = true;
    };
    window.addEventListener(TOKEN_REFRESH_EVENT, listener);
    try {
      applyRefreshedToken('');
    } finally {
      window.removeEventListener(TOKEN_REFRESH_EVENT, listener);
    }

    expect(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).toBeNull();
    expect(dispatched).toBe(false);
  });
});

/**
 * اختبار انحدار B-131 — الجزء الثاني: سدّ فجوات «الخروج العشوائي».
 *
 * الجزء الأول (tokenRefreshSync.test.tsx) أثبت أن التوكن المجدَّد سيرفرياً عبر
 * ترويسة X-Refreshed-Token يُتبنّى في حالة React ويصل لرابط WebSocket. لكن ذلك
 * تفاعلي فقط: يتطلب طلباً خارجاً بتوكن ما زال صالحاً. الأجهزة النائمة/الـPWA
 * المخنوقة تمرّ يوماً كاملاً بلا أي طلب → صفر تجديد → التوكن ينتهي عند اليوم 7.
 *
 * هذا الملف يغطّي الفجوات الأربع المُنفَّذة client-side:
 *   (أ) تجديد استباقي: مؤقّت + focus/visibility/online، متى تجاوز التوكن نصف عمره.
 *   (د) تعافي 401: refresh صامت مرة + إعادة الطلب، وإلا طرد.
 *   (تبويبات) مزامنة عبر حدث 'storage' بين التبويبات.
 *   (compare-and-clear) لا يمسح توكناً أحدث بل يتبنّاه (قاتل الدوّامة).
 *
 * كل الاختبارات تستدعي دوال الإنتاج نفسها (refreshAuthToken / authenticatedFetch /
 * AuthProvider) — لا محاكاة لمنطق التجديد.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';

import { AuthProvider, PROACTIVE_REFRESH_INTERVAL_MS, useAuth } from '../components/auth/context/AuthContext';
import { AUTH_TOKEN_STORAGE_KEY } from '../components/auth/constants';
import { authenticatedFetch, refreshAuthToken } from '../utils/api';

// ---------------------------------------------------------------------------
// JWT builders. Only the payload segment (`exp`/`iat`, seconds) matters to the
// client half-life math; the header/signature are opaque placeholders.
// ---------------------------------------------------------------------------

const SEVEN_DAYS_SEC = 7 * 24 * 60 * 60;
const nowSec = () => Math.floor(Date.now() / 1000);

const base64url = (obj: object): string =>
  btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const makeJwt = (iat: number, exp: number): string =>
  `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url({ iat, exp, userId: 1, username: 'tester', role: 'user' })}.sig`;

/** Freshly issued (iat=now): far from half-life → proactive refresh is a no-op. */
const freshToken = (): string => makeJwt(nowSec(), nowSec() + SEVEN_DAYS_SEC);
/** iat 4 days ago (midpoint at 3.5 days) → past half-life, not yet expired. */
const staleToken = (): string => {
  const iat = nowSec() - 4 * 24 * 60 * 60;
  return makeJwt(iat, iat + SEVEN_DAYS_SEC);
};
/** iat 8 days ago → already expired (exp 1 day in the past). */
const expiredToken = (): string => {
  const iat = nowSec() - 8 * 24 * 60 * 60;
  return makeJwt(iat, iat + SEVEN_DAYS_SEC);
};

// ---------------------------------------------------------------------------
// A minimal Response-like object matching what the production code reads:
// `.ok`, `.status`, `.headers.get('X-Refreshed-Token')`, `.json()`.
// ---------------------------------------------------------------------------

type FetchInit = { headers?: Record<string, string> } | undefined;
type MockResponse = {
  ok: boolean;
  status: number;
  headers: { get: (name: string) => string | null };
  json: () => Promise<unknown>;
};

const makeResponse = (
  body: unknown,
  { ok = true, status = 200, refreshedToken = null as string | null } = {},
): MockResponse => ({
  ok,
  status,
  headers: { get: (name) => (name === 'X-Refreshed-Token' ? refreshedToken : null) },
  json: async () => body,
});

/** Route the AuthProvider bootstrap calls (status/user/onboarding/preferences)
 * to a valid identity so the mount-time check never wipes the token under test. */
const bootstrapResponse = (url: string): MockResponse | null => {
  if (url.includes('/api/auth/status')) return makeResponse({ needsSetup: false });
  if (url.includes('/api/auth/user') || url.includes('/api/auth/me')) {
    return makeResponse({ user: { id: 1, username: 'tester', role: 'user' } });
  }
  if (url.includes('/api/user/onboarding-status')) return makeResponse({ hasCompletedOnboarding: true });
  if (url.includes('/api/preferences') || url.includes('/api/user/preferences')) {
    return makeResponse({ preferences: {} });
  }
  return null;
};

function installFetch(handler: (url: string, init: FetchInit) => MockResponse | Promise<MockResponse>) {
  const fetchMock = vi.fn(async (input: unknown, init: FetchInit): Promise<MockResponse> =>
    handler(String(input), init),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const countCalls = (fetchMock: ReturnType<typeof vi.fn>, substr: string): number =>
  fetchMock.mock.calls.filter(([input]) => String(input).includes(substr)).length;

function TokenProbe() {
  const { token, isLoading } = useAuth();
  return (
    <div>
      <span data-testid="auth-token-value">{token ?? 'null'}</span>
      <span data-testid="auth-loading">{String(isLoading)}</span>
    </div>
  );
}

async function renderAuthProbe() {
  render(
    <AuthProvider>
      <TokenProbe />
    </AuthProvider>,
  );
  await waitFor(() => expect(screen.getByTestId('auth-loading').textContent).toBe('false'));
}

const tokenText = () => screen.getByTestId('auth-token-value').textContent;

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, '', '/'); // default: not on /login
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ===========================================================================
// أ — Proactive refresh
// ===========================================================================

describe('أ — proactive refresh (timer + visibility, past half-life)', () => {
  it('أ-1: refreshes and adopts the new token when past half-life at mount', async () => {
    const FRESH = freshToken();
    localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, staleToken());
    const fetchMock = installFetch((url) => {
      if (url.includes('/api/auth/refresh')) return makeResponse({ success: true, token: FRESH });
      return bootstrapResponse(url) ?? makeResponse({});
    });

    await renderAuthProbe();

    await waitFor(() => expect(countCalls(fetchMock, '/api/auth/refresh')).toBeGreaterThan(0));
    await waitFor(() => expect(tokenText()).toBe(FRESH));
    expect(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).toBe(FRESH);
  });

  it('أ-2: a fresh token at mount does NOT trigger a refresh', async () => {
    localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, freshToken());
    const fetchMock = installFetch((url) => bootstrapResponse(url) ?? makeResponse({}));

    await renderAuthProbe();
    // Let any stray effect settle before asserting the negative.
    await act(async () => { await Promise.resolve(); });

    expect(countCalls(fetchMock, '/api/auth/refresh')).toBe(0);
  });

  it('أ-3: an already-expired token is left to the 401 path (no refresh attempt)', async () => {
    localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, expiredToken());
    const fetchMock = installFetch((url) => bootstrapResponse(url) ?? makeResponse({}));

    await renderAuthProbe();
    await act(async () => { await Promise.resolve(); });

    expect(countCalls(fetchMock, '/api/auth/refresh')).toBe(0);
  });

  it('أ-4: visibilitychange→visible refreshes once the stored token is stale', async () => {
    const FRESH2 = freshToken();
    localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, freshToken()); // fresh → arm without refreshing
    const fetchMock = installFetch((url) => {
      if (url.includes('/api/auth/refresh')) return makeResponse({ success: true, token: FRESH2 });
      return bootstrapResponse(url) ?? makeResponse({});
    });

    await renderAuthProbe();
    expect(countCalls(fetchMock, '/api/auth/refresh')).toBe(0);

    // The device kept the tab open long enough for the token to cross half-life.
    // maybeRefreshToken reads the FRESHEST localStorage value, so writing a stale
    // token directly (no storage event) is enough to arm the next trigger.
    localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, staleToken());
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await waitFor(() => expect(countCalls(fetchMock, '/api/auth/refresh')).toBeGreaterThan(0));
    await waitFor(() => expect(tokenText()).toBe(FRESH2));
  });

  it('أ-5: the periodic sweep is armed at the production interval and refreshes when stale', async () => {
    const setIntervalSpy = vi.spyOn(window, 'setInterval');
    const FRESH3 = freshToken();
    localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, freshToken());
    const fetchMock = installFetch((url) => {
      if (url.includes('/api/auth/refresh')) return makeResponse({ success: true, token: FRESH3 });
      return bootstrapResponse(url) ?? makeResponse({});
    });

    await renderAuthProbe();
    expect(countCalls(fetchMock, '/api/auth/refresh')).toBe(0);

    // The sweep must be registered at exactly the production period.
    const sweep = setIntervalSpy.mock.calls.find(([, ms]) => ms === PROACTIVE_REFRESH_INTERVAL_MS);
    expect(sweep).toBeTruthy();
    const sweepCallback = sweep![0] as () => void;

    // Token ages past half-life, then the sweep fires exactly as the timer would.
    localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, staleToken());
    await act(async () => { sweepCallback(); });

    await waitFor(() => expect(countCalls(fetchMock, '/api/auth/refresh')).toBeGreaterThan(0));
  });
});

// ===========================================================================
// Single-flight — the timer + focus/visibility/online + 401 paths share ONE
// in-flight refresh.
// ===========================================================================

describe('single-flight refreshAuthToken', () => {
  it('SF-1: collapses concurrent callers into a single POST /api/auth/refresh', async () => {
    localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, 'tok-a');
    let resolveFetch!: (r: MockResponse) => void;
    const fetchMock = vi.fn(() => new Promise<MockResponse>((res) => { resolveFetch = res; }));
    vi.stubGlobal('fetch', fetchMock);

    const p1 = refreshAuthToken();
    const p2 = refreshAuthToken();
    const p3 = refreshAuthToken();
    // All three share ONE request while it is in flight.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFetch(makeResponse({ success: true, token: 'refreshed-1' }));
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    expect(r1).toBe('refreshed-1');
    expect(r2).toBe('refreshed-1');
    expect(r3).toBe('refreshed-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).toBe('refreshed-1');
  });

  it('SF-2: a new call after the first settles starts a fresh request', async () => {
    localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, 'tok-b');
    const fetchMock = vi.fn(async () => makeResponse({ success: true, token: 'refreshed-2' }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await refreshAuthToken()).toBe('refreshed-2');
    expect(await refreshAuthToken()).toBe('refreshed-2');
    expect(fetchMock).toHaveBeenCalledTimes(2); // not coalesced — sequential, not concurrent
  });

  it('SF-3: resolves null (no eviction) when the server rejects the refresh', async () => {
    localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, 'tok-c');
    const fetchMock = vi.fn(async () => makeResponse({ error: 'expired' }, { ok: false, status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await refreshAuthToken()).toBeNull();
  });
});

// ===========================================================================
// د — 401 recovery in authenticatedFetch
// ===========================================================================

describe('د — 401 recovery (authenticatedFetch)', () => {
  it('د-1: 401 → silent refresh → replay the request once with the new token', async () => {
    localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, 'old-tok');
    const evicted: Array<string | undefined> = [];
    const onUnauthorized = (e: Event) =>
      evicted.push((e as CustomEvent<{ token?: string }>).detail?.token);
    window.addEventListener('auth:unauthorized', onUnauthorized);

    const fetchMock = installFetch((url, init) => {
      const auth = init?.headers?.Authorization;
      if (url.includes('/api/auth/refresh')) return makeResponse({ success: true, token: 'new-tok' });
      if (url.includes('/api/data')) {
        if (auth === 'Bearer new-tok') return makeResponse({ ok: true }, { status: 200 });
        return makeResponse({ error: 'expired' }, { ok: false, status: 401 });
      }
      return makeResponse({});
    });

    try {
      const res = await authenticatedFetch('/api/data');
      expect(res.status).toBe(200);
    } finally {
      window.removeEventListener('auth:unauthorized', onUnauthorized);
    }

    // Exactly: data(401) → refresh → data(200) with the fresh token.
    const dataCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes('/api/data'));
    expect(dataCalls).toHaveLength(2);
    expect((dataCalls[1][1] as FetchInit)?.headers?.Authorization).toBe('Bearer new-tok');
    expect(countCalls(fetchMock, '/api/auth/refresh')).toBe(1);
    // The session survived — no eviction dispatched.
    expect(evicted).toHaveLength(0);
    expect(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).toBe('new-tok');
  });

  it('د-2: 401 then a failed refresh evicts once (auth:unauthorized carries the rejected token, no replay)', async () => {
    localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, 'expired-tok');
    const evicted: Array<string | undefined> = [];
    const onUnauthorized = (e: Event) =>
      evicted.push((e as CustomEvent<{ token?: string }>).detail?.token);
    window.addEventListener('auth:unauthorized', onUnauthorized);

    const fetchMock = installFetch((url) => {
      if (url.includes('/api/auth/refresh')) return makeResponse({ error: 'expired' }, { ok: false, status: 401 });
      if (url.includes('/api/data')) return makeResponse({ error: 'expired' }, { ok: false, status: 401 });
      return makeResponse({});
    });

    try {
      const res = await authenticatedFetch('/api/data');
      expect(res.status).toBe(401);
    } finally {
      window.removeEventListener('auth:unauthorized', onUnauthorized);
    }

    // The original request is NOT replayed (refresh failed); refresh is tried once.
    expect(countCalls(fetchMock, '/api/data')).toBe(1);
    expect(countCalls(fetchMock, '/api/auth/refresh')).toBe(1);
    expect(evicted).toEqual(['expired-tok']);
  });

  it('د-3: the refresh endpoint itself never recurses through the 401 handler', async () => {
    // Guards the loop: refreshAuthToken uses a raw fetch, so a 401 on /refresh
    // must NOT dispatch auth:unauthorized nor re-invoke refresh.
    localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, 'tok-d');
    let unauthorized = 0;
    const onUnauthorized = () => { unauthorized += 1; };
    window.addEventListener('auth:unauthorized', onUnauthorized);
    const fetchMock = installFetch(() => makeResponse({ error: 'expired' }, { ok: false, status: 401 }));

    try {
      expect(await refreshAuthToken()).toBeNull();
    } finally {
      window.removeEventListener('auth:unauthorized', onUnauthorized);
    }

    expect(countCalls(fetchMock, '/api/auth/refresh')).toBe(1);
    expect(unauthorized).toBe(0);
  });
});

// ===========================================================================
// تبويبات — cross-tab 'storage' sync
// ===========================================================================

describe('تبويبات — cross-tab storage sync', () => {
  it('T-1: adopts a newer token written by another tab without rewriting localStorage', async () => {
    const TOKEN_A = freshToken();
    const TOKEN_B = `${freshToken()}-B`;
    localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, TOKEN_A);
    installFetch((url) => bootstrapResponse(url) ?? makeResponse({}));

    await renderAuthProbe();
    await waitFor(() => expect(tokenText()).toBe(TOKEN_A));

    // Another tab rotated the token: it is already in shared localStorage when
    // the 'storage' event fires here.
    localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, TOKEN_B);
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
    await act(async () => {
      window.dispatchEvent(
        new StorageEvent('storage', { key: AUTH_TOKEN_STORAGE_KEY, oldValue: TOKEN_A, newValue: TOKEN_B }),
      );
    });

    await waitFor(() => expect(tokenText()).toBe(TOKEN_B));
    // The receiving tab must NOT re-write the auth token (no echo).
    expect(setItemSpy.mock.calls.filter(([k]) => k === AUTH_TOKEN_STORAGE_KEY)).toHaveLength(0);
  });

  it('T-2: mirrors a sign-out when another tab removes the token', async () => {
    const TOKEN_A = freshToken();
    localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, TOKEN_A);
    installFetch((url) => bootstrapResponse(url) ?? makeResponse({}));

    await renderAuthProbe();
    await waitFor(() => expect(tokenText()).toBe(TOKEN_A));

    await act(async () => {
      localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY); // the other tab's write
      window.dispatchEvent(
        new StorageEvent('storage', { key: AUTH_TOKEN_STORAGE_KEY, oldValue: TOKEN_A, newValue: null }),
      );
    });

    await waitFor(() => expect(tokenText()).toBe('null'));
    expect(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).toBeNull();
  });
});

// ===========================================================================
// compare-and-clear — the vortex killer
// ===========================================================================

describe('compare-and-clear (vortex killer)', () => {
  it('CC-1: auth:unauthorized adopts a newer token instead of evicting', async () => {
    const TOKEN_OLD = freshToken();
    const TOKEN_NEW = `${freshToken()}-NEW`;
    localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, TOKEN_OLD);
    installFetch((url) => bootstrapResponse(url) ?? makeResponse({}));

    await renderAuthProbe();
    await waitFor(() => expect(tokenText()).toBe(TOKEN_OLD));

    // A parallel tab (or our own proactive refresh) wrote a newer token to
    // localStorage while an old request was still 401'ing with TOKEN_OLD.
    localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, TOKEN_NEW);
    await act(async () => {
      window.dispatchEvent(new CustomEvent('auth:unauthorized', { detail: { token: TOKEN_OLD } }));
    });

    // The session survives on the newer token — NOT wiped.
    await waitFor(() => expect(tokenText()).toBe(TOKEN_NEW));
    expect(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).toBe(TOKEN_NEW);
  });

  it('CC-2: auth:unauthorized on the still-current token genuinely evicts', async () => {
    window.history.replaceState({}, '', '/login'); // skip the hard redirect in jsdom
    const TOKEN_OLD = freshToken();
    localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, TOKEN_OLD);
    installFetch((url) => bootstrapResponse(url) ?? makeResponse({}));

    await renderAuthProbe();
    await waitFor(() => expect(tokenText()).toBe(TOKEN_OLD));

    // No newer token present → the rejected token IS the current one → evict.
    await act(async () => {
      window.dispatchEvent(new CustomEvent('auth:unauthorized', { detail: { token: TOKEN_OLD } }));
    });

    await waitFor(() => expect(tokenText()).toBe('null'));
    expect(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).toBeNull();
  });
});

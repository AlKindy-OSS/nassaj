import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiMock = vi.hoisted(() => ({
  status: vi.fn<() => Promise<Response>>(),
  exchange: vi.fn<(code: string) => Promise<Response>>(),
  probe: vi.fn<() => Promise<Response>>(),
}));

vi.mock('../../utils/api', () => ({
  api: {
    auth: {
      status: apiMock.status,
      oidc: { exchange: apiMock.exchange, probe: apiMock.probe },
    },
  },
}));

import {
  detectOidcAvailability,
  exchangeOidcCode,
  fetchOidcIdentity,
  reasonFromExchangeStatus,
  reasonFromReturnError,
  resetOidcAvailabilityCache,
} from './oidc';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  resetOidcAvailabilityCache();
  apiMock.status.mockReset();
  apiMock.exchange.mockReset();
  apiMock.probe.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('reason classification', () => {
  it('maps exchange statuses to user-facing reasons', () => {
    expect(reasonFromExchangeStatus(400)).toBe('missing_code');
    expect(reasonFromExchangeStatus(401)).toBe('transaction_expired');
    expect(reasonFromExchangeStatus(429)).toBe('rate_limited');
    expect(reasonFromExchangeStatus(501)).toBe('disabled');
    expect(reasonFromExchangeStatus(502)).toBe('provider_unavailable');
  });

  it('maps IdP and callback error codes, unknown codes fall back safely', () => {
    expect(reasonFromReturnError('access_denied')).toBe('provider_denied');
    expect(reasonFromReturnError('invalid_state')).toBe('invalid_state');
    expect(reasonFromReturnError('transaction_expired')).toBe('transaction_expired');
    expect(reasonFromReturnError('oidc_not_linked')).toBe('not_linked');
    expect(reasonFromReturnError('toString')).toBe('provider_unavailable');
    expect(reasonFromReturnError('<script>')).toBe('provider_unavailable');
  });
});

describe('exchangeOidcCode', () => {
  it('returns the token from a successful POST exchange', async () => {
    apiMock.exchange.mockResolvedValue(json({ token: 'jwt-synthetic', userId: 12 }));
    await expect(exchangeOidcCode('one-time')).resolves.toEqual({ ok: true, token: 'jwt-synthetic' });
    expect(apiMock.exchange).toHaveBeenCalledWith('one-time');
  });

  it('classifies a rejected code (expired, replayed, or foreign browser)', async () => {
    apiMock.exchange.mockResolvedValue(json({ error: 'Invalid or expired code' }, 401));
    await expect(exchangeOidcCode('stale')).resolves.toEqual({ ok: false, reason: 'transaction_expired' });
  });

  it('treats a 200 without a token as a provider failure', async () => {
    apiMock.exchange.mockResolvedValue(json({ userId: 12 }));
    await expect(exchangeOidcCode('x')).resolves.toEqual({ ok: false, reason: 'provider_unavailable' });
  });

  it('reports a network failure without throwing', async () => {
    apiMock.exchange.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(exchangeOidcCode('x')).resolves.toEqual({ ok: false, reason: 'network' });
  });
});

describe('fetchOidcIdentity', () => {
  it('loads the identity with the fresh token and never touches localStorage', async () => {
    const fetchMock = vi.fn(async () => json({ user: { id: 12, username: 'linked' }, isMultiUser: true }));
    vi.stubGlobal('fetch', fetchMock);
    const setItem = vi.spyOn(Storage.prototype, 'setItem');

    await expect(fetchOidcIdentity('jwt-synthetic')).resolves.toEqual({
      ok: true,
      user: { id: 12, username: 'linked' },
      isMultiUser: true,
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/user', {
      headers: { Authorization: 'Bearer jwt-synthetic' },
    });
    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();
  });

  it('fails with session_failed when the identity cannot be loaded', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'Token invalidated' }, 401)));
    await expect(fetchOidcIdentity('jwt')).resolves.toEqual({ ok: false, reason: 'session_failed' });
  });
});

describe('detectOidcAvailability', () => {
  it('prefers an explicit oidcEnabled flag on /api/auth/status', async () => {
    apiMock.status.mockResolvedValue(json({ needsSetup: false, oidcEnabled: true }));
    await expect(detectOidcAvailability()).resolves.toBe(true);
    expect(apiMock.probe).not.toHaveBeenCalled();
  });

  it('falls back to the exchange probe: 400 means enabled', async () => {
    apiMock.status.mockResolvedValue(json({ needsSetup: false }));
    apiMock.probe.mockResolvedValue(json({ error: 'Missing code' }, 400));
    await expect(detectOidcAvailability()).resolves.toBe(true);
  });

  it('falls back to the exchange probe: 501 means disabled', async () => {
    apiMock.status.mockResolvedValue(json({ needsSetup: false }));
    apiMock.probe.mockResolvedValue(json({ error: 'OIDC is not enabled' }, 501));
    await expect(detectOidcAvailability()).resolves.toBe(false);
  });

  it('probes once per page load for concurrent callers', async () => {
    apiMock.status.mockResolvedValue(json({}));
    apiMock.probe.mockResolvedValue(json({}, 400));
    await Promise.all([detectOidcAvailability(), detectOidcAvailability()]);
    await detectOidcAvailability();
    expect(apiMock.probe).toHaveBeenCalledTimes(1);
  });

  it('reads a network failure as disabled and retries on the next call', async () => {
    apiMock.status.mockRejectedValueOnce(new TypeError('offline'));
    await expect(detectOidcAvailability()).resolves.toBe(false);

    apiMock.status.mockResolvedValue(json({ oidcEnabled: true }));
    await expect(detectOidcAvailability()).resolves.toBe(true);
  });
});

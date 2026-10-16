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
  clearSsoReauthHint,
  detectOidcAvailability,
  hasSsoReauthHint,
  oidcLoginUrl,
  setSsoReauthHint,
  SSO_REAUTH_HINT_KEY,
  startOidcLogin,
  detectSsoStatus,
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
    expect(reasonFromReturnError('oidc_not_authorized')).toBe('not_authorized');
    expect(reasonFromReturnError('oidc_account_exists')).toBe('account_exists');
    expect(reasonFromReturnError('rate_limited')).toBe('rate_limited');
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

  it('returns the wallet when the exchange issued a device session (ADR-163 amendment 1)', async () => {
    const wallet = {
      generation: 3,
      activeSlotId: 'slot-a',
      accounts: [{ slotId: 'slot-a', displayName: 'linked', isActive: true, lastUsedAt: 1 }],
    };
    apiMock.exchange.mockResolvedValue(json({ wallet, csrfToken: 'csrf-synthetic' }));
    await expect(exchangeOidcCode('one-time')).resolves.toEqual({ ok: true, wallet });
  });

  it('rejects a malformed wallet answer as a provider failure', async () => {
    apiMock.exchange.mockResolvedValue(json({ wallet: { generation: -1, activeSlotId: null, accounts: [] } }));
    await expect(exchangeOidcCode('x')).resolves.toEqual({ ok: false, reason: 'provider_unavailable' });
  });

  it('classifies a wallet-mode origin refusal (403) as a generic provider failure', async () => {
    apiMock.exchange.mockResolvedValue(json({ error: 'Request rejected', code: 'origin_rejected' }, 403));
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

  it('without a token reads the identity through the device cookie, no Authorization', async () => {
    const fetchMock = vi.fn(async () => json({ user: { id: 12, username: 'linked' }, isMultiUser: false }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchOidcIdentity()).resolves.toEqual({
      ok: true,
      user: { id: 12, username: 'linked' },
      isMultiUser: false,
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/user', { credentials: 'same-origin', cache: 'no-store' });
  });

  it('fails with session_failed when the identity cannot be loaded', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'Token invalidated' }, 401)));
    await expect(fetchOidcIdentity('jwt')).resolves.toEqual({ ok: false, reason: 'session_failed' });
  });
});

describe('detectOidcAvailability', () => {
  it('reads ssoState and ssoLoginAvailable from /api/auth/status', async () => {
    apiMock.status.mockResolvedValue(json({ needsSetup: false, ssoState: 'active', ssoLoginAvailable: true }));
    await expect(detectOidcAvailability()).resolves.toBe(true);
    expect(apiMock.probe).not.toHaveBeenCalled();
  });

  it.each(['unavailable', 'paused', 'off'])('hides the button when ssoState is %s', async (state) => {
    apiMock.status.mockResolvedValue(json({ ssoState: state, ssoLoginAvailable: false }));
    await expect(detectSsoStatus()).resolves.toEqual({ loginAvailable: false, state });
    expect(apiMock.probe).not.toHaveBeenCalled();
  });

  it('never offers the button when the two fields disagree', async () => {
    apiMock.status.mockResolvedValue(json({ ssoState: 'unavailable', ssoLoginAvailable: true }));
    await expect(detectOidcAvailability()).resolves.toBe(false);
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

    apiMock.status.mockResolvedValue(json({ ssoState: 'active', ssoLoginAvailable: true }));
    await expect(detectOidcAvailability()).resolves.toBe(true);
  });
});

describe('ADR-194 A1 return codes', () => {
  it.each([
    ['owner_must_sign_in_locally', 'owner_local_only'],
    ['owner_sso_key_required', 'owner_key_required'],
    ['owner_sso_reauth_required', 'owner_reauth_required'],
    ['password_change_required', 'password_change_required'],
    ['oidc_config_changed', 'config_changed'],
    ['oidc_login_not_initiated', 'login_not_initiated'],
    ['sso_unavailable', 'sso_unavailable'],
  ] as const)('maps %s to its own reason, never provider_unavailable', (code, reason) => {
    expect(reasonFromReturnError(code)).toBe(reason);
  });
});

describe('ADR-194 A1 re-authentication hint', () => {
  beforeEach(() => window.localStorage.clear());

  it('is absent by default; set and clear round-trip; it stores only "1"', () => {
    expect(hasSsoReauthHint()).toBe(false);
    setSsoReauthHint();
    expect(hasSsoReauthHint()).toBe(true);
    expect(window.localStorage.getItem(SSO_REAUTH_HINT_KEY)).toBe('1');
    expect(Object.keys(window.localStorage)).toEqual([SSO_REAUTH_HINT_KEY]);
    clearSsoReauthHint();
    expect(hasSsoReauthHint()).toBe(false);
  });

  it('targets ?reauth=1 with the hint and the plain URL without it', () => {
    expect(oidcLoginUrl()).toBe('/api/auth/oidc/login');
    expect(oidcLoginUrl(true)).toBe('/api/auth/oidc/login?reauth=1');
    setSsoReauthHint();
    expect(oidcLoginUrl()).toBe('/api/auth/oidc/login?reauth=1');
  });

  it('startOidcLogin follows the hint; only a literal true forces re-authentication', () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    startOidcLogin();
    startOidcLogin({ type: 'click' });
    startOidcLogin(true);
    setSsoReauthHint();
    startOidcLogin();
    expect(assign.mock.calls.map(([target]) => target)).toEqual([
      '/api/auth/oidc/login', '/api/auth/oidc/login', '/api/auth/oidc/login?reauth=1', '/api/auth/oidc/login?reauth=1',
    ]);
  });

  it('a storage that throws reads as no hint and never breaks the start', () => {
    const broken = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
      removeItem: () => { throw new Error('denied'); },
    };
    expect(hasSsoReauthHint(broken)).toBe(false);
    expect(() => setSsoReauthHint(broken)).not.toThrow();
    expect(() => clearSsoReauthHint(broken)).not.toThrow();
  });
});

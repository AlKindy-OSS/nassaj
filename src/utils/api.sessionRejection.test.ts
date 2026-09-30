// B-1043 / T-1699: a 401 that carries a provider/domain error code must not be
// mistaken for a nassaj session rejection (which signs the member out).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, authenticatedFetch, isSessionRejection } from './api.js';

const res = (body?: unknown, init: ResponseInit = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status: 401, ...init });

describe('isSessionRejection', () => {
  it('treats the auth middleware shape ({ error } without code) as a rejection', async () => {
    expect(await isSessionRejection(res({ error: 'Invalid or expired token' }))).toBe(true);
  });

  it('treats an unreadable / empty body as a rejection (fail-safe)', async () => {
    expect(await isSessionRejection(res(undefined))).toBe(true);
    expect(await isSessionRejection(new Response('not json', { status: 401 }))).toBe(true);
  });

  it.each(['AUTH_REQUIRED', 'AUTHENTICATION_REQUIRED', 'UNAUTHENTICATED', 'UNAUTHORIZED'])(
    'treats route guard code %s as a rejection',
    async (code) => {
      expect(await isSessionRejection(res({ error: 'x', code }))).toBe(true);
    },
  );

  it('keeps the session for a provider credential code (the Jazari/Razi case)', async () => {
    expect(await isSessionRejection(res({ error: 'Claude is not authenticated.', code: 'CLAUDE_USAGE_UNAVAILABLE' }))).toBe(false);
  });

  it('leaves the body readable for the caller', async () => {
    const r = res({ error: 'x', code: 'CLAUDE_USAGE_UNAVAILABLE' });
    await isSessionRejection(r);
    expect((await r.json()).code).toBe('CLAUDE_USAGE_UNAVAILABLE');
  });
});

// B-1405 fix: a wrong-password reply on DELETE /api/auth/oidc/link/self must
// carry a code, or the shared isSessionRejection() logic (exercised above)
// signs the owner out of their whole session on a mere typo. Goes through the
// real authenticatedFetch/api.auth.oidc.unlinkSelf helper — not a mocked hook
// — so a regression in either the route or the client-side session check
// trips this test.
describe('DELETE /api/auth/oidc/link/self wrong-password reply', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('never dispatches auth:unauthorized on the coded 401', async () => {
    localStorage.setItem('auth-token', 'token-synthetic');
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      res({ error: 'Current password is incorrect', code: 'current_password_incorrect' }),
    );
    const onUnauthorized = vi.fn();
    window.addEventListener('auth:unauthorized', onUnauthorized);
    try {
      const response = await api.auth.oidc.unlinkSelf('wrong-pw');
      expect(response.status).toBe(401);
      expect(onUnauthorized).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('auth:unauthorized', onUnauthorized);
    }
  });

  it('sanity: a code-less 401 on the same call DOES dispatch auth:unauthorized', async () => {
    localStorage.setItem('auth-token', 'token-synthetic');
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(res({ error: 'Invalid or expired token' }));
    const onUnauthorized = vi.fn();
    window.addEventListener('auth:unauthorized', onUnauthorized);
    try {
      await authenticatedFetch('/api/auth/oidc/link/self', { method: 'DELETE', body: '{}' });
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('auth:unauthorized', onUnauthorized);
    }
  });
});

// T-1939: an SSO-only refusal is a domain answer, never a lost session.
describe('sso_required refusals', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('is not a session rejection even if it ever rides a 401', async () => {
    expect(await isSessionRejection(res({ error: 'x', code: 'sso_required' }))).toBe(false);
    expect(await isSessionRejection(res({ error: 'x', code: 'sso_required_for_new_accounts' }))).toBe(false);
  });

  it.each([401, 403])('never dispatches auth:unauthorized on a %i sso_required reply', async (status) => {
    localStorage.setItem('auth-token', 'token-synthetic');
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      res({ error: 'This account signs in through SSO', code: 'sso_required' }, { status }),
    );
    const onUnauthorized = vi.fn();
    window.addEventListener('auth:unauthorized', onUnauthorized);
    try {
      const response = await authenticatedFetch('/api/auth/accounts/add', { method: 'POST', body: '{}' });
      expect(response.status).toBe(status);
      expect(onUnauthorized).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('auth:unauthorized', onUnauthorized);
    }
  });
});

// T-1939 6B/6C: the connector step-up refusals ride real 401/429 replies and
// must keep the session — a wrong password must never sign the member out.
// Exercised through the real authenticatedFetch against the real step-up path.
describe('connector step-up refusals', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  const stepUpCodes = [
    'step_up_failed', 'sso_step_up_required', 'sso_step_up_not_applicable',
    'step_up_rate_limited', 'step_up_invalid_request', 'CONNECTOR_RECENT_AUTH_REQUIRED',
  ];

  it.each(stepUpCodes)('%s is not a session rejection', async (code) => {
    expect(await isSessionRejection(res({ error: 'x', code }))).toBe(false);
  });

  it.each(stepUpCodes)('a 401 %s from the step-up route never dispatches auth:unauthorized', async (code) => {
    localStorage.setItem('auth-token', 'token-synthetic');
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(res({ error: 'x', code }));
    const onUnauthorized = vi.fn();
    window.addEventListener('auth:unauthorized', onUnauthorized);
    try {
      const response = await authenticatedFetch('/api/connectors/owner-session/step-up', {
        method: 'POST', body: JSON.stringify({ stepUp: { method: 'password', password: 'wrong' } }),
      });
      expect(response.status).toBe(401);
      expect(onUnauthorized).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('auth:unauthorized', onUnauthorized);
    }
  });
});

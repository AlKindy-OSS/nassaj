// T-1939 slice 3: `sso_reauth_required` restarts SSO — it is neither a silent
// refresh case nor a plain `auth:unauthorized` logout.
import { afterEach, describe, expect, it, vi } from 'vitest';

import { authenticatedFetch, isSessionRejection, isSsoReauthRejection, refreshAuthToken, SSO_REAUTH_EVENT } from './api.js';

const reauth = () => new Response(
  JSON.stringify({ error: 'Sign in again through SSO', code: 'sso_reauth_required' }),
  { status: 401 },
);

function listen() {
  const onReauth = vi.fn();
  const onUnauthorized = vi.fn();
  window.addEventListener(SSO_REAUTH_EVENT, onReauth);
  window.addEventListener('auth:unauthorized', onUnauthorized);
  return {
    onReauth,
    onUnauthorized,
    stop: () => {
      window.removeEventListener(SSO_REAUTH_EVENT, onReauth);
      window.removeEventListener('auth:unauthorized', onUnauthorized);
    },
  };
}

describe('sso_reauth_required', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('is recognised only on a 401 and still counts as a session rejection elsewhere', async () => {
    expect(await isSsoReauthRejection(reauth())).toBe(true);
    expect(await isSsoReauthRejection(new Response(JSON.stringify({ code: 'sso_reauth_required' }), { status: 403 })))
      .toBe(false);
    expect(await isSsoReauthRejection(new Response('not json', { status: 401 }))).toBe(false);
    expect(await isSessionRejection(reauth())).toBe(true);
  });

  it('a GET dispatches the SSO event with the rejected token, without refresh or auth:unauthorized', async () => {
    localStorage.setItem('auth-token', 'token-synthetic');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(reauth());
    const events = listen();
    try {
      const response = await authenticatedFetch('/api/projects');
      expect(response.status).toBe(401);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls.some(([url]) => String(url).includes('/api/auth/refresh'))).toBe(false);
      expect(events.onReauth).toHaveBeenCalledTimes(1);
      expect((events.onReauth.mock.calls[0][0] as CustomEvent).detail).toEqual({ token: 'token-synthetic' });
      expect(events.onUnauthorized).not.toHaveBeenCalled();
    } finally {
      events.stop();
    }
  });

  it('a refused POST /refresh also asks for SSO instead of failing silently', async () => {
    localStorage.setItem('auth-token', 'token-synthetic');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(reauth());
    const events = listen();
    try {
      expect(await refreshAuthToken()).toBeNull();
      expect(events.onReauth).toHaveBeenCalledTimes(1);
      expect(events.onUnauthorized).not.toHaveBeenCalled();
    } finally {
      events.stop();
    }
  });

  it('a plain code-less 401 still takes the old logout path', async () => {
    localStorage.setItem('auth-token', 'token-synthetic');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: 'x' }), { status: 401 }));
    const events = listen();
    try {
      await authenticatedFetch('/api/projects', { method: 'POST', body: '{}' });
      expect(events.onReauth).not.toHaveBeenCalled();
      expect(events.onUnauthorized).toHaveBeenCalledTimes(1);
    } finally {
      events.stop();
    }
  });
});

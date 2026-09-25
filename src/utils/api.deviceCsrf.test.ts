import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  beginIdentityTransition,
  commitIdentityTransition,
  getIdentityBarrierSnapshot,
  stabilizeIdentityBarrier,
} from '../components/auth/accountIdentityBarrier';

import { authenticatedFetch, setCookieSessionKind } from './api.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  localStorage.clear();
  setCookieSessionKind('none');
  stabilizeIdentityBarrier(getIdentityBarrierSnapshot().version);
});

afterEach(() => {
  vi.restoreAllMocks();
  setCookieSessionKind('none');
  stabilizeIdentityBarrier(getIdentityBarrierSnapshot().version);
});

describe('device-session mutation CSRF', () => {
  it.each(['device', 'limited'] as const)(
    'binds a %s cookie mutation to its method and canonical pathname without Bearer',
    async (sessionKind) => {
    setCookieSessionKind(sessionKind);
    const fetch = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ csrfToken: 'expiry.hmac', expiresAt: Date.now() + 60_000 }))
      .mockResolvedValueOnce(json({ ok: true }));

    const response = await authenticatedFetch('/api/settings/ui-preferences?ignored=1', {
      method: 'PUT', body: '{}',
    });

    expect(response.ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0][0]).toBe('/api/auth/mutation-csrf?method=PUT&path=%2Fapi%2Fsettings%2Fui-preferences');
    const mutation = fetch.mock.calls[1][1] as RequestInit;
    expect(mutation.credentials).toBe('same-origin');
    expect(mutation.headers).toMatchObject({ 'X-CSRF-Token': 'expiry.hmac' });
    expect((mutation.headers as Record<string, string>).Origin).toBeUndefined();
    expect((mutation.headers as Record<string, string>).Authorization).toBeUndefined();
    },
  );

  it('keeps legacy bearer mutations on the bearer path without a cookie CSRF probe', async () => {
    localStorage.setItem('auth-token', 'legacy-token');
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ ok: true }));
    await authenticatedFetch('/api/settings/ui-preferences', { method: 'PUT', body: '{}' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1]?.headers).toMatchObject({ Authorization: 'Bearer legacy-token' });
  });

  it('fails closed when the cookie cannot obtain CSRF and never sends the mutation', async () => {
    setCookieSessionKind('device');
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ code: 'device_session_invalid' }, 401));
    const response = await authenticatedFetch('/api/settings/ui-preferences', { method: 'PUT', body: '{}' });
    expect(response.status).toBe(401);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(getIdentityBarrierSnapshot().phase).toBe('committed');
  });

  it('fences a cookie mutation rejected after its CSRF probe without replaying it', async () => {
    setCookieSessionKind('device');
    const fetch = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ csrfToken: 'expiry.hmac', expiresAt: Date.now() + 60_000 }))
      .mockResolvedValueOnce(json({ code: 'device_session_invalid' }, 401));
    const response = await authenticatedFetch('/api/settings/ui-preferences', { method: 'PUT' });
    expect(response.status).toBe(401);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(getIdentityBarrierSnapshot().phase).toBe('committed');
  });

  it('keeps a device session stable for a domain/provider 401 and never replays it', async () => {
    setCookieSessionKind('device');
    const fetch = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ csrfToken: 'expiry.hmac', expiresAt: Date.now() + 60_000 }))
      .mockResolvedValueOnce(json({ code: 'PROVIDER_AUTH_REQUIRED', error: 'provider rejected' }, 401));
    const response = await authenticatedFetch('/api/provider/action', { method: 'POST' });
    expect(response.status).toBe(401);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(getIdentityBarrierSnapshot().phase).toBe('stable');
  });

  it('does not let a late account A 401 classifier fence account B', async () => {
    setCookieSessionKind('device');
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const delayedBody = new ReadableStream<Uint8Array>({ start: (controller) => { body = controller; } });
    const fetch = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ csrfToken: 'expiry.hmac', expiresAt: Date.now() + 60_000 }))
      .mockResolvedValueOnce(new Response(delayedBody, {
        status: 401, headers: { 'Content-Type': 'application/json' },
      }));
    const pending = authenticatedFetch('/api/settings/ui-preferences', { method: 'PUT' });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    const version = beginIdentityTransition('switch');
    commitIdentityTransition(version, 'switch');
    body.enqueue(new TextEncoder().encode(JSON.stringify({ code: 'device_session_invalid' })));
    body.close();
    expect((await pending).status).toBe(401);
    expect(getIdentityBarrierSnapshot()).toMatchObject({ phase: 'committed', version, reason: 'switch' });
  });

  it('rejects malformed or expired CSRF material without sending the mutation', async () => {
    setCookieSessionKind('device');
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json({ csrfToken: 'expired.hmac', expiresAt: Date.now() - 1 }),
    );
    const response = await authenticatedFetch('/api/settings/ui-preferences', { method: 'PUT' });
    expect(response.status).toBe(403);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(getIdentityBarrierSnapshot().phase).toBe('committed');
  });

  it('does not refresh or replay an unsafe bearer mutation after rejection', async () => {
    localStorage.setItem('auth-token', 'legacy-token');
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ error: 'expired' }, 401));
    const response = await authenticatedFetch('/api/private', { method: 'POST', body: '{}' });
    expect(response.status).toBe(401);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

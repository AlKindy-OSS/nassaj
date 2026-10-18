// ADR-H20: an idle SSO session (401 sso_session_expired) restarts SSO like an
// aged-out attestation. A 403 is never a sign-out and opens no passkey prompt
// (the N2 owner step-up was withdrawn 2026-10-18).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  authenticatedFetch,
  isSsoReauthRejection,
  SSO_REAUTH_EVENT,
} from './api';

const respond = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

beforeEach(() => localStorage.setItem('auth-token', 'token-synthetic'));
afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('ADR-H20 codes in the API client', () => {
  it('classifies sso_session_expired as an SSO restart', async () => {
    expect(await isSsoReauthRejection(respond(401, { code: 'sso_session_expired' }))).toBe(true);
    expect(await isSsoReauthRejection(respond(403, { code: 'sso_session_expired' }))).toBe(false);
  });

  it('an idle SSO session restarts SSO (no plain logout)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(401, { error: 'Session expired', code: 'sso_session_expired' })));
    const reauth = vi.fn();
    const unauthorized = vi.fn();
    window.addEventListener(SSO_REAUTH_EVENT, reauth);
    window.addEventListener('auth:unauthorized', unauthorized);
    try {
      await authenticatedFetch('/api/probe');
    } finally {
      window.removeEventListener(SSO_REAUTH_EVENT, reauth);
      window.removeEventListener('auth:unauthorized', unauthorized);
    }
    expect(reauth).toHaveBeenCalledTimes(1);
    expect(unauthorized).not.toHaveBeenCalled();
  });

  it('a 403 keeps the session and raises no passkey prompt event', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(403, { code: 'owner_step_up_required' })));
    const stepUp = vi.fn();
    window.addEventListener('auth:owner-step-up-required', stepUp);
    try {
      const response = await authenticatedFetch('/api/settings/x', { method: 'PUT', body: '{}' });
      expect(response.status).toBe(403);
    } finally {
      window.removeEventListener('auth:owner-step-up-required', stepUp);
    }
    expect(stepUp).not.toHaveBeenCalled();
    expect(localStorage.getItem('auth-token')).toBe('token-synthetic');
  });
});

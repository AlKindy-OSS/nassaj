// ADR-H20: an idle SSO session (401 sso_session_expired) restarts SSO like an
// aged-out attestation; a 403 owner_step_up_required asks for the passkey
// step-up and is never a sign-out.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  authenticatedFetch,
  isOwnerStepUpRejection,
  isSsoReauthRejection,
  OWNER_STEP_UP_EVENT,
  SSO_REAUTH_EVENT,
} from './api';

const respond = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

beforeEach(() => localStorage.setItem('auth-token', 'token-synthetic'));
afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('ADR-H20 codes in the API client', () => {
  it('classifies sso_session_expired as an SSO restart and owner_step_up_required as a step-up', async () => {
    expect(await isSsoReauthRejection(respond(401, { code: 'sso_session_expired' }))).toBe(true);
    expect(await isSsoReauthRejection(respond(403, { code: 'sso_session_expired' }))).toBe(false);
    expect(await isOwnerStepUpRejection(respond(403, { code: 'owner_step_up_required' }))).toBe(true);
    expect(await isOwnerStepUpRejection(respond(403, { code: 'insufficient' }))).toBe(false);
    expect(await isOwnerStepUpRejection(new Response('not json', { status: 403 }))).toBe(false);
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

  it('a refused privileged action opens the step-up prompt and keeps the session', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(403, { code: 'owner_step_up_required' })));
    const stepUp = vi.fn();
    window.addEventListener(OWNER_STEP_UP_EVENT, stepUp);
    try {
      const response = await authenticatedFetch('/api/settings/x', { method: 'PUT', body: '{}' });
      expect(response.status).toBe(403);
    } finally {
      window.removeEventListener(OWNER_STEP_UP_EVENT, stepUp);
    }
    expect(stepUp).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('auth-token')).toBe('token-synthetic');
  });
});

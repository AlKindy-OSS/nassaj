import { beforeEach, describe, expect, it, vi } from 'vitest';

const { authenticatedFetch } = vi.hoisted(() => ({ authenticatedFetch: vi.fn() }));
vi.mock('../../../../utils/api', () => ({ authenticatedFetch }));

import {
  loadConnectorOwnerSetup, mutateConnectorOwnerSetup, parseConnectorOwnerSetupStatus,
  verifyConnectorOwnerProfile,
} from './connectorOwnerSetupClient';

const status = (step: string = 'trust') => ({
  schemaVersion: 1, readyForAccountLinking: false, resumableStep: step,
  checks: [
    { id: 'substrate', status: 'ok', code: 'CONNECTOR_SUBSTRATE_READY' },
    { id: 'origin', status: 'ok', code: 'CONNECTOR_ORIGIN_READY' },
    { id: 'trust', status: 'required', code: 'CONNECTOR_TRUST_REQUIRED' },
    { id: 'pack', status: 'blocked', code: 'CONNECTOR_PACK_REQUIRED' },
    { id: 'activation', status: 'blocked', code: 'CONNECTOR_ACTIVATION_REQUIRED' },
  ],
  origin: { installationId: 'install-1', canonicalOrigin: 'https://nassaj.example',
    callbackUrl: 'https://nassaj.example/connectors/oauth/callback', originRevision: 1 },
  trustBundleRevision: 0, activePack: null, packExpiresAt: null, warnings: [],
  activationRecordRevision: 0, activationCandidates: [],
});

beforeEach(() => authenticatedFetch.mockReset());

describe('owner setup API client', () => {
  it('parses resumable secret-free truth and rejects malformed candidates', () => {
    expect(parseConnectorOwnerSetupStatus(status())?.resumableStep).toBe('trust');
    expect(parseConnectorOwnerSetupStatus({ ...status('activation'), activationCandidates: [{
      providerId: 'google', serviceId: 'gmail', operation: 'oauth', authMethod: 'byo_app',
      certification: 'certified', enabled: false, profileRequired: true, profileState: 'ready',
      profileRevision: 1, blockerCodes: [],
    }] })?.activationCandidates).toHaveLength(1);
    expect(parseConnectorOwnerSetupStatus({ ...status('activation'), activationCandidates: [{
      providerId: 'google', serviceId: 'gmail', operation: 'oauth', authMethod: 'byo_app',
      certification: 'mystery', enabled: false, profileRequired: true, profileState: 'ready',
      profileRevision: 1, blockerCodes: [],
    }] })).toBeNull();
  });

  it('sends CAS, idempotency, CSRF, and the exact mutation body', async () => {
    authenticatedFetch.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const body = { canonicalOrigin: 'https://nassaj.example', expectedOriginRevision: 1 };
    await mutateConnectorOwnerSetup({ route: 'origin', method: 'PUT', expectedRevision: 1,
      csrfToken: 'c'.repeat(64), idempotencyKey: 'setup-request-123', body });
    const [, init] = authenticatedFetch.mock.calls[0];
    expect(init.headers).toMatchObject({ 'If-Match': '"1"', 'Idempotency-Key': 'setup-request-123',
      'x-csrf-token': 'c'.repeat(64) });
    expect(JSON.parse(init.body)).toEqual(body);
    expect(init.body).not.toContain('secret');
  });

  it('passes AbortSignal to the owner-only status request', async () => {
    authenticatedFetch.mockResolvedValue(new Response(JSON.stringify(status()), { status: 200 }));
    const controller = new AbortController();
    await loadConnectorOwnerSetup(controller.signal);
    expect(authenticatedFetch).toHaveBeenCalledWith('/api/connectors/v2/owner/setup',
      { signal: controller.signal });
  });

  it('verifies a profile through the exact secret-free response contract', async () => {
    authenticatedFetch.mockResolvedValue(new Response(JSON.stringify({ providerId: 'google',
      profileState: 'ready', profileRevision: 2, setupRevision: 3 }), { status: 200 }));
    await expect(verifyConnectorOwnerProfile({ providerId: 'google', expectedRevision: 1,
      csrfToken: 'csrf', body: { method: 'byo_app', clientId: 'id', clientSecret: 'secret' },
      idempotencyKey: 'idem' })).resolves.toEqual({
      providerId: 'google', profileState: 'ready', profileRevision: 2, setupRevision: 3,
    });
    const [url, init] = authenticatedFetch.mock.calls[0];
    expect(url).toBe('/api/connectors/v2/owner/setup/profiles/google/verify');
    expect(init.headers).toMatchObject({ 'If-Match': '"1"', 'Idempotency-Key': 'idem',
      'x-csrf-token': 'csrf' });
    expect(JSON.parse(init.body)).toEqual({ method: 'byo_app', clientId: 'id', clientSecret: 'secret' });
  });

  it('rejects a profile response containing a reflected secret', async () => {
    authenticatedFetch.mockResolvedValue(new Response(JSON.stringify({ providerId: 'google',
      profileState: 'ready', profileRevision: 2, setupRevision: 3, clientSecret: 'reflected' }),
    { status: 200 }));
    await expect(verifyConnectorOwnerProfile({ providerId: 'google', expectedRevision: 1,
      csrfToken: 'csrf', body: { method: 'dcr_pkce' } })).rejects.toMatchObject({
      code: 'CONNECTOR_SETUP_RESPONSE_INVALID', status: 502,
    });
  });
});

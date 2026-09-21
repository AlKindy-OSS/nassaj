/* eslint-disable import-x/order -- module mocks must exist before the component imports */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConnectorCatalogEntry } from '../../../../stores/connectorsStore';

const translations: Record<string, string> = {
  'connectorsSettings.title': 'Connectors',
  'connectorsSettings.connected': 'Linked accounts',
  'connectorsSettings.addPlatform': 'Add a platform',
  'connectorsSettings.accountLabel': 'Account name',
  'connectorsSettings.keyStoredNote': 'Stored encrypted; never shown again.',
  'connectorsSettings.connect': 'Connect',
  'connectorsSettings.cancel': 'Cancel',
};

const { navigateToConnectorAuthorization } = vi.hoisted(() => ({
  navigateToConnectorAuthorization: vi.fn(),
}));
vi.mock('./connectorNavigation', () => ({ navigateToConnectorAuthorization }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => String(translations[key] ?? options?.defaultValue ?? key),
    i18n: { language: 'en' },
  }),
}));

let role: 'owner' | 'member' = 'owner';
const logout = vi.fn();
vi.mock('../../../auth/context/AuthContext', () => ({
  useOptionalAuth: () => ({ user: { id: 7, username: 'person', role }, logout }),
}));

type Call = { url: string; method: string; body?: Record<string, unknown>; headers?: HeadersInit };
const calls: Call[] = [];
let readinessAvailable = true;
let readinessFailureCode = 'NOT_FOUND';
let readinessCsrf: string | null = 'a'.repeat(64);
let recentAuthRequired = false;
let rejectNextWriteAsStale = false;
let failNextOAuthStart = false;
let loseNextDraftResponse = false;
let reconcileVerified = true;
let grants: Array<Record<string, unknown>> = [];
let persistedDrafts: Array<Record<string, unknown>> = [];
let profiles: Array<Record<string, unknown>> = [];
let nextApiGrantOverride: Record<string, unknown> | null = null;
let failGrantFetch = false;
let grantsFailureCode: string | null = null;
let malformedGrantPayload = false;
let readinessSchemaVersion: number = 1;
let ownerSetupFailureCode: string | null = null;
let ownerSetupMutationErrorCode: string | null = null;

const ownerSetupFixture = (resumableStep: 'origin' | 'trust' | 'provider_pack' | 'activation' | 'complete' = 'origin') => ({
  schemaVersion: 1,
  readyForAccountLinking: resumableStep === 'complete',
  resumableStep,
  checks: [
    { id: 'substrate', status: 'ok', code: 'CONNECTOR_SUBSTRATE_READY' },
    { id: 'origin', status: resumableStep === 'origin' ? 'required' : 'ok', code: 'ORIGIN' },
    { id: 'trust', status: resumableStep === 'trust' ? 'required' : 'ok', code: 'TRUST' },
    { id: 'pack', status: resumableStep === 'provider_pack' ? 'required' : 'ok', code: 'PACK' },
    { id: 'activation', status: resumableStep === 'complete' ? 'ok' : 'required', code: 'ACTIVATION' },
  ],
  origin: resumableStep === 'origin' ? null : {
    installationId: 'install-1', canonicalOrigin: 'https://nassaj.example',
    callbackUrl: 'https://nassaj.example/connectors/oauth/callback', originRevision: 1,
  },
  trustBundleRevision: ['origin', 'trust'].includes(resumableStep) ? 0 : 1,
  activePack: ['activation', 'complete'].includes(resumableStep)
    ? { issuer: 'nassaj', channel: 'stable', sequence: 1, digest: 'a'.repeat(43), expiresAt: null } : null,
  packExpiresAt: null, warnings: [],
  activationRecordRevision: resumableStep === 'complete' ? 1 : 0,
  activationCandidates: [] as Array<Record<string, unknown>>,
});
let ownerSetupPayload: Record<string, unknown> = ownerSetupFixture();

const grantContract = (grant: Record<string, unknown>) => ({
  bundleState: 'stored', verificationState: 'verified', operationalState: 'eligible',
  eligible: true, availabilityState: 'available_next_session', reasonCode: null,
  credentialExpiresAt: null, canRetryVerification: false, canReconnect: true,
  canRemove: true, grantedServices: [String(grant.serviceId)],
  availableBodies: ['claude', 'codex'], pendingBodies: [], ...grant,
});

const catalog: ConnectorCatalogEntry[] = [
  ...['gmail', 'google-drive', 'google-calendar'].map((service): ConnectorCatalogEntry => ({
    service,
    displayName: service === 'gmail' ? 'Gmail' : service === 'google-drive' ? 'Google Drive' : 'Google Calendar',
    summary: 'Google service', allowsSharing: false, official: true, authMode: 'oauth',
    authMetadata: {
      profileId: 'google-workspace', method: 'byo_app', readiness: 'owner_setup_required',
      canSubmitCredential: false, canStartOAuth: true, canStoreUnverified: false,
      credentialInputSchema: null,
      submitSemantics: { operation: 'start_oauth', credentialPayload: 'none', activation: 'after_callback_verification', requiresExplicitUnverifiedConsent: false, unverifiedConsentPayload: 'none' },
      accountBundle: { id: 'google-workspace', label: 'Google Workspace' },
    },
  })),
  {
    service: 'github', displayName: 'GitHub', summary: 'Repositories', allowsSharing: false,
    official: true, authMode: 'key', keyLabel: 'Personal token',
    authMetadata: { profileId: 'github', method: 'api_key', readiness: 'ready',
      canSubmitCredential: true, canStartOAuth: false, canStoreUnverified: false,
      credentialInputSchema: { schemaVersion: 1, shape: 'single_api_key', fields: [
        { id: 'api_key', label: 'Personal token', inputType: 'password', required: true },
      ] }, submitSemantics: { operation: 'put_personal_api_key', credentialPayload: 'apiKey', activation: 'after_verification', requiresExplicitUnverifiedConsent: false, unverifiedConsentPayload: 'none' } },
  },
  {
    service: 'notion', displayName: 'Notion', summary: 'Pages', allowsSharing: false,
    official: true, authMode: 'oauth',
    authMetadata: { profileId: 'notion', method: 'dcr_pkce', readiness: 'ready',
      canSubmitCredential: false, canStartOAuth: false, canStoreUnverified: false, credentialInputSchema: null },
  },
  {
    service: 'canva', displayName: 'Canva', summary: 'Designs', allowsSharing: false,
    official: true, authMode: 'oauth',
    authMetadata: { profileId: 'canva', method: 'byo_app', readiness: 'unsupported',
      canSubmitCredential: false, canStartOAuth: false, canStoreUnverified: false, credentialInputSchema: null },
  },
  {
    service: 'salla', displayName: 'Salla', summary: 'Store', allowsSharing: false,
    official: true, authMode: 'key', keyLabel: 'Access token',
    authMetadata: { profileId: 'salla', method: 'api_key', readiness: 'ready',
      canSubmitCredential: true, canStartOAuth: false, canStoreUnverified: true,
      credentialInputSchema: { schemaVersion: 1, shape: 'single_api_key', fields: [
        { id: 'api_key', label: 'Access token', inputType: 'password', required: true },
      ] }, submitSemantics: { operation: 'put_personal_api_key', credentialPayload: 'apiKey', activation: 'stored_inert', requiresExplicitUnverifiedConsent: true, unverifiedConsentPayload: 'acceptStoredUnverified' } },
  },
  {
    service: 'geidea', displayName: 'Geidea', summary: 'Payments', allowsSharing: false,
    official: true, authMode: 'key',
    authMetadata: { profileId: 'geidea', method: 'api_key', readiness: 'ready',
      canSubmitCredential: true, canStartOAuth: false, canStoreUnverified: true,
      credentialInputSchema: { schemaVersion: 1, shape: 'geidea_basic', fields: [
        { id: 'merchant_public_key', label: 'Merchant public key', inputType: 'text', required: true },
        { id: 'api_password', label: 'API password', inputType: 'password', required: true },
      ] }, submitSemantics: { operation: 'put_personal_api_key', credentialPayload: 'credentialFields', activation: 'stored_inert', requiresExplicitUnverifiedConsent: true, unverifiedConsentPayload: 'acceptStoredUnverified' } },
  },
];

vi.mock('../../../../utils/api', () => ({
  authenticatedFetch: vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({
      url, method,
      ...(init?.body ? { body: JSON.parse(String(init.body)) as Record<string, unknown> } : {}),
      headers: init?.headers,
    });
    if (method !== 'GET' && rejectNextWriteAsStale) {
      rejectNextWriteAsStale = false;
      return {
        ok: false, status: 403,
        json: async () => ({ code: 'CONNECTOR_RECENT_AUTH_REQUIRED' }),
      } as Response;
    }
    if (url === '/api/connectors/auth-readiness') {
      return readinessAvailable
        ? { ok: true, status: 200, json: async () => ({
          schemaVersion: readinessSchemaVersion,
          csrfToken: readinessCsrf, recentAuthRequired, profiles,
        }) } as Response
        : { ok: false, status: 404, json: async () => ({ code: readinessFailureCode }) } as Response;
    }
    if (url === '/api/connectors/v2/owner/setup' && method === 'GET') {
      return ownerSetupFailureCode
        ? { ok: false, status: 503, json: async () => ({ code: ownerSetupFailureCode }) } as Response
        : { ok: true, status: 200, json: async () => ownerSetupPayload } as Response;
    }
    if (url.startsWith('/api/connectors/v2/owner/setup/') && method !== 'GET') {
      return ownerSetupMutationErrorCode
        ? { ok: false, status: 403, json: async () => ({ code: ownerSetupMutationErrorCode }) } as Response
        : { ok: true, status: 200, json: async () => ({ accepted: true }) } as Response;
    }
    if (url === '/api/connectors/grants') {
      if (failGrantFetch) return {
        ok: false, status: grantsFailureCode ? 404 : 500,
        json: async () => grantsFailureCode
          ? { code: grantsFailureCode }
          : { error: 'sensitive upstream detail must not render' },
      } as Response;
      if (malformedGrantPayload) return {
        ok: true, status: 200, json: async () => ({ grants: { unknown: true } }),
      } as Response;
      return { ok: true, status: 200, json: async () => ({ grants: grants.map(grantContract) }) } as Response;
    }
    if (url === '/api/connectors/catalog') {
      return { ok: true, status: 200, json: async () => ({ schemaVersion: 2, catalog }) } as Response;
    }
    if (url === '/api/connectors/targets') {
      return { ok: true, status: 200, json: async () => ({ targets: [] }) } as Response;
    }
    if (url === '/api/connectors') {
      if (method === 'POST') {
        const body = JSON.parse(String(init?.body)) as { service: string; accountLabel: string };
        const connector = {
          id: `${body.service}-${body.accountLabel.toLowerCase()}-u7`,
          service: body.service, accountLabel: body.accountLabel, ownerUserId: 7,
          authMode: body.service === 'github' ? 'key' : 'oauth',
          credentialMode: 'per_member', configured: false,
        };
        persistedDrafts.push(connector);
        if (loseNextDraftResponse) {
          loseNextDraftResponse = false;
          throw new TypeError('network response lost');
        }
        return { ok: true, status: 201, json: async () => ({
          connector,
        }) } as Response;
      }
      return { ok: true, status: 200, json: async () => ({
        connectors: [...persistedDrafts, ...grants.map(grant => ({
          id: `${String(grant.serviceId)}-linked-u7`, service: grant.serviceId,
          accountLabel: grant.accountLabel, ownerUserId: 7,
          authMode: grant.serviceId === 'github' ? 'key' : 'oauth',
          credentialMode: 'per_member', configured: true, availableNextSession: true,
        }))],
      }) } as Response;
    }
    if (url === '/api/connectors/oauth-v2/gmail/start') {
      if (failNextOAuthStart) {
        failNextOAuthStart = false;
        return { ok: false, status: 503, json: async () => ({ error: 'temporarily unavailable' }) } as Response;
      }
      return { ok: true, status: 200, json: async () => ({
        authorizeUrl: 'https://accounts.google.test/authorize',
      }) } as Response;
    }
    if (/^\/api\/connectors\/[^/]+\/reconcile$/u.test(url)) {
      return { ok: true, status: reconcileVerified ? 200 : 207, json: async () => ({
        result: { state: reconcileVerified ? 'verified' : 'degraded' },
        connector: { availableNextSession: reconcileVerified },
      }) } as Response;
    }
    if (/\/api-key$/u.test(url)) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const serviceId = url.split('/').at(-2)!;
      const storedOnly = body.acceptStoredUnverified === true;
      return { ok: true, status: 200, json: async () => ({
        grant: nextApiGrantOverride ?? grantContract({
          grantId: 'new', serviceId, accountLabel: body.accountLabel, status: storedOnly ? 'pending' : 'active',
          ...(storedOnly ? {
            verificationState: 'stored_unverified', operationalState: 'ineligible', eligible: false,
            availabilityState: 'stored_only', canRetryVerification: true, availableBodies: [],
          } : {}),
        }),
      }) } as Response;
    }
    return { ok: true, status: 200, json: async () => ({ grant: { grantId: 'new' } }) } as Response;
  }),
}));

import { resetConnectorsStore } from '../../../../stores/connectorsStore';
import ConnectorsSettingsTabM1 from './ConnectorsSettingsTabM1';

beforeEach(() => {
  role = 'owner';
  readinessAvailable = true;
  readinessFailureCode = 'NOT_FOUND';
  readinessCsrf = 'a'.repeat(64);
  recentAuthRequired = false;
  rejectNextWriteAsStale = false;
  failNextOAuthStart = false;
  loseNextDraftResponse = false;
  reconcileVerified = true;
  logout.mockReset();
  navigateToConnectorAuthorization.mockReset();
  grants = [];
  nextApiGrantOverride = null;
  failGrantFetch = false;
  grantsFailureCode = null;
  malformedGrantPayload = false;
  readinessSchemaVersion = 1;
  ownerSetupFailureCode = null;
  ownerSetupMutationErrorCode = null;
  ownerSetupPayload = ownerSetupFixture();
  persistedDrafts = [];
  profiles = [
    { providerId: 'google-workspace', services: ['gmail', 'google-drive', 'google-calendar'], authMethod: 'byo_app', readiness: 'ready', configured: true, status: 'ready', setup: { callbackUrl: 'https://nassaj.example/connectors/oauth/callback', appRegistrationUrl: 'https://console.cloud.google.com/apis/credentials' } },
    { providerId: 'notion', services: ['notion'], authMethod: 'dcr_pkce', readiness: 'owner_setup_required', configured: false, status: 'not_configured' },
    { providerId: 'github', services: ['github'], authMethod: 'api_key', readiness: 'ready', configured: false, status: 'not_configured' },
    { providerId: 'canva', services: ['canva'], authMethod: 'byo_app', readiness: 'unsupported', configured: false, status: 'not_configured' },
    { providerId: 'salla', services: ['salla'], authMethod: 'api_key', readiness: 'ready', configured: true, status: 'ready' },
    { providerId: 'geidea', services: ['geidea'], authMethod: 'api_key', readiness: 'ready', configured: true, status: 'ready' },
  ];
  calls.length = 0;
  resetConnectorsStore();
});

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('dir');
});

describe('portable connectors M1 surface', () => {
  it('blocks every visible write and shows one re-login action when recent auth is absent', async () => {
    readinessCsrf = null;
    recentAuthRequired = true;
    grants = [{ grantId: 'g1', serviceId: 'gmail', accountLabel: 'Work', isDefault: true, status: 'active' }];
    profiles[0] = {
      ...profiles[0], readiness: 'owner_setup_required', configured: false, status: 'not_configured',
    };
    render(<ConnectorsSettingsTabM1 />);

    const button = await screen.findByRole('button', { name: 'Sign in again' });
    expect(screen.getAllByRole('button', { name: 'Sign in again' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Connect with key' })).toBeNull();
    expect((screen.getByRole('button', { name: /Remove account: Work — Google Workspace/u }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole('tab', { name: 'Installation setup' }));
    expect(await screen.findByRole('heading', { name: 'Owner installation setup' })).toBeTruthy();
    const save = screen.getByRole('button', { name: 'Save and continue' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    const writesBefore = calls.filter(call => call.method !== 'GET').length;
    fireEvent.click(save);
    expect(calls.filter(call => call.method !== 'GET')).toHaveLength(writesBefore);

    fireEvent.click(button);
    expect(logout).toHaveBeenCalledOnce();
  });

  it('treats a null CSRF token as stale even when the server boolean is false', async () => {
    readinessCsrf = null;
    recentAuthRequired = false;
    render(<ConnectorsSettingsTabM1 />);
    expect(await screen.findByRole('button', { name: 'Sign in again' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Connect with key' })).toBeNull();
  });

  it('closes the API-key handler after a write-time recent-auth rejection', async () => {
    render(<ConnectorsSettingsTabM1 />);
    const github = (await screen.findByRole('heading', { name: 'GitHub' })).closest('article')!;
    fireEvent.click(within(github).getByRole('button', { name: 'Connect with key' }));
    fireEvent.change(within(github).getByLabelText('Account name'), { target: { value: 'Personal' } });
    fireEvent.change(within(github).getByLabelText('Personal token'), { target: { value: 'secret' } });
    rejectNextWriteAsStale = true;
    fireEvent.click(within(github).getByRole('button', { name: 'Connect' }));
    expect(await screen.findByRole('button', { name: 'Sign in again' })).toBeTruthy();
    const writesAfterRejection = calls.filter(call => call.method !== 'GET').length;
    expect(within(github).queryByRole('button', { name: 'Connect' })).toBeNull();
    expect(calls.filter(call => call.method !== 'GET')).toHaveLength(writesAfterRejection);
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
  });

  it('closes the OAuth handler after a write-time recent-auth rejection', async () => {
    render(<ConnectorsSettingsTabM1 />);
    const google = (await screen.findByRole('heading', { name: 'Google Workspace' })).closest('article')!;
    fireEvent.click(within(google).getByRole('button', { name: 'Add account' }));
    fireEvent.change(within(google).getByLabelText('Account name'), { target: { value: 'Work' } });
    rejectNextWriteAsStale = true;
    fireEvent.click(within(google).getByRole('button', { name: 'Continue to sign in' }));
    await screen.findByRole('button', { name: 'Sign in again' });
    const writes = calls.filter(call => call.method !== 'GET').length;
    expect(within(google).queryByRole('button', { name: 'Add account' })).toBeNull();
    expect(within(google).queryByRole('button', { name: /Grant .* access/u })).toBeNull();
    expect(calls.filter(call => call.method !== 'GET')).toHaveLength(writes);
  });

  it('creates an exact OAuth connector draft before starting V2 with its connectorId', async () => {
    grants = [{ grantId: 'g1', serviceId: 'gmail', accountLabel: 'Existing', status: 'active' }];
    render(<ConnectorsSettingsTabM1 />);
    const google = (await screen.findByRole('heading', { name: 'Google Workspace' })).closest('article')!;
    fireEvent.click(within(google).getByRole('button', { name: 'Add account' }));
    fireEvent.change(within(google).getByLabelText('Account name'), { target: { value: ' Work ' } });
    fireEvent.click(within(google).getByRole('button', { name: 'Continue to sign in' }));

    await waitFor(() => expect(calls.some(call =>
      call.url === '/api/connectors/oauth-v2/gmail/start')).toBe(true));
    const writes = calls.filter(call => call.method === 'POST');
    expect(writes[0]).toMatchObject({
      url: '/api/connectors', body: { service: 'gmail', accountLabel: 'Work' },
    });
    expect(writes[1]).toMatchObject({
      url: '/api/connectors/oauth-v2/gmail/start',
      body: { connectorId: 'gmail-work-u7' },
    });
  });

  it('retries OAuth start with the same local draft after a temporary start failure', async () => {
    grants = [{ grantId: 'g1', serviceId: 'gmail', accountLabel: 'Existing', status: 'active' }];
    render(<ConnectorsSettingsTabM1 />);
    const google = (await screen.findByRole('heading', { name: 'Google Workspace' })).closest('article')!;
    fireEvent.click(within(google).getByRole('button', { name: 'Add account' }));
    fireEvent.change(within(google).getByLabelText('Account name'), { target: { value: 'Work' } });
    failNextOAuthStart = true;
    fireEvent.click(within(google).getByRole('button', { name: 'Continue to sign in' }));
    await screen.findByRole('alert');
    fireEvent.click(within(google).getByRole('button', { name: 'Continue to sign in' }));
    await waitFor(() => expect(calls.filter(call =>
      call.url === '/api/connectors/oauth-v2/gmail/start')).toHaveLength(2));
    expect(calls.filter(call => call.url === '/api/connectors' && call.method === 'POST')).toHaveLength(1);
  });

  it('recovers the exact committed draft when its create response is lost without creating a duplicate', async () => {
    loseNextDraftResponse = true;
    grants = [{ grantId: 'g1', serviceId: 'gmail', accountLabel: 'Existing', status: 'active' }];
    render(<ConnectorsSettingsTabM1 />);
    const google = (await screen.findByRole('heading', { name: 'Google Workspace' })).closest('article')!;
    fireEvent.click(within(google).getByRole('button', { name: 'Add account' }));
    fireEvent.change(within(google).getByLabelText('Account name'), { target: { value: 'Work' } });
    fireEvent.click(within(google).getByRole('button', { name: 'Continue to sign in' }));

    await waitFor(() => expect(calls.some(call =>
      call.url === '/api/connectors/oauth-v2/gmail/start')).toBe(true));
    expect(calls.filter(call => call.url === '/api/connectors' && call.method === 'POST')).toHaveLength(1);
    expect(persistedDrafts).toHaveLength(1);
    expect(calls.find(call => call.url === '/api/connectors/oauth-v2/gmail/start')?.body)
      .toEqual({ connectorId: 'gmail-work-u7' });
  });

  it('closes the revoke handler after authentication becomes stale', async () => {
    grants = [{ grantId: 'g1', serviceId: 'gmail', accountLabel: 'Work', isDefault: true, status: 'active' }];
    render(<ConnectorsSettingsTabM1 />);
    const remove = await screen.findByRole('button', { name: /Remove account: Work — Google Workspace/u });
    rejectNextWriteAsStale = true;
    fireEvent.click(remove);
    await screen.findByRole('button', { name: 'Sign in again' });
    const writesAfterRevoke = calls.filter(call => call.method !== 'GET').length;
    fireEvent.click(remove);
    expect(calls.filter(call => call.method !== 'GET')).toHaveLength(writesAfterRevoke);

  });

  it('blocks owner setup writes when recent authentication is stale', async () => {
    readinessCsrf = null;
    recentAuthRequired = true;
    render(<ConnectorsSettingsTabM1 />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Installation setup' }));
    const save = await screen.findByRole('button', { name: 'Save and continue' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    expect(calls.filter(call => call.method !== 'GET')).toHaveLength(0);
  });

  it('loads installation setup only from the owner setup API', async () => {
    render(<ConnectorsSettingsTabM1 />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Installation setup' }));
    expect(await screen.findByLabelText('Canonical HTTPS origin')).toBeTruthy();
    expect(calls.filter(call => call.url === '/api/connectors/v2/owner/setup')).toHaveLength(1);
    expect(calls.some(call => call.url === '/api/connectors/v2/installation/catalog')).toBe(false);
    expect(calls.some(call => call.url.startsWith('/api/connectors/auth-profiles'))).toBe(false);
    expect(screen.queryByLabelText('Client ID')).toBeNull();
    expect(screen.queryByLabelText('Client secret')).toBeNull();
  });

  it('renders Google Workspace as one account row with three explicit service scopes', async () => {
    grants = [{ grantId: 'g1', serviceId: 'gmail', accountLabel: 'Work', isDefault: true, status: 'active' }];
    render(<ConnectorsSettingsTabM1 />);

    expect(await screen.findByRole('heading', { name: 'Linked accounts' })).toBeTruthy();
    expect(screen.getAllByRole('heading', { name: 'Google Workspace' })).toHaveLength(1);
    const card = screen.getByRole('heading', { name: 'Google Workspace' }).closest('article')!;
    expect(within(card).getAllByText('Gmail').length).toBeGreaterThan(0);
    expect(within(card).getByText('Google Drive')).toBeTruthy();
    expect(within(card).getByText('Google Calendar')).toBeTruthy();
    expect(within(card).getByText('Work')).toBeTruthy();
    expect(within(card).queryByRole('button', { name: 'Sign in' })).toBeNull();
    expect(within(card).getAllByRole('button', { name: 'Add account' })).toHaveLength(1);
    expect(within(card).queryByRole('button', { name: 'Grant Gmail access' })).toBeNull();
    expect(within(card).queryByRole('button', { name: 'Grant Google Drive access' })).toBeNull();
    expect(within(card).queryByRole('button', { name: 'Grant Google Calendar access' })).toBeNull();
    expect(within(card).getByRole('list', { name: 'Google Workspace services' }).children)
      .toHaveLength(3);
    expect(within(card).getByText('Ready')).toBeTruthy();
  });

  it('surfaces the error code and shows no sign-in CTA when readiness fails with a structural error', async () => {
    role = 'member';
    readinessAvailable = false;
    render(<ConnectorsSettingsTabM1 />);

    // The client surfaces the server code so it can be diagnosed without a misleading sign-in CTA.
    await screen.findByText(/NOT_FOUND/u);
    expect(screen.queryByRole('tab', { name: 'Installation setup' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sign in again' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
    expect(document.body.textContent).not.toMatch(/not ready on this installation/u);
  });

  it('shows a sanitized alert when the grants fetch is rejected', async () => {
    failGrantFetch = true;
    render(<ConnectorsSettingsTabM1 />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Connector accounts could not be loaded.');
    expect(alert.textContent).not.toContain('sensitive upstream detail');
    expect(screen.queryByRole('heading', { name: 'Add a platform' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add account' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Grant .* access/u })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Connect with key' })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Installation setup' }));
    expect(await screen.findByRole('heading', { name: 'Owner installation setup' })).toBeTruthy();

    failGrantFetch = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    fireEvent.click(screen.getByRole('tab', { name: 'My accounts' }));
    expect(await screen.findByRole('heading', { name: 'Add a platform' })).toBeTruthy();
  });

  it('fails closed instead of presenting zero accounts when grant truth is malformed', async () => {
    malformedGrantPayload = true;
    render(<ConnectorsSettingsTabM1 />);

    expect((await screen.findByRole('alert')).textContent)
      .toContain('Connector accounts could not be loaded.');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Add a platform' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add account' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Connect with key' })).toBeNull();
  });

  it('saves the canonical origin through the owner setup API with revision fencing', async () => {
    readinessSchemaVersion = 2;
    render(<ConnectorsSettingsTabM1 />);

    expect(await screen.findByRole('heading', { name: 'Add a platform' })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Installation setup' }));
    fireEvent.change(await screen.findByLabelText('Canonical HTTPS origin'), {
      target: { value: 'https://oss.example' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save and continue' }));
    await waitFor(() => expect(calls.some(call =>
      call.url === '/api/connectors/v2/owner/setup/origin' && call.method === 'PUT')).toBe(true));
    const write = calls.find(call => call.url === '/api/connectors/v2/owner/setup/origin')!;
    expect(write.body).toEqual({ canonicalOrigin: 'https://oss.example', expectedOriginRevision: 0 });
    expect(write.headers).toMatchObject({ 'x-csrf-token': 'a'.repeat(64), 'If-Match': '"0"' });
  });

  it('offers activation only for certified candidates from the signed owner plane', async () => {
    ownerSetupPayload = {
      ...ownerSetupFixture('activation'),
      activationCandidates: [
        { providerId: 'github', serviceId: 'github', operation: 'credential.verify',
          authMethod: 'api_key', certification: 'certified', enabled: false,
          profileRequired: false, profileState: 'not_required', profileRevision: null,
          blockerCodes: ['CONNECTOR_ACTIVATION_REQUIRED'] },
        { providerId: 'google-workspace', serviceId: 'gmail', operation: 'oauth',
          authMethod: 'byo_app', certification: 'suspended', enabled: false,
          profileRequired: true, profileState: 'missing', profileRevision: null,
          blockerCodes: ['provider_suspended'] },
      ],
    };
    render(<ConnectorsSettingsTabM1 />);

    fireEvent.click(await screen.findByRole('tab', { name: 'Installation setup' }));
    expect(await screen.findByRole('checkbox', { name: 'github: credential.verify' })).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: 'gmail: oauth' })).toBeNull();
    expect(screen.getByText('gmail — suspended')).toBeTruthy();
  });

  it('never requests or exposes the owner setup plane to members', async () => {
    const ownerView = render(<ConnectorsSettingsTabM1 />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Installation setup' }));
    expect(await screen.findByRole('heading', { name: 'Owner installation setup' })).toBeTruthy();
    expect(calls.filter(call => call.url === '/api/connectors/v2/owner/setup')).toHaveLength(1);
    ownerView.unmount();

    role = 'member';
    resetConnectorsStore();
    calls.length = 0;
    render(<ConnectorsSettingsTabM1 />);
    await screen.findByRole('heading', { name: 'Connectors' });
    expect(screen.queryByRole('tab', { name: 'Installation setup' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Owner installation setup' })).toBeNull();
    expect(calls.some(call => call.url.startsWith('/api/connectors/v2/owner/setup'))).toBe(false);
  });

  it('fails the owner setup plane closed with a stable retry action', async () => {
    ownerSetupFailureCode = 'CONNECTOR_SETUP_UNAVAILABLE';
    render(<ConnectorsSettingsTabM1 />);

    fireEvent.click(await screen.findByRole('tab', { name: 'Installation setup' }));
    expect((await screen.findByRole('alert')).textContent).toContain('CONNECTOR_SETUP_UNAVAILABLE');
    expect(screen.queryByLabelText('Canonical HTTPS origin')).toBeNull();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('keeps personal writes closed for unknown readiness while owner setup remains explicit', async () => {
    readinessSchemaVersion = 3;
    render(<ConnectorsSettingsTabM1 />);

    await screen.findByRole('heading', { name: 'Connectors' });
    expect(screen.queryByRole('button', { name: 'Connect with key' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add account' })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Installation setup' }));
    expect(await screen.findByLabelText('Canonical HTTPS origin')).toBeTruthy();
    expect(screen.queryByLabelText('Client secret')).toBeNull();
  });

  it('renders a stable owner-plane error for an origin auth or CSRF rejection', async () => {
    ownerSetupMutationErrorCode = 'CONNECTOR_RECENT_AUTH_OR_CSRF_REQUIRED';
    render(<ConnectorsSettingsTabM1 />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Installation setup' }));
    fireEvent.change(await screen.findByLabelText('Canonical HTTPS origin'), {
      target: { value: 'https://oss.example' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save and continue' }));

    expect((await screen.findByRole('alert')).textContent)
      .toContain('CONNECTOR_RECENT_AUTH_OR_CSRF_REQUIRED');
    expect(screen.queryByLabelText('Client secret')).toBeNull();
  });

  it('does not restore legacy BYO credential fields in the owner setup plane', async () => {
    ownerSetupPayload = ownerSetupFixture('trust');
    render(<ConnectorsSettingsTabM1 />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Installation setup' }));
    expect(await screen.findByText('Import the installation trust bundle')).toBeTruthy();
    expect(screen.queryByLabelText('Client ID')).toBeNull();
    expect(screen.queryByLabelText('Client secret')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Configure provider' })).toBeNull();
  });

  it('uses singular English grammar when exactly one service is unavailable', async () => {
    const notion = catalog.find(entry => entry.service === 'notion')!;
    if (!notion.authMetadata) throw new Error('notion_auth_metadata_missing');
    const original = notion.authMetadata;
    notion.authMetadata = {
      ...original, canStartOAuth: true,
      submitSemantics: {
        operation: 'start_oauth', credentialPayload: 'none',
        activation: 'after_callback_verification', requiresExplicitUnverifiedConsent: false,
        unverifiedConsentPayload: 'none',
      },
    };
    profiles[1] = { ...profiles[1], readiness: 'ready', configured: true, status: 'ready' };
    try {
      render(<ConnectorsSettingsTabM1 />);
      expect(await screen.findByText('1 service is not ready on this installation')).toBeTruthy();
      expect(screen.queryByText(/1 services are/u)).toBeNull();
    } finally {
      notion.authMetadata = original;
    }
  });

  it('keeps provider secrets and server restart instructions out of owner setup', async () => {
    ownerSetupPayload = ownerSetupFixture('trust');
    render(<ConnectorsSettingsTabM1 />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Installation setup' }));

    expect(await screen.findByText('Import the installation trust bundle')).toBeTruthy();
    expect(screen.queryByText('Canva', { selector: 'h3, h4' })).toBeNull();
    expect(screen.queryByText('Google Workspace', { selector: 'h3, h4' })).toBeNull();
    expect(screen.queryByLabelText('Client secret')).toBeNull();
    expect(document.body.textContent).not.toMatch(/\.env|restart/i);
  });

  it('stores a personal API key through the grant API with CSRF and no secret echo', async () => {
    render(<ConnectorsSettingsTabM1 />);
    const github = await screen.findByRole('heading', { name: 'GitHub' });
    const card = github.closest('article')!;
    fireEvent.click(within(card).getByRole('button', { name: 'Connect with key' }));
    fireEvent.change(within(card).getByLabelText('Account name'), { target: { value: 'Personal' } });
    fireEvent.change(within(card).getByLabelText('Personal token'), { target: { value: 'secret-value' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(calls.some(call => call.url === '/api/connectors/grants/github/api-key' && call.method === 'PUT')).toBe(true));
    const write = calls.find(call => call.url === '/api/connectors/grants/github/api-key' && call.method === 'PUT')!;
    expect(write.body).toEqual({
      connectorId: 'github-personal-u7', ownership: 'personal',
      apiKey: 'secret-value', accountLabel: 'Personal',
    });
    expect(write.headers).toMatchObject({ 'x-csrf-token': 'a'.repeat(64) });
    await waitFor(() => expect(calls.some(call =>
      call.url === '/api/connectors/github-personal-u7/reconcile' && call.method === 'POST')).toBe(true));
    await waitFor(() => expect(screen.queryByDisplayValue('secret-value')).toBeNull());
  });

  it('preserves secret bytes exactly and clears the draft on cancel', async () => {
    render(<ConnectorsSettingsTabM1 />);
    const github = (await screen.findByRole('heading', { name: 'GitHub' })).closest('article')!;
    fireEvent.click(within(github).getByRole('button', { name: 'Connect with key' }));
    fireEvent.change(within(github).getByLabelText('Account name'), { target: { value: 'Whitespace' } });
    fireEvent.change(within(github).getByLabelText('Personal token'), { target: { value: '  exact secret  ' } });
    fireEvent.click(within(github).getByRole('button', { name: 'Cancel' }));
    expect(within(github).queryByDisplayValue('  exact secret  ')).toBeNull();
    fireEvent.click(within(github).getByRole('button', { name: 'Connect with key' }));
    expect((within(github).getByLabelText('Personal token') as HTMLInputElement).value).toBe('');
    fireEvent.change(within(github).getByLabelText('Account name'), { target: { value: 'Whitespace' } });
    fireEvent.change(within(github).getByLabelText('Personal token'), { target: { value: '  exact secret  ' } });
    fireEvent.click(within(github).getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(calls.some(call => call.url.endsWith('/github/api-key'))).toBe(true));
    expect(calls.find(call => call.url.endsWith('/github/api-key'))?.body?.apiKey).toBe('  exact secret  ');
  });

  it.each([
    ['malformed', { grantId: 'bad', serviceId: 'github', accountLabel: 'Bad', status: 'active' }],
    ['contradictory', grantContract({ eligible: false, availabilityState: 'available_next_session' })],
    ['ineligible placement', grantContract({ eligible: false, availabilityState: 'needs_reconciliation' })],
  ])('fails closed before reconcile for a %s grant response', async (_label, responseGrant) => {
    nextApiGrantOverride = responseGrant;
    render(<ConnectorsSettingsTabM1 />);
    const github = (await screen.findByRole('heading', { name: 'GitHub' })).closest('article')!;
    fireEvent.click(within(github).getByRole('button', { name: 'Connect with key' }));
    fireEvent.change(within(github).getByLabelText('Account name'), { target: { value: 'Bad' } });
    fireEvent.change(within(github).getByLabelText('Personal token'), { target: { value: 'secret' } });
    fireEvent.click(within(github).getByRole('button', { name: 'Connect' }));
    await screen.findByRole('alert');
    expect(calls.some(call => call.url.endsWith('/reconcile'))).toBe(false);
    expect(screen.queryByDisplayValue('secret')).toBeNull();
  });

  it('does not show an API-key account as linked when placement is not verified', async () => {
    reconcileVerified = false;
    render(<ConnectorsSettingsTabM1 />);
    const github = await screen.findByRole('heading', { name: 'GitHub' });
    const card = github.closest('article')!;
    fireEvent.click(within(card).getByRole('button', { name: 'Connect with key' }));
    fireEvent.change(within(card).getByLabelText('Account name'), { target: { value: 'Work' } });
    fireEvent.change(within(card).getByLabelText('Personal token'), { target: { value: 'secret' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Connect' }));
    await screen.findByRole('alert');
    expect(screen.queryByRole('heading', { name: 'Linked accounts' })).toBeNull();
  });

  it('uses only the explicit grant eligibility contract for connected state', async () => {
    grants = [grantContract({
      grantId: 'g1', serviceId: 'github', accountLabel: 'Work', status: 'active',
      verificationState: 'verified', operationalState: 'eligible', eligible: true,
      availabilityState: 'needs_reconciliation', pendingBodies: ['codex'],
    })];
    render(<ConnectorsSettingsTabM1 />);
    expect(await screen.findByText('Verified · preparing model bodies')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Linked accounts' })).toBeNull();
    expect(screen.getByText(/Pending models:/).textContent).toContain('codex');
  });

  it('renders every final availability state without promoting it to connected', async () => {
    grants = [
      ['stored', 'stored_unverified', 'stored_only', 'not_verified'],
      ['expired', 'stale', 'verification_expired', 'verification_expired'],
      ['rejected', 'rejected', 'credential_rejected', 'credential_rejected'],
      ['corrupt', 'corrupt', 'credential_corrupt', 'credential_corrupt'],
      ['unavailable', 'unavailable', 'temporarily_unavailable', 'verification_unavailable'],
      ['policy', 'verified', 'not_available', 'policy_disabled'],
      ['inactive', 'verified', 'not_available', 'grant_inactive'],
      ['missing', null, 'not_available', 'no_credential'],
    ].map(([label, verificationState, availabilityState, reasonCode], index) => grantContract({
      grantId: `negative-${index}`, serviceId: 'github', accountLabel: label,
      status: label === 'inactive' ? 'error' : 'active', verificationState,
      operationalState: 'ineligible', eligible: false, availabilityState, reasonCode,
      canRetryVerification: label === 'stored', canReconnect: label !== 'policy',
      availableBodies: [], pendingBodies: [],
    }));
    render(<ConnectorsSettingsTabM1 />);
    await screen.findByText('Saved encrypted · not enabled');
    expect(screen.getByText('Verification expired · not enabled')).toBeTruthy();
    expect(screen.getByText('Credential rejected · not enabled')).toBeTruthy();
    expect(screen.getByText('Stored credential is unreadable · remove it')).toBeTruthy();
    expect(screen.getByText('Verification temporarily unavailable · not enabled')).toBeTruthy();
    expect(screen.getByText('Disabled by this installation’s connector policy')).toBeTruthy();
    expect(screen.getByText('Account is inactive')).toBeTruthy();
    expect(screen.getByText('Credential is missing · reconnect required')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Linked accounts' })).toBeNull();
  });

  it('uses central eligible and exact body/service lists from a coherent DTO', async () => {
    grants = [grantContract({
      grantId: 'google-bundle', serviceId: 'gmail', accountLabel: 'Workspace', status: 'active',
      verificationState: 'verified', operationalState: 'eligible', eligible: true,
      availabilityState: 'available_next_session',
      grantedServices: ['google-calendar', 'google-drive'],
      availableBodies: ['claude', 'codex'], pendingBodies: [],
    })];
    render(<ConnectorsSettingsTabM1 />);
    expect(await screen.findByRole('heading', { name: 'Linked accounts' })).toBeTruthy();
    const google = screen.getByRole('heading', { name: 'Google Workspace' }).closest('article')!;
    expect(within(google).getAllByText('Workspace')).toHaveLength(1);
    expect(within(google).getByText('Google Calendar · Google Drive')).toBeTruthy();
    expect(within(google).getAllByText(/Available models:/)).toHaveLength(1);
    expect(within(google).getAllByText(/claude, codex/)).toHaveLength(1);
    expect(within(google).queryByRole('button', { name: 'Sign in' })).toBeNull();
    expect(within(google).getAllByRole('button', { name: 'Add account' })).toHaveLength(1);
    expect(within(google).getByRole('button', { name: 'Add account' })).toBeTruthy();
    expect(within(google).queryByRole('button', { name: 'Grant Google Drive access' })).toBeNull();
    expect(within(google).queryByRole('button', { name: 'Grant Google Calendar access' })).toBeNull();
  });

  it('shows every stored account, keeps Add account, and reverifies only when allowed', async () => {
    grants = [grantContract({
      grantId: 's1', serviceId: 'salla', accountLabel: 'Store one', status: 'pending',
      verificationState: 'stored_unverified', operationalState: 'ineligible', eligible: false,
      availabilityState: 'stored_only', canRetryVerification: true, availableBodies: [],
    }), grantContract({
      grantId: 's2', serviceId: 'salla', accountLabel: 'Store two', status: 'error',
      verificationState: 'rejected', operationalState: 'ineligible', eligible: false,
      availabilityState: 'credential_rejected', canRetryVerification: false, availableBodies: [],
    })];
    render(<ConnectorsSettingsTabM1 />);
    const salla = (await screen.findByRole('heading', { name: 'Salla' })).closest('article')!;
    expect(within(salla).getByText('Store one')).toBeTruthy();
    expect(within(salla).getByText('Store two')).toBeTruthy();
    const warning = within(salla).getByText('Saved encrypted · not enabled').closest('span')!;
    expect(warning.className).toContain('bg-warning');
    expect(warning.querySelector('svg')).toBeTruthy();
    expect(within(salla).getByRole('button', { name: 'Connect with key' })).toBeTruthy();
    fireEvent.click(within(salla).getByRole('button', { name: /Verify again: Store one — Salla/u }));
    await waitFor(() => expect(calls.some(call =>
      call.url === '/api/connectors/grants/s1/reverify' && call.method === 'POST')).toBe(true));
  });

  it('keeps an account visible and removable when its provider setup is unavailable', async () => {
    grants = [grantContract({
      grantId: 'canva-old', serviceId: 'canva', accountLabel: 'Design team', status: 'error',
      verificationState: 'unavailable', operationalState: 'ineligible', eligible: false,
      availabilityState: 'temporarily_unavailable', reasonCode: 'verification_unavailable',
      canRetryVerification: false, canReconnect: false, canRemove: true,
      availableBodies: [], pendingBodies: [],
    })];
    render(<ConnectorsSettingsTabM1 />);
    const canva = (await screen.findByRole('heading', { name: 'Canva' })).closest('article')!;
    expect(within(canva).getByText('Design team')).toBeTruthy();
    expect(within(canva).getByText('Verification temporarily unavailable · not enabled')).toBeTruthy();
    expect(within(canva).getByRole('button', { name: /Remove account: Design team — Canva/u })).toBeTruthy();
    expect(screen.queryByText(/^Canva — Not supported$/u)).toBeNull();
  });

  it('requires explicit inert-storage consent and saves Geidea fields atomically', async () => {
    render(<ConnectorsSettingsTabM1 />);
    const geidea = (await screen.findByRole('heading', { name: 'Geidea' })).closest('article')!;
    fireEvent.click(within(geidea).getByRole('button', { name: 'Connect with key' }));
    fireEvent.change(within(geidea).getByLabelText('Account name'), { target: { value: 'Merchant' } });
    fireEvent.change(within(geidea).getByLabelText('Merchant public key'), { target: { value: 'merchant-key' } });
    fireEvent.change(within(geidea).getByLabelText('API password'), { target: { value: 'password' } });
    const save = within(geidea).getByRole('button', { name: 'Save without enabling' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(within(geidea).getByRole('checkbox'));
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(calls.some(call => call.url === '/api/connectors/grants/geidea/api-key')).toBe(true));
    const write = calls.find(call => call.url === '/api/connectors/grants/geidea/api-key')!;
    expect(write.body).toEqual({
      connectorId: 'geidea-merchant-u7', ownership: 'personal', accountLabel: 'Merchant',
      credentialFields: { merchant_public_key: 'merchant-key', api_password: 'password' },
      acceptStoredUnverified: true,
    });
    expect(calls.some(call => call.url.endsWith('/reconcile'))).toBe(false);
    await waitFor(() => expect(screen.queryByDisplayValue('password')).toBeNull());
  });

  it('fails closed when the server credential schema is missing instead of guessing fields', async () => {
    const github = catalog.find(entry => entry.service === 'github')!;
    if (!github.authMetadata) throw new Error('github_auth_metadata_missing');
    const original = github.authMetadata;
    github.authMetadata = { ...original, credentialInputSchema: null };
    try {
      render(<ConnectorsSettingsTabM1 />);
      await screen.findByText(/services are not ready on this installation/u);
      expect(screen.queryByRole('heading', { name: 'GitHub' })).toBeNull();
    } finally {
      github.authMetadata = original;
    }
  });

  it('uses borderless spaced groups and the shared interaction-size ladder', async () => {
    render(<ConnectorsSettingsTabM1 />);
    const addHeading = await screen.findByRole('heading', { name: 'Add a platform' });
    expect(addHeading.nextElementSibling?.className).toContain('space-y-4');
    expect(addHeading.nextElementSibling?.className).not.toContain('divide-y');
    expect(screen.getByRole('tab', { name: 'My accounts' }).className).toContain('min-h-11');
    const addAccount = screen.getByRole('button', { name: 'Add account' });
    expect(addAccount.className).toContain('h-[var(--control-height-default)]');
    expect(addAccount.className).not.toContain('min-h-11');
  });

  it('fails closed but stays renderable when final truth arrays are missing', async () => {
    grants = [grantContract({
      grantId: 'mixed', serviceId: 'github', accountLabel: 'Mixed server', status: 'active',
      grantedServices: undefined, availableBodies: undefined, pendingBodies: undefined,
      eligible: true, availabilityState: 'available_next_session', canRemove: true,
    })];
    render(<ConnectorsSettingsTabM1 />);
    const github = (await screen.findByRole('heading', { name: 'GitHub' })).closest('article')!;
    expect(within(github).getByText('Mixed server')).toBeTruthy();
    expect(within(github).getByText('Not available to models')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Linked accounts' })).toBeNull();
    expect(within(github).queryByRole('button', { name: /Remove account:/u })).toBeNull();
  });

  it('renders every server-authorized action for a connected account with unique names', async () => {
    grants = [grantContract({
      grantId: 'work', serviceId: 'github', accountLabel: 'Work', status: 'active',
      canRetryVerification: true, canReconnect: true, canRemove: true,
    }), grantContract({
      grantId: 'personal', serviceId: 'github', accountLabel: 'Personal', status: 'active',
      canRetryVerification: false, canReconnect: true, canRemove: true,
    })];
    render(<ConnectorsSettingsTabM1 />);
    const github = (await screen.findByRole('heading', { name: 'GitHub' })).closest('article')!;
    expect(within(github).getByRole('button', { name: 'Verify again: Work — GitHub' })).toBeTruthy();
    expect(within(github).getByRole('button', { name: 'Reconnect: Work — GitHub' })).toBeTruthy();
    expect(within(github).getByRole('button', { name: 'Reconnect: Personal — GitHub' })).toBeTruthy();
    expect(within(github).getByRole('button', { name: 'Remove account: Work — GitHub' })).toBeTruthy();
    expect(within(github).getByRole('button', { name: 'Remove account: Personal — GitHub' })).toBeTruthy();
  });

  it('keeps member accounts usable without exposing installation or restart instructions', async () => {
    role = 'member';
    readinessSchemaVersion = 2;
    grants = [grantContract({ grantId: 'member', serviceId: 'github', accountLabel: 'Mine', status: 'active' })];
    render(<ConnectorsSettingsTabM1 />);
    expect(await screen.findByText('Mine')).toBeTruthy();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Installation setup' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Reconnect: Mine — GitHub' })).toBeTruthy();
    expect(calls.some(call => call.url === '/api/connectors/v2/installation/catalog')).toBe(false);
    expect(calls.some(call => call.url.startsWith('/api/connectors/auth-profiles'))).toBe(false);
    expect(document.body.textContent).not.toMatch(/services? (?:is|are) not ready on this installation/iu);
    expect(document.body.textContent).not.toMatch(/\.env|restart/iu);
  });

  it('clears owner setup drafts and redirects to Accounts on a live role downgrade', async () => {
    const surface = render(<ConnectorsSettingsTabM1 />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Installation setup' }));
    const origin = await screen.findByLabelText('Canonical HTTPS origin') as HTMLInputElement;
    fireEvent.change(origin, { target: { value: 'https://draft.example' } });
    expect(origin.value).toBe('https://draft.example');

    role = 'member';
    surface.rerender(<ConnectorsSettingsTabM1 />);
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByLabelText('Canonical HTTPS origin')).toBeNull();
    expect(screen.queryByText('Owner installation setup')).toBeNull();

    role = 'owner';
    surface.rerender(<ConnectorsSettingsTabM1 />);
    fireEvent.click(screen.getByRole('tab', { name: 'Installation setup' }));
    expect((await screen.findByLabelText('Canonical HTTPS origin') as HTMLInputElement).value)
      .not.toBe('https://draft.example');
  });

  it('marks installation setup as a visually distinct owner-only surface', async () => {
    render(<ConnectorsSettingsTabM1 />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Installation setup' }));
    const heading = await screen.findByRole('heading', { name: 'Owner installation setup' });
    expect(heading.parentElement?.parentElement?.parentElement?.className)
      .toContain('border-primary/30');
    expect(heading.parentElement?.parentElement?.parentElement?.className)
      .toContain('bg-primary/5');
  });

  it('uses RTL-aware tab arrow navigation', async () => {
    document.documentElement.dir = 'rtl';
    render(<ConnectorsSettingsTabM1 />);
    const accounts = await screen.findByRole('tab', { name: 'My accounts' });
    fireEvent.keyDown(accounts, { key: 'ArrowLeft' });
    expect(screen.getByRole('tab', { name: 'Installation setup' }).getAttribute('aria-selected')).toBe('true');
  });

  // ── Diagnostic panel: five structural error codes ────────────────────────

  it('shows a not-enabled panel for CONNECTOR_GRANTS_DISABLED and offers operator setup to owner', async () => {
    failGrantFetch = true;
    grantsFailureCode = 'CONNECTOR_GRANTS_DISABLED';
    render(<ConnectorsSettingsTabM1 />);

    expect(await screen.findByText('Connectors are not enabled on this installation.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sign in again' })).toBeNull();
    // Owner gets a navigation action; no raw flag names or env vars shown
    const goBtn = screen.getByRole('button', { name: 'Go to operator setup' });
    expect(goBtn).toBeTruthy();
    fireEvent.click(goBtn);
    expect(await screen.findByRole('heading', { name: 'Owner installation setup' })).toBeTruthy();
  });

  it('shows CONNECTOR_GRANTS_DISABLED as a read-only status to members', async () => {
    role = 'member';
    failGrantFetch = true;
    grantsFailureCode = 'CONNECTOR_GRANTS_DISABLED';
    render(<ConnectorsSettingsTabM1 />);

    expect(await screen.findByText(/not available.*contact your platform operator/iu)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sign in again' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Go to operator setup' })).toBeNull();
  });

  it('shows CONNECTOR_AUTH_NOT_CONFIGURED without a sign-in CTA', async () => {
    readinessAvailable = false;
    readinessFailureCode = 'CONNECTOR_AUTH_NOT_CONFIGURED';
    render(<ConnectorsSettingsTabM1 />);

    expect(await screen.findByText("Connector authentication isn't configured on the server yet.")).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sign in again' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Go to operator setup' })).toBeTruthy();
  });

  it('shows CONNECTOR_ORIGIN_REJECTED as a danger alert without a sign-in CTA', async () => {
    readinessAvailable = false;
    readinessFailureCode = 'CONNECTOR_ORIGIN_REJECTED';
    render(<ConnectorsSettingsTabM1 />);

    expect(await screen.findByText(/canonical origin/iu)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sign in again' })).toBeNull();
  });

  it('shows the session-expired message for AUTH_REQUIRED and preserves the re-login CTA', async () => {
    readinessAvailable = false;
    readinessFailureCode = 'AUTH_REQUIRED';
    render(<ConnectorsSettingsTabM1 />);

    expect(await screen.findByText(/session has ended/iu)).toBeTruthy();
    const btn = screen.getByRole('button', { name: 'Sign in again' });
    expect(btn).toBeTruthy();
    fireEvent.click(btn);
    expect(logout).toHaveBeenCalledOnce();
  });

  it('shows a neutral notice with the code for unrecognised structural errors', async () => {
    readinessAvailable = false;
    readinessFailureCode = 'CONNECTOR_MAINTENANCE_MODE';
    render(<ConnectorsSettingsTabM1 />);

    expect(await screen.findByText(/CONNECTOR_MAINTENANCE_MODE/u)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sign in again' })).toBeNull();
  });
});

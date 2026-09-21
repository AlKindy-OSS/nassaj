/* eslint-disable import-x/order -- mocks must be declared before the modules that consume them */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import arSettings from '../../../../i18n/locales/ar/settings.json';
import enSettings from '../../../../i18n/locales/en/settings.json';
function lookup(key: string): string | undefined {
  const value = key.split('.').reduce<unknown>(
    (node, part) => node && typeof node === 'object'
      ? (node as Record<string, unknown>)[part]
      : undefined,
    enSettings,
  );
  return typeof value === 'string' ? value : undefined;
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const template = lookup(key) ?? (opts?.defaultValue as string) ?? key;
      return template.replace(/\{\{(\w+)\}\}/g, (whole, name: string) =>
        opts?.[name] === undefined ? whole : String(opts[name]),
      );
    },
    i18n: { language: 'en' },
  }),
}));

const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
let oauthAvailability: 'ready' | 'server_not_configured' = 'ready';
let connectors: Array<Record<string, unknown>> = [];
let role: 'owner' | 'admin' | 'member' = 'owner';
let catalogServices = ['gmail'];

vi.mock('../../../auth/context/AuthContext', () => ({
  useOptionalAuth: () => ({ user: { id: 7, username: role, role } }),
}));

vi.mock('../../../../utils/api', () => ({
  authenticatedFetch: vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push({ url, body: JSON.parse(String(init.body ?? '{}')) as Record<string, unknown> });
      return { ok: true, status: 200, json: async () => ({ authorizeUrl: '#oauth-consent' }) } as Response;
    }
    const payload = url.endsWith('/catalog')
      ? {
          schemaVersion: 2,
          catalog: catalogServices.map((service) => ({
            service,
            displayName: service === 'gmail' ? 'Gmail' : service === 'google-drive' ? 'Google Drive' : 'Google Calendar',
            summary: 'Google service', allowsSharing: false,
            official: true, authMode: 'oauth', oauthAvailability,
          })),
        }
      : url.endsWith('/targets') ? { targets: [] } : { connectors };
    return { ok: true, status: 200, json: async () => payload } as Response;
  }),
}));

import { resetConnectorsStore } from '../../../../stores/connectorsStore';

import ConnectorsSettingsTab from './ConnectorsSettingsTab';

beforeEach(() => {
  posts.length = 0;
  connectors = [];
  oauthAvailability = 'ready';
  role = 'owner';
  catalogServices = ['gmail'];
  resetConnectorsStore();
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(cleanup);

describe('simple OAuth connector flow', () => {
  it('uses Arabic count copy that stays grammatical for one provider group', () => {
    const ownerTitle = arSettings.connectorsSettings.setupNeededOwnerTitle.replace('{{count}}', '1');
    const memberTitle = arSettings.connectorsSettings.setupNeededMemberTitle.replace('{{count}}', '1');
    expect(ownerTitle).not.toContain('1 مجموعات');
    expect(memberTitle).not.toContain('1 مجموعات');
    expect(ownerTitle).toContain('1');
    expect(memberTitle).toContain('1');
  });

  it('starts the first ready account directly and suppresses a double tap', async () => {
    render(<ConnectorsSettingsTab />);
    const tile = await screen.findByRole('button', { name: 'Gmail' });
    fireEvent.click(tile);
    fireEvent.click(tile);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({
      url: '/api/connectors/oauth/start',
      body: { service: 'gmail', accountLabel: '' },
    });
    expect(screen.queryByLabelText('Account name')).toBeNull();
    expect(document.body.textContent).not.toMatch(/NASSAJ_OAUTH|callback|developer portal|Restart nassaj/i);
  });

  it('groups unavailable OAuth outside the tiles and performs zero writes', async () => {
    oauthAvailability = 'server_not_configured';
    render(<ConnectorsSettingsTab />);
    expect(await screen.findByText(/1 sign-in provider groups need setup/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Gmail' })).toBeNull();
    expect(screen.queryByText(/temporarily unavailable/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(screen.getByText('Needs setup')).toBeTruthy();
    expect(screen.getByText('Gmail')).toBeTruthy();
    expect(posts).toHaveLength(0);
    expect(screen.queryByLabelText('Account name')).toBeNull();
  });

  it('shows members a neutral non-interactive disclosure for unavailable providers', async () => {
    oauthAvailability = 'server_not_configured';
    role = 'member';
    render(<ConnectorsSettingsTab />);
    expect(await screen.findByText(/1 sign-in provider groups are not available yet/i)).toBeTruthy();
    expect(screen.getByText('Needs setup')).toBeTruthy();
    expect(screen.getByText('Gmail')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Review' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Gmail' })).toBeNull();
    expect(posts).toHaveLength(0);
  });

  it('keeps admins on the neutral member path without an owner action', async () => {
    oauthAvailability = 'server_not_configured';
    role = 'admin';
    render(<ConnectorsSettingsTab />);
    expect(await screen.findByText(/1 sign-in provider groups are not available yet/i)).toBeTruthy();
    expect(screen.getByText('Needs setup')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Review' })).toBeNull();
  });

  it('counts Google Calendar, Drive, and Gmail as one provider group', async () => {
    oauthAvailability = 'server_not_configured';
    catalogServices = ['gmail', 'google-drive', 'google-calendar'];
    render(<ConnectorsSettingsTab />);
    expect(await screen.findByText(/1 sign-in provider groups need setup/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(screen.getByText('Google')).toBeTruthy();
    expect(screen.getByText('Gmail')).toBeTruthy();
    expect(screen.getByText('Google Drive')).toBeTruthy();
    expect(screen.getByText('Google Calendar')).toBeTruthy();
    expect(posts).toHaveLength(0);
  });

  it('asks only for a distinct name when adding an OAuth account', async () => {
    connectors = [{
      id: 'gmail-main', service: 'gmail', displayName: 'Gmail', accountLabel: 'Main',
      enabled: true, configured: true, degraded: false, availableNextSession: true,
      availability: 'available_next_session', placementStatus: 'healthy', targets: [],
      credentialMode: 'per_member', ownerUserId: 7, allowsSharing: false,
      authMode: 'oauth', credentialSource: 'oauth_grant',
    }];
    render(<ConnectorsSettingsTab />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add account' }));
    expect(screen.queryByRole('radio')).toBeNull();
    const name = screen.getByLabelText('Account name');
    expect(name.hasAttribute('required')).toBe(true);
    fireEvent.change(name, { target: { value: 'Work' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({
      url: '/api/connectors/oauth/start',
      body: { service: 'gmail', accountLabel: 'Work' },
    });
  });

  it('retries an existing unfinished row without creating another row', async () => {
    connectors = [{
      id: 'gmail-pending', service: 'gmail', displayName: 'Gmail', accountLabel: 'Work',
      enabled: true, configured: false, degraded: false, availableNextSession: false,
      availability: 'not_configured', placementStatus: 'not_configured', targets: [],
      credentialMode: 'per_member', ownerUserId: 7, allowsSharing: false,
      authMode: 'oauth', credentialSource: null,
    }];
    render(<ConnectorsSettingsTab />);
    fireEvent.click(await screen.findByRole('button', { name: 'Link account' }));
    expect(screen.queryByLabelText('Account name')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Link account' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].url).toBe('/api/connectors/gmail-pending/oauth/start');
    expect(posts.some((post) => post.url === '/api/connectors')).toBe(false);
  });
});

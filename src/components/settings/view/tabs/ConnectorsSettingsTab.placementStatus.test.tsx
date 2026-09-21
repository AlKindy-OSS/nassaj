import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import enSettings from '../../../../i18n/locales/en/settings.json';
import { resetConnectorsStore } from '../../../../stores/connectorsStore';

import ConnectorsSettingsTab from './ConnectorsSettingsTab';

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

const connector = {
  id: 'drive-u7',
  service: 'google-drive',
  displayName: 'Google Drive',
  accountLabel: 'Work',
  enabled: true,
  configured: true,
  degraded: true,
  availableNextSession: false,
  availability: 'degraded',
  placementStatus: 'partial',
  retryAvailable: true,
  targets: [
    {
      provider: 'claude',
      state: 'healthy',
      healthy: true,
      desiredGeneration: 2,
      appliedGeneration: 2,
      attemptCount: 1,
      nextRetryAt: null,
      lastErrorCode: null,
    },
    {
      provider: 'codex',
      state: 'blocked',
      healthy: false,
      desiredGeneration: 2,
      appliedGeneration: 1,
      attemptCount: 2,
      nextRetryAt: null,
      lastErrorCode: 'connector_collision',
    },
  ],
  credentialMode: 'per_member',
  ownerUserId: 7,
  allowsSharing: false,
  authMode: 'oauth',
  credentialSource: 'oauth_grant',
};

let connectorGets = 0;
let reconcileCalls = 0;
let resolveReconcile: ((value: Response) => void) | null = null;

vi.mock('../../../../utils/api', () => ({
  authenticatedFetch: vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/connectors/drive-u7/reconcile' && init?.method === 'POST') {
      reconcileCalls += 1;
      return new Promise<Response>((resolve) => {
        resolveReconcile = resolve;
      });
    }
    if (url.endsWith('/catalog')) {
      return { ok: true, status: 200, json: async () => ({ catalog: [] }) } as Response;
    }
    if (url.endsWith('/targets')) {
      return { ok: true, status: 200, json: async () => ({ targets: [] }) } as Response;
    }
    connectorGets += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ connectors: [connector] }),
    } as Response;
  }),
}));

beforeEach(() => {
  connectorGets = 0;
  reconcileCalls = 0;
  resolveReconcile = null;
  connector.retryAvailable = true;
  connector.availableNextSession = false;
  connector.placementStatus = 'partial';
  resetConnectorsStore();
});

afterEach(() => cleanup());

describe('connector account and tool-placement truth', () => {
  it('separates linked credentials from each engine and retries only on server permission', async () => {
    render(<ConnectorsSettingsTab />);

    expect(await screen.findByText('Account linked')).toBeTruthy();
    expect(screen.getByText('Tools ready on some engines')).toBeTruthy();
    expect(screen.getByText('Claude')).toBeTruthy();
    expect(screen.getByText('Ready')).toBeTruthy();
    expect(screen.getByText('Codex')).toBeTruthy();
    expect(screen.getByText('Blocked')).toBeTruthy();
    expect(screen.queryByText('Available next session')).toBeNull();

    const retry = screen.getByRole('button', { name: 'Retry tool setup' });
    fireEvent.click(retry);
    expect(reconcileCalls).toBe(1);
    expect(retry.getAttribute('aria-busy')).toBe('true');

    resolveReconcile?.({
      ok: true,
      status: 207,
      json: async () => ({ connector }),
    } as Response);

    await waitFor(() => expect(connectorGets).toBeGreaterThan(1));
    await waitFor(() => expect(retry.getAttribute('aria-busy')).toBe('false'));
  });

  it('does not offer retry when the server omits or denies retryAvailable', async () => {
    connector.retryAvailable = false;
    render(<ConnectorsSettingsTab />);
    expect(await screen.findByText('Account linked')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry tool setup' })).toBeNull();
  });

  it('collapses healthy placement to one truthful line and hides engine detail', async () => {
    connector.availableNextSession = true;
    connector.placementStatus = 'healthy';
    connector.retryAvailable = false;
    render(<ConnectorsSettingsTab />);
    expect(await screen.findByText('Tools ready for the next session')).toBeTruthy();
    expect(screen.getByText(/configuration is written for new sessions/i)).toBeTruthy();
    expect(screen.queryByText('Claude')).toBeNull();
    expect(screen.queryByText('Codex')).toBeNull();
  });

  it('shows a normalized reconcile error and restores the action', async () => {
    render(<ConnectorsSettingsTab />);
    const retry = await screen.findByRole('button', { name: 'Retry tool setup' });
    fireEvent.click(retry);
    resolveReconcile?.({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Connector reconciliation failed.' }),
    } as Response);

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Connector reconciliation failed.',
    );
    await waitFor(() => expect(retry.getAttribute('aria-busy')).toBe('false'));
  });
});

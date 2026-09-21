import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const portableCatalog = [{
  service: 'notion',
  displayName: 'Notion',
  summary: '',
  allowsSharing: false,
  official: true,
  authMode: 'oauth' as const,
  authMetadata: {
    profileId: 'notion',
    method: 'dcr_pkce' as const,
    readiness: 'temporarily_unavailable' as const,
  },
}];
let catalog: Array<Record<string, unknown>> = portableCatalog;

vi.mock('../../../../stores/connectorsStore', () => ({
  connectorAdditionalFieldsPayload: () => ({}),
  loadConnectors: vi.fn(async () => undefined),
  useConnectorsSnapshot: () => ({
    catalog,
    connectors: [],
    targets: [],
    catalogSchemaVersion: 2,
    ready: true,
    loading: false,
    error: null,
  }),
}));

vi.mock('./ConnectorsSettingsTabM1', () => ({
  default: () => <div>portable-owner-setup-surface</div>,
}));

import ConnectorsSettingsTab from './ConnectorsSettingsTab';

afterEach(() => {
  catalog = portableCatalog;
  cleanup();
});

describe('portable connector surface selection', () => {
  it('keeps installation setup reachable when every advertised operation is unavailable', () => {
    render(<ConnectorsSettingsTab />);

    expect(screen.getByText('portable-owner-setup-surface')).toBeTruthy();
  });

  it('keeps the legacy fallback when the server advertises no portable auth contract', () => {
    catalog = [{
      service: 'wafeq',
      displayName: 'Wafeq',
      summary: '',
      allowsSharing: false,
      official: true,
      authMode: 'key',
    }];

    render(<ConnectorsSettingsTab />);

    expect(screen.queryByText('portable-owner-setup-surface')).toBeNull();
  });
});

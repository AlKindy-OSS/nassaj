/**
 * ClaudeConnectionSection.owner.test.tsx — the owner view carries no token-paste card.
 *
 * Linking runs `claude auth login` in the in-app terminal modal, where the code
 * is pasted directly and the CLI stores the credential itself (B-1260). The old
 * setup-token paste card (B-1075) is removed; this file guards that it stays
 * gone for an owner, and that the owner still gets no invite banner.
 *
 * Sibling `ClaudeConnectionSection.test.tsx` covers a non-owner member; they are
 * two files because `useAuth` is mocked at module level (role fixed per file).
 *
 * RUNNER: vitest (jsdom). NODE_ENV=test required.
 */
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import enSettings from '../../../../../../../i18n/locales/en/settings.json';

function lookup(key: string): string | undefined {
  const value = key.split('.').reduce<unknown>(
    (node, part) =>
      node && typeof node === 'object'
        ? (node as Record<string, unknown>)[part]
        : undefined,
    enSettings,
  );
  return typeof value === 'string' ? value : undefined;
}

function interpolate(template: string, opts?: Record<string, unknown>): string {
  if (!opts) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (whole, name: string) =>
    opts[name] === undefined ? whole : String(opts[name]),
  );
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      interpolate(lookup(key) ?? (opts?.defaultValue as string) ?? key, opts),
    i18n: { language: 'en' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

// ‏**هنا الفرق الوحيد عن الملف التوأم**: الدور `owner`.
vi.mock('../../../../../../auth', () => ({
  useAuth: () => ({ user: { id: 1, username: 'owner', role: 'owner' } }),
}));

vi.mock('../../../../../../quick-settings-panel/hooks/useProviderCycles', () => ({
  useProviderCycles: () => ({ status: 'idle', rows: [] }),
}));
vi.mock('../../../../../../quick-settings-panel/providerCycleHelpers', () => ({
  findCycleRow: () => null,
  resolveCycleDisplay: () => null,
}));

vi.mock('../../../../../../provider-auth/view/ProviderLoginModal', () => ({
  default: () => null,
}));

vi.mock('./linkExpiryHelpers', () => ({
  resolveLinkExpiryDisplay: () => null,
  formatExpiryMoment: () => '',
}));

vi.mock('./authPaths', () => ({ hasDualAuthPaths: () => false }));
vi.mock('./billingLinks', () => ({ BILLING_LINKS: {} }));
vi.mock('../../../../../../llm-logo-provider/SessionProviderLogo', () => ({
  default: () => null,
}));

const mockFetch = vi.fn();
vi.mock('../../../../../../../utils/api', () => ({
  authenticatedFetch: (...args: unknown[]) => mockFetch(...args),
}));

const mockRefresh = vi.fn();
const mockConnection = vi.fn(() => ({
  connected: false,
  loading: false,
  error: null,
  refresh: mockRefresh,
}));
vi.mock('../../../../../hooks/useClaudeConnection', () => ({
  useClaudeConnection: () => mockConnection(),
}));

import ClaudeConnectionSection from './ClaudeConnectionSection';

const AUTH_STATUS = {
  installed: true,
  authenticated: false,
  loading: false,
  email: null,
  method: null,
  error: null,
  linkExpiry: null,
};

const TOKEN_PLACEHOLDER = 'sk-ant-oat01';

function mount() {
  return render(
    <ClaudeConnectionSection
      authStatus={AUTH_STATUS as Parameters<typeof ClaudeConnectionSection>[0]['authStatus']}
      onLogin={() => {}}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mockConnection.mockReturnValue({
    connected: false,
    loading: false,
    error: null,
    refresh: mockRefresh,
  });
});

beforeEach(() => {
  mockFetch.mockImplementation(async () => ({
    ok: true,
    json: async () => ({ connected: false, provider: 'claude' }),
  }));
});

describe('ClaudeConnectionSection — owner, not connected', () => {
  it('does NOT render the setup-token paste card', async () => {
    mount();

    await waitFor(() => expect(mockConnection).toHaveBeenCalled());
    expect(screen.queryByPlaceholderText(new RegExp(TOKEN_PLACEHOLDER))).toBeNull();
    expect(screen.queryByRole('button', { name: /save token/i })).toBeNull();
    expect(screen.queryByText(/setup-token/i)).toBeNull();
  });

  it('does NOT render the invite banner for an owner', async () => {
    mount();

    await waitFor(() => expect(mockConnection).toHaveBeenCalled());
    expect(
      screen.queryByRole('button', { name: lookup('claudeConnection.linkButton') ?? 'Link Claude account' }),
    ).toBeNull();
  });
});

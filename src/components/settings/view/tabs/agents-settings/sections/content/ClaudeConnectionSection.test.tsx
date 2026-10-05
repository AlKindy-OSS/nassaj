/**
 * ClaudeConnectionSection.test.tsx — member view, not connected.
 *
 * The member sees the invite banner whose button opens the login modal
 * (`claude auth login`). The old setup-token paste card (B-1075) is gone: no
 * sk-ant-oat01 input and no save-token button.
 *
 * RUNNER: vitest (jsdom). NODE_ENV=test required.
 */
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import enSettings from '../../../../../../../i18n/locales/en/settings.json';

// ─── مساعدات الترجمة ──────────────────────────────────────────────────────────
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

// ─── Mocks ────────────────────────────────────────────────────────────────────
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      interpolate(lookup(key) ?? (opts?.defaultValue as string) ?? key, opts),
    i18n: { language: 'en' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

vi.mock('../../../../../../auth', () => ({
  useAuth: () => ({ user: { id: 2, username: 'member', role: 'member' } }),
}));

// دورات الفاتورة: لا بيانات في هذا الاختبار
vi.mock('../../../../../../quick-settings-panel/hooks/useProviderCycles', () => ({
  useProviderCycles: () => ({ status: 'idle', rows: [] }),
}));
vi.mock('../../../../../../quick-settings-panel/providerCycleHelpers', () => ({
  findCycleRow: () => null,
  resolveCycleDisplay: () => null,
}));

// المودال: لا نختبره هنا
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

// ─── مزوّد الجلسة الحقيقي: authenticatedFetch ───────────────────────────────
const mockFetch = vi.fn();
vi.mock('../../../../../../../utils/api', () => ({
  authenticatedFetch: (...args: unknown[]) => mockFetch(...args),
}));

// ─── يمكن التحكّم في حالة الاتصال من خارج ────────────────────────────────────
const mockRefresh = vi.fn();
vi.mock('../../../../../hooks/useClaudeConnection', () => ({
  useClaudeConnection: vi.fn(() => ({
    connected: false,
    loading: false,
    error: null,
    refresh: mockRefresh,
  })),
}));

// ─── استيراد المكوّن بعد ضبط الـ mocks ──────────────────────────────────────
import ClaudeConnectionSection from './ClaudeConnectionSection';

// ─── ثوابت مساعدة ────────────────────────────────────────────────────────────
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

// ─── الاختبارات ──────────────────────────────────────────────────────────────
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  mockFetch.mockImplementation(async () => ({
    ok: true,
    json: async () => ({ connected: false, provider: 'claude' }),
  }));
});

describe('ClaudeConnectionSection — member, not connected', () => {
  it('shows the link button and NO setup-token paste card', async () => {
    render(
      <ClaudeConnectionSection
        authStatus={AUTH_STATUS as Parameters<typeof ClaudeConnectionSection>[0]['authStatus']}
        onLogin={() => {}}
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByRole('button', {
          name: lookup('claudeConnection.linkButton') ?? 'Link Claude account',
        }),
      ).toBeTruthy();
    });
    expect(screen.queryByPlaceholderText(new RegExp(TOKEN_PLACEHOLDER))).toBeNull();
    expect(screen.queryByRole('button', { name: /save token/i })).toBeNull();
    expect(screen.queryByText(/setup-token/i)).toBeNull();
  });
});

describe('ClaudeConnectionSection — re-check', () => {
  it('re-reads BOTH the link and the provider status, so a stale "connected" cannot stay', () => {
    const onRefreshAuthStatus = vi.fn();
    render(
      <ClaudeConnectionSection
        authStatus={AUTH_STATUS as Parameters<typeof ClaudeConnectionSection>[0]['authStatus']}
        onLogin={() => {}}
        onRefreshAuthStatus={onRefreshAuthStatus}
      />,
    );
    fireEvent.click(
      screen.getByRole('button', { name: lookup('claudeConnection.recheck') ?? 'Re-check' }),
    );
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(onRefreshAuthStatus).toHaveBeenCalledTimes(1);
  });
});

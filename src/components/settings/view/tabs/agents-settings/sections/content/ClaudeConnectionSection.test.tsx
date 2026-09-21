/**
 * ClaudeConnectionSection.test.tsx — B-1075: مسار لصق الرمز
 *
 * عندما يكون المستخدم غير موصول وليس مالكاً:
 *   1. تظهر اللافتة مع حقل إدخال الرمز
 *   2. بعد إدخال الرمز والضغط على «حفظ»:
 *      - يُستدعى POST /api/providers/claude/api-key بـ { apiKey }
 *      - يُعاد فحص حالة الاتصال (GET /api/user/claude-connection)
 *   3. خطأ التحقق: حقل فارغ يعرض رسالة خطأ ولا يُرسل طلباً
 *
 * RUNNER: vitest (jsdom). NODE_ENV=test إلزامي.
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

const VALID_TOKEN = 'sk-ant-oat01-test-token-value';

// ─── الاختبارات ──────────────────────────────────────────────────────────────
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  // GET /api/providers/claude/api-key → not configured
  // GET /api/user/claude-connection → not connected
  mockFetch.mockImplementation(async (url: string) => {
    if (typeof url === 'string' && url.includes('/api/user/claude-connection')) {
      return {
        ok: true,
        json: async () => ({ connected: false, provider: 'claude' }),
      };
    }
    if (typeof url === 'string' && url.includes('/api/providers/claude/api-key')) {
      return {
        ok: true,
        json: async () => ({ success: true, data: { configured: false, writable: true } }),
      };
    }
    return { ok: true, json: async () => ({}) };
  });
});

describe('ClaudeConnectionSection — token paste (B-1075)', () => {
  it('shows the token input when the user is not connected and not the owner', async () => {
    render(
      <ClaudeConnectionSection
        authStatus={AUTH_STATUS as Parameters<typeof ClaudeConnectionSection>[0]['authStatus']}
        onLogin={() => {}}
      />,
    );

    // يظهر حقل إدخال الرمز في اللافتة
    await waitFor(() => {
      expect(
        screen.getByLabelText(lookup('claudeConnection.tokenInput.ariaLabel') ?? 'Setup token'),
      ).toBeTruthy();
    });
  });

  it('saves the token and re-checks connection on success', async () => {
    // عند نجاح الحفظ: POST ثم GET للتحقق
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (typeof url === 'string' && url.includes('/api/providers/claude/api-key')) {
        if ((init?.method ?? 'GET').toUpperCase() === 'POST') {
          return {
            ok: true,
            json: async () => ({ success: true, data: { configured: true } }),
          };
        }
        return {
          ok: true,
          json: async () => ({ success: true, data: { configured: false, writable: true } }),
        };
      }
      if (typeof url === 'string' && url.includes('/api/user/claude-connection')) {
        return {
          ok: true,
          json: async () => ({ connected: false, provider: 'claude' }),
        };
      }
      return { ok: true, json: async () => ({}) };
    });

    render(
      <ClaudeConnectionSection
        authStatus={AUTH_STATUS as Parameters<typeof ClaudeConnectionSection>[0]['authStatus']}
        onLogin={() => {}}
      />,
    );

    const inputLabel = lookup('claudeConnection.tokenInput.ariaLabel') ?? 'Setup token';
    await waitFor(() => {
      expect(screen.getByLabelText(inputLabel)).toBeTruthy();
    });

    const input = screen.getByLabelText(inputLabel) as HTMLInputElement;
    fireEvent.change(input, { target: { value: VALID_TOKEN } });

    const saveLabel = lookup('claudeConnection.tokenInput.save') ?? 'Save token';
    const saveButton = screen.getByRole('button', { name: saveLabel });
    fireEvent.click(saveButton);

    await waitFor(() => {
      // POST /api/providers/claude/api-key استُدعي مع الرمز الصحيح
      const calls = mockFetch.mock.calls as Array<[string, RequestInit?]>;
      const postCall = calls.find(
        ([url, init]) =>
          typeof url === 'string' &&
          url.includes('/api/providers/claude/api-key') &&
          (init?.method ?? 'GET').toUpperCase() === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall![1]!.body as string) as { apiKey: string };
      expect(body.apiKey).toBe(VALID_TOKEN);
    });

    // refresh() استُدعي للتحقّق من الاتصال
    await waitFor(() => {
      expect(mockRefresh).toHaveBeenCalled();
    });
  });

  it('shows success message after save', async () => {
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (typeof url === 'string' && url.includes('/api/providers/claude/api-key')) {
        if ((init?.method ?? 'GET').toUpperCase() === 'POST') {
          return {
            ok: true,
            json: async () => ({ success: true, data: { configured: true } }),
          };
        }
        return {
          ok: true,
          json: async () => ({ success: true, data: { configured: false, writable: true } }),
        };
      }
      return { ok: true, json: async () => ({ connected: false, provider: 'claude' }) };
    });

    render(
      <ClaudeConnectionSection
        authStatus={AUTH_STATUS as Parameters<typeof ClaudeConnectionSection>[0]['authStatus']}
        onLogin={() => {}}
      />,
    );

    const inputLabel = lookup('claudeConnection.tokenInput.ariaLabel') ?? 'Setup token';
    await waitFor(() => expect(screen.getByLabelText(inputLabel)).toBeTruthy());

    fireEvent.change(screen.getByLabelText(inputLabel), { target: { value: VALID_TOKEN } });
    fireEvent.click(
      screen.getByRole('button', {
        name: lookup('claudeConnection.tokenInput.save') ?? 'Save token',
      }),
    );

    await waitFor(() => {
      expect(
        screen.getByText(lookup('claudeConnection.tokenInput.saved') ?? 'Token saved'),
      ).toBeTruthy();
    });
  });

  it('shows validation error when token is empty and does not call the API', async () => {
    render(
      <ClaudeConnectionSection
        authStatus={AUTH_STATUS as Parameters<typeof ClaudeConnectionSection>[0]['authStatus']}
        onLogin={() => {}}
      />,
    );

    const inputLabel = lookup('claudeConnection.tokenInput.ariaLabel') ?? 'Setup token';
    await waitFor(() => expect(screen.getByLabelText(inputLabel)).toBeTruthy());

    // لا نُدخل رمزاً — نضغط مباشرةً
    const saveButton = screen.getByRole('button', {
      name: lookup('claudeConnection.tokenInput.save') ?? 'Save token',
    });
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(
        screen.getByText(lookup('claudeConnection.tokenInput.emptyError') ?? 'Token is required'),
      ).toBeTruthy();
    });

    // تأكد أن POST لم يُرسَل
    const calls = mockFetch.mock.calls as Array<[string, RequestInit?]>;
    const postCalls = calls.filter(
      ([url, init]) =>
        typeof url === 'string' &&
        url.includes('/api/providers/claude/api-key') &&
        (init?.method ?? 'GET').toUpperCase() === 'POST',
    );
    expect(postCalls).toHaveLength(0);
  });

  it('shows server error message when the API returns a failure', async () => {
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (typeof url === 'string' && url.includes('/api/providers/claude/api-key')) {
        if ((init?.method ?? 'GET').toUpperCase() === 'POST') {
          return {
            ok: false,
            json: async () => ({ error: 'Invalid token' }),
          };
        }
        return {
          ok: true,
          json: async () => ({ success: true, data: { configured: false, writable: true } }),
        };
      }
      return { ok: true, json: async () => ({ connected: false, provider: 'claude' }) };
    });

    render(
      <ClaudeConnectionSection
        authStatus={AUTH_STATUS as Parameters<typeof ClaudeConnectionSection>[0]['authStatus']}
        onLogin={() => {}}
      />,
    );

    const inputLabel = lookup('claudeConnection.tokenInput.ariaLabel') ?? 'Setup token';
    await waitFor(() => expect(screen.getByLabelText(inputLabel)).toBeTruthy());

    fireEvent.change(screen.getByLabelText(inputLabel), { target: { value: VALID_TOKEN } });
    fireEvent.click(
      screen.getByRole('button', {
        name: lookup('claudeConnection.tokenInput.save') ?? 'Save token',
      }),
    );

    await waitFor(() => {
      expect(screen.getByText('Invalid token')).toBeTruthy();
    });
  });
});

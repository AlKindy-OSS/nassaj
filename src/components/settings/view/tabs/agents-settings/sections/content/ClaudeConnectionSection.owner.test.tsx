/**
 * ClaudeConnectionSection.owner.test.tsx — **حقل لصق الرمز يراه المالك أيضاً.**
 *
 * العطل الذي يحرسه هذا الملف: `claude setup-token` يطبع رمزاً يُعرض مرّةً واحدة
 * ولا يحفظه أحد؛ فالحفظ يقع في حقل لصقٍ داخل البطاقة. وكان ذلك الحقل مُصيَّراً
 * **داخل لافتة الدعوة** المشروطة بـ`!isOwner`، فالمالك — وهو على عقدةٍ فرديّة
 * المستخدمُ الوحيد — يرى الرمز في الطرفية ولا يجد أين يلصقه، فيقف الربط عند
 * خطوته الأخيرة. وشرطُ `!isOwner` بقيّةُ زمنٍ كان الخادم يربط فيه اعتماد
 * المُشغِّل رمزيّاً لكل حساب دوره `owner`، وقد أُزيل ذلك الرابط (ADR-105/B-486).
 *
 * الملف التوأم `ClaudeConnectionSection.test.tsx` يثبّت الحالة نفسها لعضوٍ غير
 * مالك: الإصلاح **يضيف** ولا يبدّل. وهما ملفّان لا واحد لأنّ `useAuth` يُزيَّف
 * على مستوى الوحدة، فالدور ثابتٌ لكل ملف.
 *
 * RUNNER: vitest (jsdom). NODE_ENV=test إلزامي.
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

const VALID_TOKEN = 'sk-ant-oat01-owner-token-value';
const TOKEN_LABEL = lookup('claudeConnection.tokenInput.ariaLabel') ?? 'Setup token';
const SAVE_LABEL = lookup('claudeConnection.tokenInput.save') ?? 'Save token';

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

/**
 * `writable` من `/api/providers/claude/api-key`:
 *   `true`  = مسموح، `false` = مرفوض (سياسة مشاركة)، `undefined` = خادم لم يُجب
 *   بالحقل — وهو **ليس رفضاً** (B-367).
 */
let writableAnswer: boolean | undefined = true;

beforeEach(() => {
  writableAnswer = true;
  mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (typeof url === 'string' && url.includes('/api/providers/claude/api-key')) {
      if ((init?.method ?? 'GET').toUpperCase() === 'POST') {
        return { ok: true, json: async () => ({ success: true, data: { configured: true } }) };
      }
      return {
        ok: true,
        json: async () => ({
          success: true,
          data: writableAnswer === undefined
            ? { configured: false }
            : { configured: false, writable: writableAnswer },
        }),
      };
    }
    return { ok: true, json: async () => ({ connected: false, provider: 'claude' }) };
  });
});

describe('ClaudeConnectionSection — the owner can finish the link', () => {
  it('renders the token paste field for an owner who is not connected', async () => {
    mount();

    await waitFor(() => {
      expect(
        screen.getByLabelText(TOKEN_LABEL),
        'the owner sees the printed token and must have somewhere to paste it',
      ).toBeTruthy();
    });
  });

  it('keeps the field a password input — the token is a secret, never shown back', async () => {
    mount();

    await waitFor(() => expect(screen.getByLabelText(TOKEN_LABEL)).toBeTruthy());
    expect((screen.getByLabelText(TOKEN_LABEL) as HTMLInputElement).type).toBe('password');
  });

  it('does NOT render the invite banner for an owner — only the paste path is shared', async () => {
    mount();

    await waitFor(() => expect(screen.getByLabelText(TOKEN_LABEL)).toBeTruthy());
    // ‏لافتةُ «اربط حسابك» دعوةٌ لعضوٍ لم يبدأ؛ سلوكُها لم يتغيّر بهذا الإصلاح.
    expect(
      screen.queryByRole('button', { name: lookup('claudeConnection.linkButton') ?? 'Link Claude account' }),
    ).toBeNull();
  });

  it('posts the pasted token and re-checks the connection', async () => {
    mount();
    await waitFor(() => expect(screen.getByLabelText(TOKEN_LABEL)).toBeTruthy());

    fireEvent.change(screen.getByLabelText(TOKEN_LABEL), { target: { value: VALID_TOKEN } });
    fireEvent.click(screen.getByRole('button', { name: SAVE_LABEL }));

    await waitFor(() => {
      const calls = mockFetch.mock.calls as Array<[string, RequestInit?]>;
      const post = calls.find(
        ([url, init]) =>
          typeof url === 'string'
          && url.includes('/api/providers/claude/api-key')
          && (init?.method ?? 'GET').toUpperCase() === 'POST',
      );
      expect(post, 'the owner save must reach the same writer as a member save').toBeTruthy();
      expect(JSON.parse(post![1]!.body as string).apiKey).toBe(VALID_TOKEN);
    });

    await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
  });

  it('hides the paste field once the credential is linked', async () => {
    mockConnection.mockReturnValue({
      connected: true,
      loading: false,
      error: null,
      refresh: mockRefresh,
    });
    mount();

    await waitFor(() => expect(screen.queryByLabelText(TOKEN_LABEL)).toBeNull());
  });

  /**
   * **B-362 — لا يُطلب لصقُ رمزٍ يُعرض مرّةً واحدة ممّن لا يستطيع حفظه.** تحت
   * سياسة `shared` يردّ الخادم 403 بعد الحفظ، وقد أُتلفت النسخة الوحيدة.
   */
  it('hides the paste field when the server says this user may not write', async () => {
    writableAnswer = false;
    mount();

    await waitFor(() => {
      expect(
        screen.getByText(lookup('claudeConnection.tokenInput.notWritable') ?? ''),
        'a refusal must be STATED, not rendered as a silent absence',
      ).toBeTruthy();
    });
    expect(
      screen.queryByLabelText(TOKEN_LABEL),
      'showing the field here costs the user the only copy of the token',
    ).toBeNull();
  });

  /**
   * **والغائب ليس رفضاً** (B-367): خادمٌ أقدم من الحقل لا يُرسل `writable`،
   * وقراءةُ الصمت رفضاً تقفل الباب على الجميع — المالك أوّلهم.
   */
  it('still shows the field when the server never answered `writable`', async () => {
    writableAnswer = undefined;
    mount();

    await waitFor(() => expect(screen.getByLabelText(TOKEN_LABEL)).toBeTruthy());
    expect(screen.queryByText(lookup('claudeConnection.tokenInput.notWritable') ?? '')).toBeNull();
  });
});

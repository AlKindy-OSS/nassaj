/**
 * subscriptionTokenWarning.test.tsx — **التحذير المالي يتبع نوع القيمة.**
 *
 * بطاقة Anthropic تقول عند تحديد موضع الاشتراك إنّ الحفظ «ينقل الفوترة إلى
 * استهلاك API بالعدّاد». وهذا صادقٌ في مفتاح API، وكاذبٌ في رمز
 * `claude setup-token` (‏`sk-ant-oat01-…`): ذاك الرمز هو الاشتراك نفسه، يُكتب
 * في `CLAUDE_CODE_OAUTH_TOKEN` لا في `ANTHROPIC_API_KEY`
 * (‏`claude-credentials.writer.ts`)، فلا خطّةَ تتوقّف ولا عدّادَ يبدأ.
 *
 * ويبقى الحارس المالي الأصلي قائماً: الحقلُ الفارغ ليس رمزَ اشتراك، فالأحمر
 * يُقرأ قبل أن يُلصق شيء — وهو ما يفحصه `companyKeySelection.test.tsx`.
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * ‏`t` مزيَّفة تُرجع `defaultValue` **وتُعوّض** `{{...}}`.
 *
 * السلسلة الشقيقة (`companyKeySelection`) تتركها بلا تعويض عمداً — تفحص سلوكاً
 * لا نصّاً. وهذا الملف يفحص **ما يقرؤه القارئ**: أنّ التحذير يسمّي موضعه. وبلا
 * تعويضٍ يبقى `{{slots}}` حرفاً على الشاشة، فيمرّ اختبارٌ يُثبت وجود قالبٍ لا
 * وجود اسم — وهو بالضبط العيب المفحوص.
 */
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const template = (opts?.defaultValue as string) ?? key;
      if (!opts) return template;
      return template.replace(/\{\{(\w+)\}\}/g, (whole, name: string) =>
        opts[name] === undefined ? whole : String(opts[name]));
    },
    i18n: { language: 'en' },
  }),
}));

const fetchMock = vi.fn();
vi.mock('../../../../../utils/api', () => ({
  authenticatedFetch: (...args: unknown[]) => fetchMock(...args),
}));

import VendorsSettingsTab from './VendorsSettingsTab';

const ANTHROPIC_SLOTS = [
  { vendorId: 'anthropic', provider: 'claude', configured: false, subscription: true },
  {
    vendorId: 'anthropic-opencode',
    provider: 'opencode',
    target: 'anthropic',
    configured: true,
    subscription: false,
  },
];

/** كل كتابة حاولها السطح، مفكوكة. */
let writes: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];

function mountWithAnthropic() {
  writes = [];
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method && init.method !== 'GET') {
      writes.push({
        url,
        method: init.method,
        body: init.body ? JSON.parse(String(init.body)) : {},
      });
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, data: { slots: [] } }),
      });
    }
    const data = url.includes('/company/anthropic/key')
      ? { companyId: 'anthropic', writable: true, slots: ANTHROPIC_SLOTS }
      : { companyId: 'other', writable: true, slots: [] };
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data }) });
  });
  const view = render(<VendorsSettingsTab />);
  const toggle = document.querySelector('[aria-controls="company-api-key-anthropic-places"]');
  if (toggle) fireEvent.click(toggle);
  return view;
}

const keyField = () => document.getElementById('company-api-key-anthropic') as HTMLInputElement;
const claudeBox = () => document.getElementById('vendor-slot-anthropic') as HTMLInputElement;

const METERED = /billing moves to metered API usage/i;
const TRUTHFUL = /subscription token, not an API key/i;
const FORBIDDEN = /only ever holds an API key/i;

const opencodeBox = () =>
  document.getElementById('vendor-slot-anthropic-opencode') as HTMLInputElement;

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
});

describe('the metered-billing warning is conditional on the value (Anthropic)', () => {
  it('still warns for an API key on the subscribed place', async () => {
    mountWithAnthropic();
    await waitFor(() => expect(claudeBox()).not.toBeNull());

    fireEvent.click(claudeBox());
    fireEvent.change(keyField(), { target: { value: 'sk-ant-api03-a-real-api-key' } });

    expect(screen.getByText(METERED)).toBeTruthy();
    expect(screen.queryByText(TRUTHFUL)).toBeNull();
  });

  it('does NOT claim metered billing for a subscription token', async () => {
    mountWithAnthropic();
    await waitFor(() => expect(claudeBox()).not.toBeNull());

    fireEvent.click(claudeBox());
    fireEvent.change(keyField(), { target: { value: 'sk-ant-oat01-a-subscription-token' } });

    expect(
      screen.queryByText(METERED),
      'a subscription token does not move billing — the warning must not claim it does',
    ).toBeNull();
    expect(screen.getByText(TRUTHFUL)).toBeTruthy();
  });

  it('keeps the red warning readable BEFORE anything is pasted (the original guard)', async () => {
    mountWithAnthropic();
    await waitFor(() => expect(claudeBox()).not.toBeNull());

    fireEvent.click(claudeBox());
    expect(
      screen.getByText(METERED),
      'an empty field is not a subscription token — the financial guard must not soften',
    ).toBeTruthy();
  });

  it('switches back to the red warning when the token is replaced by a key', async () => {
    mountWithAnthropic();
    await waitFor(() => expect(claudeBox()).not.toBeNull());

    fireEvent.click(claudeBox());
    fireEvent.change(keyField(), { target: { value: 'sk-ant-oat01-a-subscription-token' } });
    expect(screen.queryByText(METERED)).toBeNull();

    fireEvent.change(keyField(), { target: { value: 'sk-ant-api03-a-real-api-key' } });
    expect(screen.getByText(METERED)).toBeTruthy();
  });

  it('shows neither box while the subscribed place stays unticked', async () => {
    mountWithAnthropic();
    await waitFor(() => expect(keyField()).not.toBeNull());

    fireEvent.change(keyField(), { target: { value: 'sk-ant-oat01-a-subscription-token' } });
    expect(screen.queryByText(METERED)).toBeNull();
    expect(screen.queryByText(TRUTHFUL)).toBeNull();
  });
});

/**
 * **الطمأنةُ لا تُقال فوق كتابةٍ محظورة.** موضع `anthropic-opencode` لا يحمل
 * إلا مفتاح API، والكتالوج يقول عنه إنّ تمرير اشتراك Claude الشخصي عبره
 * «forbidden outright». وكان محدَّداً **افتراضاً**، فالصندوق الأزرق الذي يسمّي
 * موضع الاشتراك وحده كان يطمئن فوق كتابةٍ في موضعٍ لم يسمّه أحد.
 */
describe('a subscription token never defaults into an API-key-only place', () => {
  it('unticks the API-key-only place as soon as the value is a subscription token', async () => {
    mountWithAnthropic();
    await waitFor(() => expect(opencodeBox()).not.toBeNull());

    expect(opencodeBox().checked, 'an API key defaults into it — that part is unchanged').toBe(true);

    fireEvent.change(keyField(), { target: { value: 'sk-ant-oat01-a-subscription-token' } });
    expect(
      opencodeBox().checked,
      'a forbidden destination must not be inherited from a default',
    ).toBe(false);
    expect(screen.queryByText(FORBIDDEN)).toBeNull();
  });

  it('restores the default the moment the value is an API key again', async () => {
    mountWithAnthropic();
    await waitFor(() => expect(opencodeBox()).not.toBeNull());

    fireEvent.change(keyField(), { target: { value: 'sk-ant-oat01-a-subscription-token' } });
    expect(opencodeBox().checked).toBe(false);

    fireEvent.change(keyField(), { target: { value: 'sk-ant-api03-a-real-api-key' } });
    expect(opencodeBox().checked).toBe(true);
  });

  it('names the place explicitly when the reader ticks it anyway', async () => {
    mountWithAnthropic();
    await waitFor(() => expect(opencodeBox()).not.toBeNull());

    fireEvent.change(keyField(), { target: { value: 'sk-ant-oat01-a-subscription-token' } });
    fireEvent.click(opencodeBox());

    const warning = screen.getByText(FORBIDDEN);
    expect(warning, 'ticking it is allowed — silently, it is not').toBeTruthy();
    expect(
      warning.textContent,
      'a warning that does not name its place asks the reader to guess',
    ).toMatch(/inside OpenCode/);
  });

  it('keeps the request free of the forbidden place by default', async () => {
    mountWithAnthropic();
    await waitFor(() => expect(opencodeBox()).not.toBeNull());

    fireEvent.change(keyField(), { target: { value: 'sk-ant-oat01-a-subscription-token' } });
    fireEvent.click(claudeBox());
    // ‏`t` هنا تُعوّض، فاللصيقة تقرأ اسم الشركة لا القالب.
    fireEvent.click(screen.getAllByLabelText('Save Anthropic key')[0]);

    await waitFor(() => expect(writes.length).toBeGreaterThan(0));
    expect(
      writes[0].body.vendorIds,
      'the subscription token must not be shipped to the API-key-only slot',
    ).toEqual(['anthropic']);
  });
});

/**
 * **حارس تطابق** — البادئة مكتوبةٌ في موضعين: الخادم يقرّر بها وجهةَ القيمة،
 * والعميل يقرّر بها نصَّ التحذير. وانحرافُهما لا يُنتج عطلاً مرئياً بل ادّعاءً
 * مالياً كاذباً، فيُقرأ الملفّان معاً بدل الوثوق بنسخةٍ واحدة.
 */
describe('client/server parity for the subscription-token prefix', () => {
  it('reads the prefix from the one shared definition', () => {
    const root = path.resolve(__dirname, '../../../../../..');
    const read = (relative: string) => readFileSync(path.join(root, relative), 'utf8');

    // One definition in shared/, read by both sides: parity holds by
    // construction, so the guard is that nobody reintroduces a private literal.
    const literal = /'sk-ant-oat01-'/;
    const writer = read('server/modules/providers/list/claude/claude-credentials.writer.ts');
    const guard = read('server/modules/providers/shared/credentials/subscription-token-guard.ts');
    const card = read('src/components/settings/view/tabs/vendors-settings/CompanyCredentialCard.tsx');

    expect(read('shared/claudeSubscriptionToken.ts')).toMatch(literal);
    for (const [name, source] of [['writer', writer], ['guard', guard], ['card', card]] as const) {
      expect(source, `${name} defines its own prefix literal`).not.toMatch(literal);
      expect(source, `${name} does not read the shared prefix`).toMatch(/SUBSCRIPTION_TOKEN_PREFIX/);
    }
  });
});

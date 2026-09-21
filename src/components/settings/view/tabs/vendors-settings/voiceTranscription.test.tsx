/**
 * voiceTranscription.test.tsx — ما تَعِد به شاشةُ «التفريغ الصوتي الدقيق» وما
 * ترفض أن تَعِد به (ADR-103 / T-1247).
 *
 * كل حالةٍ هنا **وعدٌ نحو الخادم** لا تفصيلُ تخطيط. والوعود الأربعة:
 *
 *  1. **لا زرَّ يرفضه الخادم.** العضو العادي يرى المفتاح العامّ معطَّلاً، وخيارَ
 *     «كامل التثبيت» معطَّلاً بسببٍ مكتوب، ولا يرى حقلَ نقطة النهاية أصلاً. هذا
 *     هو نصفُ B-362 الذي لا يظهر في السجلّ: زرٌّ يبدو صالحاً ثم يردّ 403.
 *  2. **النطاق يُرسَل صريحاً**، ومفتاحُ المستخدم لا يذهب إلى نطاق التثبيت بالخطأ.
 *     ولا يبقى السرّ في الحقل بعد نجاح الحفظ.
 *  3. **رسالةُ الخادم عند الرفض تُعرض كما هي.** ابتلاعُها خلف «تعذّر الحفظ» يُخفي
 *     الحالتين اللتين لا يستطيع العميل توقّعهما: وضعُ المنصّة وتحقّقُ القيم
 *     (‏B-367).
 *  4. **fail-closed عند فشل القراءة**: لا تحكّم يعمل، ولا حقلَ مفتاح — لأن حالةً
 *     لم تُقرأ ليست حالةً «مطفأة» يُبنى عليها.
 *
 * ‏`t` مزيَّفة تُرجع المفتاح نفسه: هذا الملفّ يفحص السلوك، وترجمةٌ ناقصة يجب ألّا
 * تُسقط اختبارَ سلوك ولا أن تُمرّره.
 *
 * RUNNER: vitest (jsdom).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'ar' },
  }),
}));

let role: string | undefined = 'owner';
vi.mock('../../../../auth/context/AuthContext', () => ({
  useOptionalAuth: () => ({ user: { id: 1, username: 'tester', role } }),
}));

const fetchMock = vi.fn();
vi.mock('../../../../../utils/api', () => ({
  authenticatedFetch: (...args: unknown[]) => fetchMock(...args),
}));

import VoiceTranscriptionSection from './VoiceTranscriptionSection';

type SettingsPayload = {
  enabled: boolean;
  canManage: boolean;
  baseUrl: string;
  model: string;
  maxMb: number;
  key: { system: boolean; user: boolean };
  available: boolean;
};

const OPEN: SettingsPayload = {
  enabled: true,
  canManage: true,
  baseUrl: 'https://api.groq.com/openai/v1',
  model: 'whisper-large-v3',
  maxMb: 10,
  key: { system: false, user: true },
  available: true,
};

/** كل كتابةٍ حاولتها الشاشة، مفكوكة. */
let writes: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];

type WriteAnswer = { ok: boolean; status?: number; body?: Record<string, unknown> };

/**
 * @param settings جواب القراءة، أو `null` لمحاكاة فشلها (خادمٌ يردّ 500).
 * @param writeAnswer جواب أي كتابة لاحقة.
 */
function mount(
  settings: SettingsPayload | null = OPEN,
  writeAnswer: WriteAnswer = { ok: true, body: { scope: 'user', configured: true } },
) {
  writes = [];
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method && init.method !== 'GET') {
      writes.push({
        url,
        method: init.method,
        body: init.body ? JSON.parse(String(init.body)) : {},
      });
      return Promise.resolve({
        ok: writeAnswer.ok,
        status: writeAnswer.status ?? (writeAnswer.ok ? 200 : 403),
        json: () => Promise.resolve(writeAnswer.body ?? {}),
      });
    }
    if (settings === null) {
      return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(settings) });
  });
  return render(<VoiceTranscriptionSection />);
}

const keyField = () => document.getElementById('voice-transcription-key') as HTMLInputElement;
const toggle = () => screen.getByRole('switch') as HTMLButtonElement;
const scopeButton = (label: string) =>
  screen.getByRole('radio', { name: `voiceTranscription.scope.${label}` }) as HTMLButtonElement;
const scopeRow = (scope: string) =>
  document.querySelector(`li[data-scope="${scope}"]`) as HTMLElement;

beforeEach(() => {
  role = 'owner';
});

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
});

describe('حدود ما يملكه العضو (B-362)', () => {
  it('يعرض للعضو مفتاحاً معطَّلاً مع سببه، ولا يعرض له حقل نقطة النهاية', async () => {
    role = 'member';
    // الخادم نفسه يقول `canManage:false` لغير المالك — والشاشة تشتقّ منه لا تخمّن.
    mount({ ...OPEN, canManage: false });
    await waitFor(() => expect(keyField()).not.toBeNull());

    expect(toggle().disabled, 'مفتاح تشغيل الميزة للمالك وحده').toBe(true);
    expect(screen.getByText('voiceTranscription.ownerOnly')).toBeTruthy();
    expect(
      document.getElementById('voice-transcription-base-url'),
      'حقلٌ يردّ 403 عند الحفظ لا يُعرض أصلاً',
    ).toBeNull();
  });

  it('يعطّل «كامل التثبيت» لغير المالك/المشرف مع بقائه مرئياً وسببُه مكتوب', async () => {
    role = 'member';
    mount({ ...OPEN, canManage: false });
    await waitFor(() => expect(keyField()).not.toBeNull());

    const systemOption = scopeButton('system');
    expect(systemOption.disabled).toBe(true);
    expect(systemOption.getAttribute('title')).toBe('voiceTranscription.scope.systemBlocked');
    // «حسابي وحدي» يبقى عاملاً: الخادم يقبله من أيّ عضو لنفسه.
    expect(scopeButton('user').disabled).toBe(false);
  });

  it('يخفي زرّ حذف مفتاح التثبيت عن العضو ويُبقي حذف مفتاحه هو', async () => {
    role = 'member';
    mount({ ...OPEN, canManage: false, key: { system: true, user: true } });
    await waitFor(() => expect(keyField()).not.toBeNull());

    expect(within(scopeRow('system')).queryByRole('button')).toBeNull();
    expect(within(scopeRow('user')).getByRole('button')).toBeTruthy();
  });
});

describe('حفظ المفتاح وحذفه بكل نطاق', () => {
  it('يرسل النطاق «user» صريحاً ويفرّغ الحقل بعد النجاح', async () => {
    mount();
    await waitFor(() => expect(keyField()).not.toBeNull());

    fireEvent.change(keyField(), { target: { value: 'gsk-secret-1' } });
    fireEvent.click(screen.getByLabelText('voiceTranscription.key.saveAria'));

    await waitFor(() => expect(writes.length).toBeGreaterThan(0));
    expect(writes[0].method).toBe('PUT');
    expect(writes[0].url).toBe('/api/voice/transcription/key');
    expect(writes[0].body).toEqual({ apiKey: 'gsk-secret-1', scope: 'user' });
    // السرّ لا يبقى في الحالة بعد الحفظ الناجح.
    await waitFor(() => expect(keyField().value).toBe(''));
  });

  it('يرسل النطاق «system» بعد اختياره صراحةً، ويحذّر قبل الحفظ', async () => {
    mount(OPEN, { ok: true, body: { scope: 'system', configured: true } });
    await waitFor(() => expect(keyField()).not.toBeNull());

    fireEvent.click(scopeButton('system'));
    fireEvent.change(keyField(), { target: { value: 'gsk-secret-2' } });
    // إنفاقُ الجميع لمفتاحٍ واحد يُقرأ قبل تسليمه لا بعده.
    expect(screen.getByText('voiceTranscription.scope.systemNotice')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('voiceTranscription.key.saveAria'));
    await waitFor(() => expect(writes.length).toBeGreaterThan(0));
    expect(writes[0].body).toEqual({ apiKey: 'gsk-secret-2', scope: 'system' });
  });

  it('يحذف مفتاح نطاقٍ بعينه لا «المفتاح» مبهماً', async () => {
    mount({ ...OPEN, key: { system: true, user: true } }, { ok: true, body: { scope: 'system', configured: false } });
    await waitFor(() => expect(keyField()).not.toBeNull());

    fireEvent.click(within(scopeRow('system')).getByRole('button'));

    await waitFor(() => expect(writes.length).toBeGreaterThan(0));
    expect(writes[0].method).toBe('DELETE');
    expect(writes[0].url).toBe('/api/voice/transcription/key?scope=system');
  });

  it('لا يسمح بحفظ حقلٍ فارغ', async () => {
    mount();
    await waitFor(() => expect(keyField()).not.toBeNull());

    expect(
      (screen.getByLabelText('voiceTranscription.key.saveAria') as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe('رسالة الخادم عند الرفض (B-367)', () => {
  it('يعرض نصّ 403 كما ورد بدل رسالةٍ عامّة', async () => {
    mount(OPEN, {
      ok: false,
      status: 403,
      body: {
        error: 'This setting cannot be changed while the server runs in platform mode.',
        code: 'PLATFORM_MODE_WRITE_REFUSED',
      },
    });
    await waitFor(() => expect(keyField()).not.toBeNull());

    fireEvent.change(keyField(), { target: { value: 'gsk-secret-3' } });
    fireEvent.click(screen.getByLabelText('voiceTranscription.key.saveAria'));

    await waitFor(() =>
      expect(
        screen.getByText('This setting cannot be changed while the server runs in platform mode.'),
      ).toBeTruthy(),
    );
    // والحقل يبقى بما فيه: الحفظ لم يقع، فتفريغُه يمحو عملَ المستخدم على فشل.
    expect(keyField().value).toBe('gsk-secret-3');
  });

  it('يعرض رمز التحقّق من الخادم عند رفض نقطة نهاية غير صالحة', async () => {
    mount(OPEN, {
      ok: false,
      status: 400,
      body: { error: 'The transcription endpoint must use https.', code: 'INVALID_BASE_URL' },
    });
    await waitFor(() => expect(document.getElementById('voice-transcription-base-url')).not.toBeNull());

    fireEvent.change(document.getElementById('voice-transcription-base-url') as HTMLInputElement, {
      target: { value: 'http://example.com/v1' },
    });
    fireEvent.click(screen.getByLabelText('voiceTranscription.endpoint.saveAria'));

    await waitFor(() =>
      expect(screen.getByText('The transcription endpoint must use https.')).toBeTruthy(),
    );
  });
});

describe('fail-closed عند فشل القراءة', () => {
  it('يقفل كل تحكّم ويقول إن الحالة غير معروفة بدل ادّعاء أنها مطفأة', async () => {
    mount(null);
    await waitFor(() => expect(screen.getByText('voiceTranscription.loadFailed')).toBeTruthy());

    expect(toggle().getAttribute('aria-checked')).toBe('false');
    expect(toggle().disabled, 'حالةٌ لم تُقرأ لا يُبنى عليها فعل').toBe(true);
    expect(
      keyField(),
      'حقلُ سرٍّ تحت حالةٍ مجهولة قد يرسل المفتاح إلى وجهةٍ لا نعرفها',
    ).toBeNull();
    // ولا يُعرض نصّ «للمالك وحده»: السبب ليس الدور بل تعذّر القراءة.
    expect(screen.queryByText('voiceTranscription.ownerOnly')).toBeNull();
  });
});

/**
 * ChatComposer.voice.test.tsx — ADR-097 / B-428 / B-437
 *
 * طبقة العرض للتفريغ الصوتي: ما لا يستطيع اختبار الخطّاف إثباته لأنّه يعيش في
 * المكوّن — ظهور الزرّ، نافذة الإفصاح ودورة حياتها، حبس التركيز، ترجمة رموز
 * الخطأ، ومنطقة `aria-live`.
 *
 * لماذا التثبيت قبل التركيب: `isSupported` تُحسب مرّة واحدة في مُهيّئ الحالة عند
 * التركيب (باني `SpeechRecognition` + `isSecureContext`). و jsdom بلا الاثنين،
 * فالزرّ لا يُرسم أصلاً ما لم يُثبَّتا **قبل** `render` — لا بعده.
 *
 * الإفصاح لا يُختصر: محرّك Chromium يُرسل الصوت إلى خوادم Google، والموافقة
 * تُحفظ في مفتاح مُنطَّق بمعرّف المستخدم (جهاز واحد قد يحمل أكثر من حساب).
 *
 * Run: NODE_ENV=test npx vitest run src/components/chat/view/subcomponents/ChatComposer.voice.test.tsx
 */

import { createRef } from 'react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react';

import ChatComposer from './ChatComposer';
import {
  voiceConsentStorageKey,
  voiceLangStorageKey,
} from '../../hooks/useVoiceDictation';
import {
  voiceAccurateConsentStorageKey,
  voiceModeStorageKey,
} from '../../hooks/useVoiceTranscription';

/**
 * ADR-103 — الوضع الدقيق يسأل الخادم عن إتاحته. الافتراض هنا **الرفض**: كل
 * اختبارات الوضع السريع أدناه تعمل على خادم لا يجيب، وهو بالضبط ما يجب أن
 * يُبقي الوضع الدقيق مخفيّاً (fail-closed) دون أن يمسّ شيئاً في الوضع السريع.
 */
const authenticatedFetch = vi.fn();
vi.mock('../../../../utils/api', () => ({
  authenticatedFetch: (...args: unknown[]) => authenticatedFetch(...args),
}));

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTranslation: () => ({
    // مفتاح i18n يعود كما هو: الاختبار يوثّق **الخريطة** (رمز الخطأ ⇐ مفتاح)
    // لا الصياغة العربية التي قد تتغيّر بلا تغيّر عقد.
    t: (key: string, opts?: { defaultValue?: string }) => (opts && opts.defaultValue) || key,
    i18n: { language: 'ar' },
  }),
}));

// المستخدم (٧) حاضر: نطاق مفاتيح التخزين يجب أن يظهر في المفتاح المكتوب.
vi.mock('../../../auth/context/AuthContext', () => ({
  useOptionalAuth: () => ({ user: { id: 7 } }),
}));

const SCOPE = '7';

// ─── مزيّف SpeechRecognition (مطابق لمزيّف اختبار الخطّاف، بلا تشارك ملفّ) ───

class FakeSpeechRecognition {
  static instances: FakeSpeechRecognition[] = [];

  lang = '';
  continuous = false;
  interimResults = true;

  startCalls = 0;
  stopCalls = 0;
  abortCalls = 0;

  onresult: ((event: unknown) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  onstart: (() => void) | null = null;

  constructor() {
    FakeSpeechRecognition.instances.push(this);
  }

  start() {
    this.startCalls += 1;
  }
  stop() {
    this.stopCalls += 1;
  }
  abort() {
    this.abortCalls += 1;
  }

  emitStart() {
    this.onstart?.();
  }
  emitError(error: string) {
    this.onerror?.({ error });
  }
}

const instances = () => FakeSpeechRecognition.instances;
const lastInstance = () => {
  const list = FakeSpeechRecognition.instances;
  const rec = list[list.length - 1];
  if (!rec) throw new Error('لم تُنشأ أي نسخة SpeechRecognition');
  return rec;
};

function setSecureContext(value: boolean) {
  Object.defineProperty(window, 'isSecureContext', {
    value,
    configurable: true,
    writable: true,
  });
}

const noop = () => {};

const props = (overrides: Record<string, unknown> = {}) =>
  ({
    pendingPermissionRequests: [],
    handlePermissionDecision: noop,
    handleGrantToolPermission: () => ({ success: true }),
    claudeStatus: null,
    isLoading: false,
    onAbortSession: noop,
    provider: 'claude',
    displayProvider: 'claude',
    permissionMode: 'default',
    onModeSwitch: noop,
    thinkingMode: 'off',
    setThinkingMode: noop,
    composerMode: 'chat',
    setComposerMode: noop,
    agentModeAvailable: false,
    coordinationLevel: 'direct',
    setCoordinationLevel: noop,
    coordinationLevelAvailable: false,
    tokenBudget: null,
    slashCommandsCount: 0,
    onToggleCommandMenu: noop,
    hasInput: false,
    onClearInput: noop,
    isUserScrolledUp: false,
    hasMessages: false,
    onScrollToBottom: noop,
    onSubmit: noop,
    isDragActive: false,
    attachedImages: [],
    onRemoveImage: noop,
    uploadingImages: new Map(),
    imageErrors: new Map(),
    showFileDropdown: false,
    filteredFiles: [],
    selectedFileIndex: 0,
    onSelectFile: noop,
    filteredCommands: [],
    selectedCommandIndex: 0,
    onCommandSelect: noop,
    onCloseCommandMenu: noop,
    isCommandMenuOpen: false,
    frequentCommands: [],
    attachedFiles: [],
    onRemoveFile: noop,
    uploadingFiles: new Map(),
    fileErrors: new Map(),
    getRootProps: () => ({}),
    getInputProps: () => ({}),
    openImagePicker: noop,
    inputHighlightRef: createRef<HTMLDivElement>(),
    renderInputWithMentions: (text: string) => text,
    textareaRef: createRef<HTMLTextAreaElement>(),
    input: '',
    onVoiceInsert: noop,
    onInputChange: noop,
    onTextareaClick: noop,
    onTextareaKeyDown: noop,
    onTextareaPaste: noop,
    onTextareaScrollSync: noop,
    onTextareaInput: noop,
    placeholder: 'اكتب رسالتك',
    isTextareaExpanded: false,
    sessionId: 'session-a',
    ...overrides,
  }) as unknown as ComponentProps<typeof ChatComposer>;

const micButton = () => screen.getByRole('button', { name: 'input.voice.start' });
const activeMicButton = () => screen.getByRole('button', { name: 'input.voice.stop' });
const liveRegion = () => document.querySelector('[aria-live="polite"]') as HTMLElement;

function grantConsent() {
  window.localStorage.setItem(voiceConsentStorageKey(SCOPE), 'granted');
}

beforeEach(() => {
  FakeSpeechRecognition.instances = [];
  (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition = FakeSpeechRecognition;
  setSecureContext(true);
  window.localStorage.clear();
  authenticatedFetch.mockReset();
  // خادم صامت = لا وضع دقيق. تُبدَّل هذه النيّة صراحةً في قسم الوضع الدقيق.
  authenticatedFetch.mockRejectedValue(new Error('offline'));
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
  window.localStorage.clear();
  vi.restoreAllMocks();
});

// ─── 1. ظهور الزرّ: تدهور لطيف لا زرّ ميّت ──────────────────────────────────

describe('ظهور زرّ المايكروفون', () => {
  it('يظهر حين يتوفّر الباني والسياق آمن', () => {
    render(<ChatComposer {...props()} />);
    expect(micButton()).toBeTruthy();
    // لا صندوق `select` بجانبه: اختيار اللغة انتقل إلى قائمة منبثقة تُفتح
    // بالزرّ الأيمن/الضغط المطوّل، فلا يزاحم شريط الأدوات.
    expect(screen.queryByRole('combobox', { name: 'input.voice.language' })).toBeNull();
    expect(screen.queryByRole('menu')).toBeNull();
    // والزرّ يُعلن أنّه يفتح قائمة.
    expect(micButton().getAttribute('aria-haspopup')).toBe('menu');
    expect(micButton().getAttribute('aria-expanded')).toBe('false');
  });

  it('يُخفى كليّاً حين لا باني (Firefox) بدل زرّ لا يفعل شيئاً', () => {
    delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
    render(<ChatComposer {...props()} />);
    expect(screen.queryByRole('button', { name: 'input.voice.start' })).toBeNull();
  });

  it('يُخفى خارج السياق الآمن رغم وجود الباني', () => {
    // على http يرفض المتصفّح الالتقاط صامتاً: زرّ يبدو عاملاً وهو ميّت.
    setSecureContext(false);
    render(<ChatComposer {...props()} />);
    expect(screen.queryByRole('button', { name: 'input.voice.start' })).toBeNull();
  });

  it('يقبل باني webkit المُبادئ', () => {
    delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
    (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition =
      FakeSpeechRecognition;
    render(<ChatComposer {...props()} />);
    expect(micButton()).toBeTruthy();
    delete (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
  });
});

// ─── 2. نافذة الإفصاح ───────────────────────────────────────────────────────

describe('نافذة الإفصاح عن معالجة الصوت', () => {
  it('تظهر عند أول ضغطة ولا يبدأ التفريغ قبل الموافقة', () => {
    render(<ChatComposer {...props()} />);
    fireEvent.click(micButton());

    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(screen.getByText('input.voice.consent')).toBeTruthy();
    // لا التقاط قبل الإفصاح.
    expect(instances()).toHaveLength(0);
  });

  it('الموافقة تبدأ التفريغ وتُحفظ في المفتاح المُنطَّق بمعرّف المستخدم', () => {
    render(<ChatComposer {...props()} />);
    fireEvent.click(micButton());
    fireEvent.click(screen.getByRole('button', { name: 'input.voice.consentAccept' }));

    expect(window.localStorage.getItem(voiceConsentStorageKey(SCOPE))).toBe('granted');
    // لا يُكتب في المفتاح غير المُنطَّق (موافقة مستخدم لا تُملى على شريكه بالجهاز).
    expect(window.localStorage.getItem(voiceConsentStorageKey())).toBeNull();
    expect(window.localStorage.getItem(voiceLangStorageKey(SCOPE))).toBeNull();
    expect(instances()).toHaveLength(1);
    expect(lastInstance().startCalls).toBe(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('لا تتكرّر بعد الموافقة: الضغطة التالية تبدأ التفريغ مباشرة', () => {
    render(<ChatComposer {...props()} />);
    fireEvent.click(micButton());
    fireEvent.click(screen.getByRole('button', { name: 'input.voice.consentAccept' }));
    // إيقاف الجلسة الأولى ثم بدء ثانية.
    fireEvent.click(activeMicButton());
    fireEvent.click(micButton());

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(instances()).toHaveLength(2);
  });

  it('موافقة محفوظة مسبقاً تتخطّى النافذة من أول ضغطة', () => {
    grantConsent();
    render(<ChatComposer {...props()} />);
    fireEvent.click(micButton());

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(instances()).toHaveLength(1);
  });

  it('الإلغاء لا يبدأ التفريغ ولا يُسجّل موافقة', () => {
    render(<ChatComposer {...props()} />);
    fireEvent.click(micButton());
    fireEvent.click(screen.getByRole('button', { name: 'input.voice.consentCancel' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(instances()).toHaveLength(0);
    expect(window.localStorage.getItem(voiceConsentStorageKey(SCOPE))).toBeNull();
    // والضغطة التالية تُعيد عرض الإفصاح: الرفض لا يُحفظ موافقةً ضمنية.
    fireEvent.click(micButton());
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});

// ─── 3. التركيز: حبسه داخل النافذة وإعادته إلى الزرّ ────────────────────────

describe('تركيز نافذة الإفصاح', () => {
  it('يبدأ على زرّ التأكيد', () => {
    render(<ChatComposer {...props()} />);
    fireEvent.click(micButton());

    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'input.voice.consentAccept' }),
    );
  });

  it('Tab محبوس داخل النافذة لا يهرب إلى المُؤلِّف خلف الحجاب', () => {
    render(<ChatComposer {...props()} />);
    fireEvent.click(micButton());

    const confirm = screen.getByRole('button', { name: 'input.voice.consentAccept' });
    const cancel = screen.getByRole('button', { name: 'input.voice.consentCancel' });

    // التأكيد آخر عنصر في النافذة ⇒ Tab يلتفّ إلى أوّلها (الإلغاء).
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement).toBe(cancel);

    // وShift+Tab من الأوّل يلتفّ إلى الأخير.
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(confirm);
  });

  it('Escape يُغلق ويُعيد التركيز إلى زرّ المايكروفون', () => {
    render(<ChatComposer {...props()} />);
    const button = micButton();
    fireEvent.click(button);
    expect(screen.getByRole('dialog')).toBeTruthy();

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(instances()).toHaveLength(0);
    expect(document.activeElement).toBe(button);
  });

  it('الإلغاء بالنقر يُعيد التركيز إلى زرّ المايكروفون', () => {
    render(<ChatComposer {...props()} />);
    const button = micButton();
    fireEvent.click(button);
    fireEvent.click(screen.getByRole('button', { name: 'input.voice.consentCancel' }));

    expect(document.activeElement).toBe(button);
  });
});

// ─── 4. حالة الزرّ والإعلان الصوتي ──────────────────────────────────────────

describe('حالة الاستماع المعروضة', () => {
  it('الزرّ يستجيب فوراً للطلب، وشارة «يستمع» تنتظر الالتقاط الفعلي', () => {
    grantConsent();
    render(<ChatComposer {...props()} />);
    fireEvent.click(micButton());

    // طلب قائم لم يلتقط بعد: الزرّ مضغوط، ولا شارة استماع (الميكروفون صامت).
    expect(activeMicButton().getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByText('input.voice.listening')).toBeNull();

    act(() => lastInstance().emitStart());

    expect(screen.getByText('input.voice.listening')).toBeTruthy();
  });

  it('منطقة aria-live تُعلن البدء ثم الإيقاف مرّة واحدة لكل جلسة', () => {
    grantConsent();
    render(<ChatComposer {...props()} />);
    expect(liveRegion().textContent).toBe('');

    fireEvent.click(micButton());
    expect(liveRegion().textContent).toBe('input.voice.startedAnnouncement');

    act(() => lastInstance().emitStart());
    // الالتقاط الفعلي لا يُعيد الإعلان: الإعلان على مستوى الجلسة لا الالتقاط.
    expect(liveRegion().textContent).toBe('input.voice.startedAnnouncement');

    fireEvent.click(activeMicButton());
    expect(liveRegion().textContent).toBe('input.voice.stoppedAnnouncement');
  });

  it('الخطأ يُعلَن في المنطقة الحيّة كذلك', () => {
    grantConsent();
    render(<ChatComposer {...props()} />);
    fireEvent.click(micButton());
    act(() => lastInstance().emitError('audio-capture'));

    expect(liveRegion().textContent).toBe('input.voice.errors.audioCapture');
  });
});

// ─── 5. خريطة رموز الخطأ إلى نصوص i18n ─────────────────────────────────────

describe('عرض الخطأ', () => {
  const cases: Array<[string, string]> = [
    ['not-allowed', 'input.voice.errors.notAllowed'],
    ['service-not-allowed', 'input.voice.errors.notAllowed'],
    ['network', 'input.voice.errors.network'],
    ['audio-capture', 'input.voice.errors.audioCapture'],
    ['language-not-supported', 'input.voice.errors.languageNotSupported'],
  ];

  // `network` وحده قابل للتعافي، فلا يُعرض من أوّل مرّة (ومضةُ عطلٍ تُصلحه
  // إعادة التشغيل التالية تُقرأ انقطاعاً). البقية نهائية تُعرض فوراً.
  const emitUntilShown = (code: string) => {
    act(() => lastInstance().emitError(code));
    if (code === 'network') {
      act(() => lastInstance().emitError(code));
    }
  };

  it.each(cases)('الرمز %s يُعرض بالمفتاح %s', (code, key) => {
    grantConsent();
    render(<ChatComposer {...props()} />);
    fireEvent.click(micButton());
    emitUntilShown(code);

    // النصّ المرئي بجانب الزرّ + نسخة قارئ الشاشة: الخطأ لا يصمت.
    expect(screen.getAllByText(key).length).toBeGreaterThanOrEqual(1);
  });

  it('خطأ network عابر لا يومض من أوّل مرّة', () => {
    grantConsent();
    render(<ChatComposer {...props()} />);
    fireEvent.click(micButton());
    act(() => lastInstance().emitError('network'));

    expect(screen.queryByText('input.voice.errors.network')).toBeNull();
  });

  it('رمز غير معروف يسقط على الرسالة العامّة لا على الرمز الخام', () => {
    grantConsent();
    render(<ChatComposer {...props()} />);
    fireEvent.click(micButton());
    // رمز مجهول = قابل لإعادة المحاولة في نظر الخطّاف ⇒ يظهر عند تكراره.
    act(() => lastInstance().emitError('some-brand-new-code'));
    act(() => lastInstance().emitError('some-brand-new-code'));

    expect(screen.getAllByText('input.voice.errors.generic').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('some-brand-new-code')).toBeNull();
  });

  it('لا نصّ خطأ قبل وقوع خطأ', () => {
    grantConsent();
    render(<ChatComposer {...props()} />);
    fireEvent.click(micButton());

    expect(screen.queryByText('input.voice.errors.generic')).toBeNull();
    expect(screen.queryByText('input.voice.errors.network')).toBeNull();
  });
});

// ─── 6. قائمة لغة التفريغ (زرّ أيمن / ضغط مطوّل) ────────────────────────────

describe('قائمة لغة التفريغ', () => {
  // jsdom بلا `PointerEvent`، و`fireEvent.pointerDown` تُسقط `pointerType`
  // والإحداثيات صامتةً — فيُختبَر فرعُ اللمس بينما هو في الواقع فرع الفأرة.
  // نبني `MouseEvent` باسم حدث المؤشّر (React تلتقطه بالاسم) ونُلحق نوعه.
  const firePointer = (
    element: Element,
    type: 'pointerdown' | 'pointermove' | 'pointerup',
    init: { pointerType?: string; clientX?: number; clientY?: number } = {},
  ) => {
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: init.clientX ?? 0,
      clientY: init.clientY ?? 0,
    });
    Object.defineProperty(event, 'pointerType', { value: init.pointerType ?? 'touch' });
    fireEvent(element, event);
  };

  const menu = () => screen.getByRole('menu');
  const items = () => screen.getAllByRole('menuitemradio');
  const itemByTag = (tag: string) =>
    items().find((node) => node.textContent?.includes(tag)) as HTMLButtonElement;
  /** صفوف اللغات وحدها: قسم الوضع يعيش في القائمة نفسها وله مؤشَّرُه الخاص. */
  const langItems = () =>
    items().filter((node) => !/input\.voice\.mode(Fast|Accurate)/.test(node.textContent || ''));

  it('الزرّ الأيمن يفتحها ويمنع قائمة المتصفّح ولا يبدأ التفريغ', () => {
    grantConsent();
    render(<ChatComposer {...props()} />);
    const button = micButton();

    const event = createEvent.contextMenu(button);
    fireEvent(button, event);

    expect(event.defaultPrevented).toBe(true);
    expect(menu()).toBeTruthy();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    // فتح القائمة ليس نيّة تفريغ.
    expect(instances()).toHaveLength(0);
  });

  it('تعرض كل الخيارات وتُعلّم اللغة الحالية وحدها', () => {
    render(<ChatComposer {...props()} />);
    fireEvent.contextMenu(micButton());

    // ثمانية لغات + صفّا الوضع (سريع/دقيق): قسم الوضع يُعرض دائماً منذ صار
    // الإخفاء الصامت يُبدَّل بسببٍ منطوق.
    expect(items()).toHaveLength(10);
    expect(langItems()).toHaveLength(8);
    // مؤشَّر واحد لكل قسم: لغةٌ واحدة ووضعٌ واحد — لا مؤشَّران في قسم واحد.
    const checked = langItems().filter((node) => node.getAttribute('aria-checked') === 'true');
    expect(checked).toHaveLength(1);
    expect(checked[0].textContent).toContain('en-US');
    // الاسم معروض بلُغته لا بالرمز وحده (Intl.DisplayNames، مع سقوط لطيف).
    expect(itemByTag('ar-SA').textContent).toContain('العربية');
  });

  it('الضغط المطوّل يفتحها على اللمس، ولا يبدأ التفريغ بالنقرة التابعة', () => {
    vi.useFakeTimers();
    try {
      grantConsent();
      render(<ChatComposer {...props()} />);
      const button = micButton();

      firePointer(button, 'pointerdown', { pointerType: 'touch', clientX: 10, clientY: 10 });
      expect(screen.queryByRole('menu')).toBeNull();

      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(menu()).toBeTruthy();

      // اللمس قد يُطلق contextmenu فوق مؤقّتنا: قائمة واحدة لا اثنتان ولا إغلاق.
      fireEvent.contextMenu(button);
      expect(screen.getAllByRole('menu')).toHaveLength(1);

      firePointer(button, 'pointerup', { pointerType: 'touch' });
      fireEvent.click(button);

      expect(instances()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('رفع الإصبع قبل العتبة لا يفتحها', () => {
    vi.useFakeTimers();
    try {
      grantConsent();
      render(<ChatComposer {...props()} />);
      const button = micButton();

      firePointer(button, 'pointerdown', { pointerType: 'touch', clientX: 10, clientY: 10 });
      act(() => {
        vi.advanceTimersByTime(200);
      });
      firePointer(button, 'pointerup', { pointerType: 'touch' });
      act(() => {
        vi.advanceTimersByTime(600);
      });

      expect(screen.queryByRole('menu')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('السحب أثناء الضغط يُلغيه (صفّ الأدوات نفسه يُمرَّر)', () => {
    vi.useFakeTimers();
    try {
      render(<ChatComposer {...props()} />);
      const button = micButton();

      firePointer(button, 'pointerdown', { pointerType: 'touch', clientX: 10, clientY: 10 });
      firePointer(button, 'pointermove', { pointerType: 'touch', clientX: 60, clientY: 12 });
      act(() => {
        vi.advanceTimersByTime(600);
      });

      expect(screen.queryByRole('menu')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('التمرير أثناء الضغط يُلغيه', () => {
    vi.useFakeTimers();
    try {
      render(<ChatComposer {...props()} />);
      const button = micButton();

      firePointer(button, 'pointerdown', { pointerType: 'touch', clientX: 10, clientY: 10 });
      fireEvent.scroll(document.body);
      act(() => {
        vi.advanceTimersByTime(600);
      });

      expect(screen.queryByRole('menu')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('الاختيار يُغيّر اللغة ويُخزّنها في المفتاح المُنطَّق ويُعيد التركيز', () => {
    render(<ChatComposer {...props()} />);
    const button = micButton();
    fireEvent.contextMenu(button);

    fireEvent.click(itemByTag('de-DE'));

    expect(window.localStorage.getItem(voiceLangStorageKey(SCOPE))).toBe('de-DE');
    // ولا يتسرّب إلى المفتاح غير المُنطَّق (جهاز واحد قد يحمل أكثر من حساب).
    expect(window.localStorage.getItem(voiceLangStorageKey())).toBeNull();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(button);

    // والاختيار الجديد هو المُعلَّم عند إعادة الفتح.
    fireEvent.contextMenu(button);
    expect(itemByTag('de-DE').getAttribute('aria-checked')).toBe('true');
  });

  it('Shift+F10 يفتحها لمستخدم لوحة المفاتيح، والأسهم تنقّل التركيز', () => {
    render(<ChatComposer {...props()} />);
    const button = micButton();
    fireEvent.keyDown(button, { key: 'F10', shiftKey: true });

    expect(menu()).toBeTruthy();
    // التركيز يبدأ على اللغة الحالية لا على أوّل الخيارات.
    const currentLang = langItems().find((node) => node.getAttribute('aria-checked') === 'true');
    const current = items().indexOf(currentLang as HTMLButtonElement);
    expect(document.activeElement).toBe(items()[current]);

    fireEvent.keyDown(menu(), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items()[(current + 1) % items().length]);

    fireEvent.keyDown(menu(), { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items()[current]);

    fireEvent.keyDown(menu(), { key: 'Home' });
    expect(document.activeElement).toBe(items()[0]);
  });

  it('Escape يُغلقها ويُعيد التركيز إلى زرّ المايكروفون', () => {
    render(<ChatComposer {...props()} />);
    const button = micButton();
    fireEvent.contextMenu(button);
    expect(menu()).toBeTruthy();

    fireEvent.keyDown(menu(), { key: 'Escape' });

    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(button);
    expect(instances()).toHaveLength(0);
  });

  it('النقر خارجها يُغلقها بلا تفريغ', () => {
    render(<ChatComposer {...props()} />);
    fireEvent.contextMenu(micButton());
    expect(menu()).toBeTruthy();

    fireEvent.pointerDown(document.body);

    expect(screen.queryByRole('menu')).toBeNull();
    expect(instances()).toHaveLength(0);
  });

  it('النقر العادي ما زال يبدأ التفريغ', () => {
    grantConsent();
    render(<ChatComposer {...props()} />);
    const button = micButton();

    firePointer(button, 'pointerdown', { pointerType: 'mouse', clientX: 10, clientY: 10 });
    firePointer(button, 'pointerup', { pointerType: 'mouse' });
    fireEvent.click(button);

    expect(instances()).toHaveLength(1);
    expect(lastInstance().startCalls).toBe(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

// ─── 7. تبديل الجلسة يقطع التفريغ قطعاً ────────────────────────────────────

describe('تبديل الجلسة', () => {
  it('يُجهض النسخة الحيّة فلا يتسرّب التفريغ إلى مسودّة المحادثة الجديدة', () => {
    grantConsent();
    const { rerender } = render(<ChatComposer {...props()} />);
    fireEvent.click(micButton());
    act(() => lastInstance().emitStart());
    const rec = lastInstance();

    rerender(<ChatComposer {...props({ sessionId: 'session-b' })} />);

    // إجهاض لا إيقاف لطيف: النتيجة المعلّقة هناك ليست «متأخّرة» بل تسرُّب.
    expect(rec.abortCalls).toBe(1);
    expect(rec.stopCalls).toBe(0);
    expect(rec.onresult).toBeNull();
    expect(screen.queryByText('input.voice.listening')).toBeNull();
    expect(micButton().getAttribute('aria-pressed')).toBe('false');
  });
});

// ─── 8. الوضع الدقيق (ADR-103 / T-1248) ────────────────────────────────────
//
// ما يُثبَّت هنا هو ما لا يستطيع اختبار الخطّاف إثباته: المبدّل داخل القائمة،
// بوابة الإتاحة القادمة من الخادم، الإفصاح المستقلّ، وأنّ تبديل الجلسة يقطع
// تسجيلاً جارياً بلا إدراج متأخّر في المسودّة الخطأ.

describe('الوضع الدقيق', () => {
  class FakeTrack {
    stopped = false;
    stop() {
      this.stopped = true;
    }
  }

  class FakeStream {
    tracks = [new FakeTrack()];
    getTracks() {
      return this.tracks;
    }
  }

  class FakeMediaRecorder {
    static instances: FakeMediaRecorder[] = [];
    static isTypeSupported = () => true;

    state: 'inactive' | 'recording' = 'inactive';
    mimeType = 'audio/webm';
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: (() => void) | null = null;

    constructor() {
      FakeMediaRecorder.instances.push(this);
    }
    start() {
      this.state = 'recording';
    }
    stop() {
      this.state = 'inactive';
      this.onstop?.();
    }
    emitData() {
      this.ondataavailable?.({ data: new Blob(['صوت'], { type: 'audio/webm' }) });
    }
  }

  let stream: FakeStream;
  /** جواب `/transcription` — يُبدَّل لكل حالة (نجاح، رمز خطأ، تعليق). */
  let transcribeResponse: unknown;
  let settingsBody: Record<string, unknown>;

  const settingsPayload = (overrides: Record<string, unknown> = {}) => ({
    enabled: true,
    canManage: false,
    baseUrl: 'https://api.openai.com/v1',
    model: 'whisper-1',
    maxMb: 10,
    key: { system: true, user: false },
    available: true,
    ...overrides,
  });

  const jsonOk = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
  const jsonErr = (body: unknown, status: number) => ({ ok: false, status, json: async () => body });

  beforeEach(() => {
    FakeMediaRecorder.instances = [];
    stream = new FakeStream();
    settingsBody = settingsPayload();
    transcribeResponse = jsonOk({ text: 'النصّ المفرَّغ' });
    (window as unknown as { MediaRecorder: unknown }).MediaRecorder = FakeMediaRecorder;
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: async () => stream },
      configurable: true,
    });
    authenticatedFetch.mockReset();
    authenticatedFetch.mockImplementation(async (url: string) =>
      url.includes('/settings') ? jsonOk(settingsBody) : transcribeResponse,
    );
  });

  afterEach(() => {
    delete (window as unknown as { MediaRecorder?: unknown }).MediaRecorder;
  });

  const renderComposer = async (overrides: Record<string, unknown> = {}) => {
    const view = render(<ChatComposer {...props(overrides)} />);
    // إعدادات الخادم تصل بعد رحلة غير متزامنة؛ بلا تفريغها يُقاس الوضع قبل
    // أن يعرف المكوّن أنّ الدقيق متاح أصلاً.
    await act(async () => {});
    return view;
  };

  const openMenu = (button: HTMLElement) => {
    fireEvent.contextMenu(button);
  };

  const menuItems = () => screen.getAllByRole('menuitemradio');
  const itemByText = (fragment: string) =>
    menuItems().find((node) => node.textContent?.includes(fragment)) as HTMLButtonElement;

  const accurateMic = () => screen.getByRole('button', { name: 'input.voice.startAccurate' });

  const startAccurateRecording = async () => {
    window.localStorage.setItem(voiceModeStorageKey(SCOPE), 'accurate');
    window.localStorage.setItem(voiceAccurateConsentStorageKey(SCOPE), 'granted');
    const view = await renderComposer();
    fireEvent.click(accurateMic());
    await screen.findByText('input.voice.recording');
    act(() => FakeMediaRecorder.instances[0].emitData());
    return view;
  };

  // ── الإتاحة ──────────────────────────────────────────────────────────────

  it('يظهر معطّلاً بسبب «لا مفتاح» حين available=false و enabled=false', async () => {
    settingsBody = settingsPayload({ enabled: false, available: false, key: { system: false, user: false } });
    await renderComposer();
    openMenu(micButton());
    // القسم يُعرض دائماً: اختفاؤه صامتاً كان يُرسل المستخدم يبحث عن عطل في جهازه.
    expect(screen.getByText('input.voice.modeAccurate')).toBeTruthy();
    expect(screen.getAllByText('input.voice.modeAccurateNeedsKey').length).toBeGreaterThan(0);
  });

  it('فشل الاستعلام يقول «تعذّر سؤال الخادم» لا «يحتاج مفتاحاً»', async () => {
    authenticatedFetch.mockRejectedValue(new Error('offline'));
    await renderComposer();
    openMenu(micButton());
    // سببان لا واحد: صفحةٌ لم تُحدَّث ليست مفتاحاً ناقصاً، وخلطهما أضاع ساعة
    // من التشخيص على مالك المنتج نفسه.
    expect(screen.getAllByText('input.voice.modeAccurateUnknown').length).toBeGreaterThan(0);
    expect(screen.queryByText('input.voice.modeAccurateNeedsKey')).toBeNull();
  });

  it('يظهر معطّلاً مع سببه حين enabled=true بلا مفتاح — لا اختفاء صامت', async () => {
    settingsBody = settingsPayload({ available: false, key: { system: false, user: false } });
    await renderComposer();
    openMenu(micButton());

    const accurate = itemByText('input.voice.modeAccurate');
    expect(accurate.getAttribute('aria-disabled')).toBe('true');
    expect(accurate.textContent).toContain('input.voice.modeAccurateNeedsKey');
    // ونقره لا يبدّل الوضع.
    fireEvent.click(accurate);
    expect(window.localStorage.getItem(voiceModeStorageKey(SCOPE))).toBeNull();
  });

  // ── المبدّل ──────────────────────────────────────────────────────────────

  it('اختيار الوضع الدقيق يُحفظ في مفتاح مُنطَّق ويصمد بعد إعادة الفتح', async () => {
    // البدء من السريع صراحةً: الافتراضي صار «مستمرّاً»، وما يُختبَر هنا هو
    // الانتقال إليه لا الحالة الابتدائية.
    window.localStorage.setItem(voiceModeStorageKey(SCOPE), 'fast');
    await renderComposer();
    const button = micButton();
    openMenu(button);

    fireEvent.click(itemByText('input.voice.modeAccurate'));

    expect(window.localStorage.getItem(voiceModeStorageKey(SCOPE))).toBe('accurate');
    expect(window.localStorage.getItem(voiceModeStorageKey())).toBeNull();
    expect(screen.queryByRole('menu')).toBeNull();

    // الزرّ صار زرّ الوضع الدقيق، والقائمة تُعلّم الوضع الجديد وحده.
    const accurateButton = accurateMic();
    openMenu(accurateButton);
    expect(itemByText('input.voice.modeAccurate').getAttribute('aria-checked')).toBe('true');
    expect(itemByText('input.voice.modeFast').getAttribute('aria-checked')).toBe('false');
  });

  it('قائمة اللغات تختفي في الوضع الدقيق ويحلّ محلّها سطر يشرح السبب', async () => {
    window.localStorage.setItem(voiceModeStorageKey(SCOPE), 'accurate');
    await renderComposer();
    openMenu(accurateMic());

    expect(screen.queryByText('العربية')).toBeNull();
    expect(menuItems().every((node) => !node.textContent?.includes('ar-SA'))).toBe(true);
    expect(screen.getByText('input.voice.languageAutoNote')).toBeTruthy();

    // والعودة إلى السريع تُعيدها.
    fireEvent.click(itemByText('input.voice.modeFast'));
    openMenu(micButton());
    expect(itemByText('ar-SA')).toBeTruthy();
  });

  it('التبديل يقطع استماعاً جارياً في الوضع السريع بلا نتيجة متأخّرة', async () => {
    grantConsent();
    window.localStorage.setItem(voiceModeStorageKey(SCOPE), 'fast');
    await renderComposer();
    fireEvent.click(micButton());
    act(() => lastInstance().emitStart());
    const rec = lastInstance();

    openMenu(activeMicButton());
    fireEvent.click(itemByText('input.voice.modeAccurate'));

    expect(rec.abortCalls).toBe(1);
    expect(rec.onresult).toBeNull();
  });

  // ── الإفصاح المستقلّ ─────────────────────────────────────────────────────

  it('موافقة الوضع السريع لا تُغني عن إفصاح الوضع الدقيق', async () => {
    grantConsent();
    window.localStorage.setItem(voiceModeStorageKey(SCOPE), 'accurate');
    await renderComposer();

    fireEvent.click(accurateMic());

    expect(screen.getByText('input.voice.accurateConsent')).toBeTruthy();
    expect(FakeMediaRecorder.instances).toHaveLength(0);

    fireEvent.click(screen.getByText('input.voice.consentAccept'));
    await screen.findByText('input.voice.recording');
    expect(window.localStorage.getItem(voiceAccurateConsentStorageKey(SCOPE))).toBe('granted');
    // ولم تُلمَس موافقة الوضع السريع ولا العكس.
    expect(window.localStorage.getItem(voiceConsentStorageKey(SCOPE))).toBe('granted');
  });

  // ── دورة التسجيل ─────────────────────────────────────────────────────────

  it('التسجيل ثمّ الرفع يُدرج النصّ مرّة واحدة بمسار onVoiceInsert نفسه', async () => {
    const onVoiceInsert = vi.fn();
    window.localStorage.setItem(voiceModeStorageKey(SCOPE), 'accurate');
    window.localStorage.setItem(voiceAccurateConsentStorageKey(SCOPE), 'granted');
    await renderComposer({ onVoiceInsert });

    fireEvent.click(accurateMic());
    await screen.findByText('input.voice.recording');
    act(() => FakeMediaRecorder.instances[0].emitData());

    fireEvent.click(screen.getByRole('button', { name: 'input.voice.stopAccurate' }));
    await act(async () => {});

    expect(onVoiceInsert).toHaveBeenCalledTimes(1);
    expect(onVoiceInsert).toHaveBeenCalledWith('النصّ المفرَّغ');
    expect(screen.queryByText('input.voice.recording')).toBeNull();
    expect(liveRegion().textContent).toBe('input.voice.transcribedAnnouncement');
  });

  it('حالة «يُفرَّغ» ظاهرة والزرّ معطَّل أثناء الرفع', async () => {
    let resolveUpload: (value: unknown) => void = () => {};
    transcribeResponse = new Promise((resolve) => {
      resolveUpload = resolve;
    });
    await startAccurateRecording();

    fireEvent.click(screen.getByRole('button', { name: 'input.voice.stopAccurate' }));
    const busy = await screen.findByRole('button', { name: 'input.voice.transcribing' });

    expect((busy as HTMLButtonElement).disabled).toBe(true);
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect(screen.getAllByText('input.voice.transcribing').length).toBeGreaterThan(0);
    expect(liveRegion().textContent).toBe('input.voice.transcribingAnnouncement');

    await act(async () => {
      resolveUpload({ ok: true, status: 200, json: async () => ({ text: 'تمّ' }) });
    });
  });

  it('التسجيل يُنهي مسارات الـstream فلا يبقى مؤشّر الميكروفون مضاءً', async () => {
    await startAccurateRecording();
    fireEvent.click(screen.getByRole('button', { name: 'input.voice.stopAccurate' }));
    await act(async () => {});
    expect(stream.tracks.every((track) => track.stopped)).toBe(true);
  });

  // ── رموز الخطأ ───────────────────────────────────────────────────────────

  const errorCases: Array<[string, number, string]> = [
    ['NO_TRANSCRIPTION_KEY', 409, 'input.voice.errors.noKey'],
    ['INVALID_TRANSCRIPTION_KEY', 502, 'input.voice.errors.invalidKey'],
    ['TRANSCRIPTION_RATE_LIMITED', 429, 'input.voice.errors.rateLimited'],
    ['TRANSCRIPTION_TIMEOUT', 504, 'input.voice.errors.timeout'],
    ['TRANSCRIPTION_UNREACHABLE', 502, 'input.voice.errors.unreachable'],
    ['TRANSCRIPTION_FAILED', 502, 'input.voice.errors.transcriptionFailed'],
    ['UNSUPPORTED_AUDIO_TYPE', 415, 'input.voice.errors.unsupportedAudio'],
    ['EMPTY_AUDIO', 400, 'input.voice.errors.emptyAudio'],
  ];

  it.each(errorCases)('الرمز %s يُعرض رسالةً مفهومة لا رمزاً خاماً', async (code, status, key) => {
    transcribeResponse = jsonErr({ code, error: 'x' }, status);
    const onVoiceInsert = vi.fn();
    window.localStorage.setItem(voiceModeStorageKey(SCOPE), 'accurate');
    window.localStorage.setItem(voiceAccurateConsentStorageKey(SCOPE), 'granted');
    await renderComposer({ onVoiceInsert });

    fireEvent.click(accurateMic());
    await screen.findByText('input.voice.recording');
    act(() => FakeMediaRecorder.instances[0].emitData());
    fireEvent.click(screen.getByRole('button', { name: 'input.voice.stopAccurate' }));
    await act(async () => {});

    // مرّتان مقصودتان: نصّ مرئي بجانب الزرّ + إعلان في المنطقة الحيّة.
    expect(screen.getAllByText(key).length).toBeGreaterThan(0);
    expect(liveRegion().textContent).toBe(key);
    expect(onVoiceInsert).not.toHaveBeenCalled();
  });

  it('AUDIO_TOO_LARGE يحمل السقف في رسالته (رقمٌ يُرشد إلى تسجيل أقصر)', async () => {
    transcribeResponse = jsonErr({ code: 'AUDIO_TOO_LARGE', maxMb: 10 }, 413);
    window.localStorage.setItem(voiceModeStorageKey(SCOPE), 'accurate');
    window.localStorage.setItem(voiceAccurateConsentStorageKey(SCOPE), 'granted');
    await renderComposer();

    fireEvent.click(accurateMic());
    await screen.findByText('input.voice.recording');
    act(() => FakeMediaRecorder.instances[0].emitData());
    fireEvent.click(screen.getByRole('button', { name: 'input.voice.stopAccurate' }));
    await act(async () => {});

    expect(screen.getAllByText('input.voice.errors.tooLarge').length).toBeGreaterThan(0);
  });

  // ── تبديل الجلسة ─────────────────────────────────────────────────────────

  it('تبديل الجلسة يُلغي تسجيلاً جارياً بلا إدراج متأخّر', async () => {
    const onVoiceInsert = vi.fn();
    let resolveUpload: (value: unknown) => void = () => {};
    transcribeResponse = new Promise((resolve) => {
      resolveUpload = resolve;
    });
    window.localStorage.setItem(voiceModeStorageKey(SCOPE), 'accurate');
    window.localStorage.setItem(voiceAccurateConsentStorageKey(SCOPE), 'granted');
    const { rerender } = await renderComposer({ onVoiceInsert });

    fireEvent.click(accurateMic());
    await screen.findByText('input.voice.recording');
    act(() => FakeMediaRecorder.instances[0].emitData());

    rerender(<ChatComposer {...props({ onVoiceInsert, sessionId: 'session-b' })} />);

    expect(stream.tracks.every((track) => track.stopped)).toBe(true);
    expect(screen.queryByText('input.voice.recording')).toBeNull();

    // وحتى لو وصل جواب رفعٍ سبق الإلغاء: لا يُكتب في مسودّة المحادثة الجديدة.
    await act(async () => {
      resolveUpload({ ok: true, status: 200, json: async () => ({ text: 'متأخّر' }) });
    });
    expect(onVoiceInsert).not.toHaveBeenCalled();
  });
});

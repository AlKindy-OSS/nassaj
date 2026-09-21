/**
 * useVoiceDictation.test.ts — B-428 / T-1231
 *
 * الخطّاف يقود واجهة متصفّح لا تُحاكى بسهولة: كائن `SpeechRecognition` يُطلق
 * أحداثه من خارج React، ويعيش أطول من النسخة التي أنشأته. لذلك تُثبَّت هنا
 * المصائد التي كشفتها المراجعة النقدية لا «المسار السعيد» وحده:
 *
 *  1. `event.results` تراكمية مع continuous=true ⇒ القراءة من الصفر تُعيد إدراج
 *     كل ما قيل منذ بدء الجلسة. المطلوب: كل مقطع يُدرَج مرّة واحدة.
 *  2. `stop()` يدوي ⇒ `onend` بعده لا يُعيد التشغيل (وإلا صار الزرّ بلا مفعول).
 *  3. خطأ قابل للإصلاح (network) ⇒ إعادة تشغيل بتراجع أُسّي وسقف محاولات،
 *     ثم توقّف صريح بـ`restart-exhausted` — لا حلقة تحرق المعالج بصمت.
 *  4. خطأ لا تُصلحه المحاولة (not-allowed) ⇒ توقّف فوري.
 *  5. النسخة الزومبي: بدء جديد أثناء الاستماع يجب أن يفصل مستمعات القديمة
 *     ويُجهضها، و`onend` المتأخّر منها لا يمسّ الحالة.
 *  6. فكّ التركيب أثناء الاستماع ⇒ إجهاض، ولا مؤقّت ناجٍ يُعيد التشغيل بعد الموت.
 *  7. سياق غير آمن ⇒ isSupported=false رغم وجود الباني (الزرّ يُخفى لا يُخدع).
 *  8. تطبيع اللغة ونموّ قائمة الخيارات.
 *  9. مفاتيح تخزين مُنطَّقة، وتخزين معطَّل (يُطلق استثناء) لا يُسقط الخطّاف.
 *
 * ثمّ عقد B-437 الذي غيّر معنى الحالتين (كل ما بعده مضاف بعد المراجعة الثانية):
 * 10. `isListening` = التقاط فعلي بين `onstart` والتوقّف، و`isStarting` = طلب
 *     قائم لم يلتقط بعد. لذلك لا يُرفع الاستماع بمجرّد `start()`، ولا في فجوة
 *     التراجع بين `onend` وإعادة التشغيل — الميكروفون متوقّف هناك حقاً.
 * 11. الصمت لا يستنزف السقف: `onstart` ناجح يُصفّر عدّاد المحاولات، فالسقف
 *     حارسٌ على فشل البدء المتكرّر وحده.
 * 12. `stopAndDiscard()` يفصل ويُجهض فلا تُدرَج نتيجة متأخّرة (تسرُّب إلى مسودّة
 *     محادثة أخرى)، بينما `stop()` اليدوي يظلّ يستقبلها.
 * 13. نطاق التخزين يصل متأخّراً ⇒ إعادة قراءة التفضيل عند تبدّله.
 *
 * وقسم «صائدات الطفرات» في الذيل: كل اختبار فيه يقابل تعديلاً بعينه في الخطّاف
 * بقيت الحزمة خضراء معه في المراجعة العدائية.
 *
 * Run: NODE_ENV=test npx vitest run src/components/chat/hooks/useVoiceDictation.test.ts
 */

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  normalizeVoiceLang,
  useVoiceDictation,
  voiceConsentStorageKey,
  voiceLangStorageKey,
  VOICE_LANGUAGE_OPTIONS,
} from './useVoiceDictation';

// ─── مزيّف SpeechRecognition ────────────────────────────────────────────────
// يسجّل الاستدعاءات ويترك إطلاق الأحداث بيد الاختبار: المتصفّح الحقيقي يُطلق
// onend/onerror متى شاء، وهذا بالضبط ما نريد محاكاته يدوياً.

type ResultEvent = {
  resultIndex: number;
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
};

class FakeSpeechRecognition {
  static instances: FakeSpeechRecognition[] = [];
  /** يجعل start() يُطلق استثناءً (المتصفّح يفعلها إن كان الالتقاط جارياً). */
  static startThrows = false;

  lang = '';
  continuous = false;
  interimResults = true;
  maxAlternatives = 0;

  startCalls = 0;
  stopCalls = 0;
  abortCalls = 0;

  onresult: ((event: ResultEvent) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  onstart: (() => void) | null = null;

  constructor() {
    FakeSpeechRecognition.instances.push(this);
  }

  start() {
    this.startCalls += 1;
    if (FakeSpeechRecognition.startThrows) throw new Error('already started');
  }
  stop() {
    this.stopCalls += 1;
  }
  abort() {
    this.abortCalls += 1;
  }

  // ── إطلاق يدوي للأحداث (يُطلق فقط ما لم يُفصل مستمعه) ──
  /**
   * `onstart` — الالتقاط الفعلي بدأ. المتصفّح لا يُطلقه عند `start()` بل حين
   * يفتح الميكروفون فعلاً، وقد لا يصل أبداً (إذن معلّق، محرّك معطوب، خدمة
   * غائبة). فصلُه عن `start()` هنا مقصود: هو الفرق بين «طلبنا الاستماع» و
   * «الميكروفون مفتوح»، وهو ما يفصله العقد بين `isStarting` و`isListening`.
   */
  emitStart() {
    this.onstart?.();
  }
  emitResult(event: ResultEvent) {
    this.onresult?.(event);
  }
  emitError(error: string) {
    this.onerror?.({ error });
  }
  emitEnd() {
    this.onend?.();
  }
}

/** حدث نتيجة نهائية بنتائج تراكمية: `all` كل المقاطع منذ بدء الجلسة. */
function finalResultEvent(resultIndex: number, all: string[]): ResultEvent {
  const results = all.map((transcript) => {
    const alternatives = [{ transcript }] as unknown as ArrayLike<{ transcript: string }> & {
      isFinal: boolean;
    };
    alternatives.isFinal = true;
    return alternatives;
  });
  return { resultIndex, results };
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

let originalGetItem: typeof Storage.prototype.getItem;
let originalSetItem: typeof Storage.prototype.setItem;

beforeEach(() => {
  FakeSpeechRecognition.instances = [];
  FakeSpeechRecognition.startThrows = false;
  (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition =
    FakeSpeechRecognition;
  setSecureContext(true);
  originalGetItem = Storage.prototype.getItem;
  originalSetItem = Storage.prototype.setItem;
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Storage.prototype.getItem = originalGetItem;
  Storage.prototype.setItem = originalSetItem;
  delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
  delete (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
  window.localStorage.clear();
  vi.restoreAllMocks();
});

function renderVoice(options?: Parameters<typeof useVoiceDictation>[1]) {
  const insert = vi.fn();
  const view = renderHook(() => useVoiceDictation(insert, options));
  return { insert, ...view };
}

/** يُعيد التركيب بنطاق تخزين متغيّر — المستخدم يصل بعد تركيب المُؤلِّف. */
function renderScopedVoice(initialScope: string | null | undefined) {
  const insert = vi.fn();
  const view = renderHook(
    ({ scope }: { scope: string | null | undefined }) =>
      useVoiceDictation(insert, { storageScope: scope }),
    { initialProps: { scope: initialScope } },
  );
  return { insert, ...view };
}

/**
 * بدء يصل إليه `onstart`، أي التقاط فعلي. كل توكيد على `isListening=true` يمرّ
 * من هنا: رفعُها على مجرّد استدعاء `start()` كان العيب الحرج (ميكروفون صامت
 * وواجهة تقول «يستمع»).
 */
function startAndCapture(result: { current: { start: () => void } }) {
  act(() => result.current.start());
  act(() => lastInstance().emitStart());
}

// ─── 1. النتائج التراكمية ────────────────────────────────────────────────────

describe('نتائج نهائية متتالية', () => {
  it('تُدرج كل مقطع مرّة واحدة رغم تراكم event.results', () => {
    const { insert, result } = renderVoice();
    act(() => result.current.start());
    const rec = lastInstance();

    act(() => rec.emitResult(finalResultEvent(0, ['مرحباً بك'])));
    act(() => rec.emitResult(finalResultEvent(1, ['مرحباً بك', ' في نسّاج'])));

    expect(insert).toHaveBeenCalledTimes(2);
    expect(insert.mock.calls.map((call) => call[0])).toEqual(['مرحباً بك', 'في نسّاج']);
  });

  it('يقرأ من resultIndex فلا يُعيد إدراج المقاطع السابقة في دفعة واحدة', () => {
    const { insert, result } = renderVoice();
    act(() => result.current.start());
    const rec = lastInstance();

    act(() => rec.emitResult(finalResultEvent(0, ['أ'])));
    // دفعة تحمل نتيجتين جديدتين معاً (resultIndex=1) وتُبقي القديمة في المصفوفة.
    act(() => rec.emitResult(finalResultEvent(1, ['أ', 'ب', 'ج'])));

    expect(insert.mock.calls.map((call) => call[0])).toEqual(['أ', 'بج']);
    expect(insert.mock.calls.some((call) => String(call[0]).startsWith('أ') && call[0] !== 'أ')).toBe(
      false,
    );
  });

  it('يُهيّئ النسخة بنتائج نهائية فقط واستماع مستمرّ باللغة المختارة', () => {
    const { result } = renderVoice();
    act(() => result.current.setLang('en-US'));
    startAndCapture(result);
    const rec = lastInstance();

    expect(rec.lang).toBe('en-US');
    // jsdom بلا بصمة `Version/x Safari/y` ⇒ المسار المستمرّ (سلوك كروم).
    expect(rec.continuous).toBe(true);
    expect(rec.interimResults).toBe(false);
    expect(rec.startCalls).toBe(1);
    expect(result.current.isListening).toBe(true);
    expect(result.current.isStarting).toBe(false);
  });
});

// ─── 2. الإيقاف اليدوي ───────────────────────────────────────────────────────

describe('stop() اليدوي', () => {
  it('يستدعي stop لا abort، ويُنهي الاستماع', () => {
    const onStateChange = vi.fn();
    const { result } = renderVoice({ onStateChange });
    startAndCapture(result);
    const rec = lastInstance();

    act(() => result.current.stop());

    expect(rec.stopCalls).toBe(1);
    expect(rec.abortCalls).toBe(0);
    expect(result.current.isListening).toBe(false);
    expect(onStateChange.mock.calls.map((call) => call[0])).toEqual([true, false]);
  });

  it('لا يُعيد التشغيل عند onend التالي للإيقاف', () => {
    vi.useFakeTimers();
    const { result } = renderVoice();
    startAndCapture(result);
    const rec = lastInstance();

    act(() => result.current.stop());
    act(() => rec.emitEnd());
    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    expect(rec.startCalls).toBe(1);
    expect(instances()).toHaveLength(1);
    expect(result.current.isListening).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('يُوصل نتيجة نهائية متأخّرة وصلت بعد stop()', () => {
    const { insert, result } = renderVoice();
    startAndCapture(result);
    const rec = lastInstance();

    act(() => result.current.stop());
    act(() => rec.emitResult(finalResultEvent(0, ['كلمة أخيرة'])));

    expect(insert).toHaveBeenCalledWith('كلمة أخيرة');
    // الإيقاف اللطيف لا يفصل المستمعات — لذلك وصلت.
    expect(rec.onresult).not.toBeNull();
    expect(rec.abortCalls).toBe(0);
  });

  // طفرة: حذف حارس `activeSessionRef` من `onstart`. المستخدم ألغى الاستماع قبل
  // أن يبتّ المتصفّح في إذن الميكروفون، ثمّ وصل الإذن ⇒ `onstart` متأخّر يجب
  // ألّا يُحيي جلسة ميّتة (ميكروفون يعمل بعد ضغطة إيقاف صريحة).
  it('onstart متأخّر بعد stop() لا يُعيد رفع isListening', () => {
    const { result } = renderVoice();
    act(() => result.current.start());
    const rec = lastInstance();

    act(() => result.current.stop());
    expect(result.current.isStarting).toBe(false);

    act(() => rec.emitStart());

    expect(result.current.isListening).toBe(false);
    expect(result.current.isStarting).toBe(false);
  });
});

// ─── 3. خطأ الشبكة: تراجع أُسّي ثم نفاد المحاولات ────────────────────────────

describe('خطأ network', () => {
  // ملاحظة عقد (B-437): هذا السيناريو **لا يصل فيه `onstart`** — كل إعادة تشغيل
  // تُستدعى ولا يفتح الميكروفون. لذلك `isListening` كاذبة طوال السلسلة و
  // `isStarting` وحدها قائمة: هذا هو السقف الذي يحرسه العدّاد بعد B-437 (فشل
  // بدء متكرّر)، لا صمت المتكلّم. التوكيد القديم `isListening===true` داخل هذه
  // الحلقة كان يصف العقد المعيب نفسه الذي أسقطته المراجعة.
  it('يُعيد التشغيل بتراجع أُسّي ثم يتوقّف بـrestart-exhausted بعد 5 محاولات', () => {
    vi.useFakeTimers();
    const { result } = renderVoice();
    startAndCapture(result);
    const rec = lastInstance();
    expect(rec.startCalls).toBe(1);

    // المحاولة الأولى فورية (بلا تأخير)، ثمّ التراجع الأُسّي للمحاولات التالية:
    // الثغرة الصامتة كانت تُفتَح على المسار الطبيعي لا على الفشل وحده.
    const expectedDelays = [0, 300, 600, 1200];
    expectedDelays.forEach((delay, index) => {
      act(() => rec.emitError('network'));
      act(() => rec.emitEnd());
      // الالتقاط توقّف فعلاً قبل أي إعادة تشغيل — لا تُعرض «يستمع» في الفجوة.
      expect(result.current.isListening).toBe(false);
      expect(result.current.isStarting).toBe(true);

      if (delay > 0) {
        // لا إعادة تشغيل قبل انقضاء التراجع المتوقَّع…
        act(() => {
          vi.advanceTimersByTime(delay - 1);
        });
        expect(rec.startCalls).toBe(index + 1);
      }

      // …وإعادة تشغيل واحدة عند انقضائه.
      act(() => {
        vi.advanceTimersByTime(delay > 0 ? 1 : 0);
      });
      expect(rec.startCalls).toBe(index + 2);
      // الخطأ القابل للتعافي لا يُعرض من أوّل مرّة: ومضة عطلٍ تُصلحه إعادة
      // التشغيل التالية تُقرأ انقطاعاً. يظهر عند تكراره.
      expect(result.current.error).toBe(index === 0 ? null : 'network');
      // `start()` نُفِّذ ولم يصل `onstart` ⇒ الطلب قائم والالتقاط لم يبدأ.
      expect(result.current.isListening).toBe(false);
      expect(result.current.isStarting).toBe(true);
    });

    // الخطأ الخامس على التوالي بلا نتيجة واحدة بينها: سقف سلسلة الأخطاء بُلغ
    // ⇒ توقّف صريح فور الخطأ، بلا انتظار onend وبلا إعادة تشغيل سادسة.
    act(() => rec.emitError('network'));
    act(() => rec.emitEnd());
    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(rec.startCalls).toBe(expectedDelays.length + 1); // 4 إعادات + البدء الأول
    expect(instances()).toHaveLength(1);
    expect(result.current.error).toBe('restart-exhausted');
    expect(result.current.isListening).toBe(false);
    expect(result.current.isStarting).toBe(false);
    // النفاد يُنهي النسخة عند المتصفّح أيضاً: بلا إجهاض يبقى مؤشّر الميكروفون
    // مضاءً بعد ما تعتبره الواجهة توقّفاً.
    expect(rec.abortCalls).toBe(1);
    expect(rec.onend).toBeNull();
    expect(rec.onresult).toBeNull();
  });

  // الانحدار الذي كشفه وكيل الاختبار بعد B-437: صار `onstart` يُصفّر عدّاد فشل
  // البدء، فمحرّك يفتح الالتقاط ثم يفشل شبكياً كان يدور بلا سقف كل 300ms.
  // العلاج عدّاد سلسلة أخطاء مستقلّ، يُصفَّر بنتيجة ناجحة وحدها.
  it('خطأ متكرّر رغم نجاح onstart في كل دورة ⇒ يتوقّف بالسقف لا يدور بلا نهاية', () => {
    vi.useFakeTimers();
    const { result } = renderVoice();
    startAndCapture(result);
    const rec = lastInstance();

    // أربع دورات كاملة: خطأ ⇒ انتهاء ⇒ إعادة تشغيل ناجحة (onstart يصل فعلاً).
    [300, 600, 1200, 2400].forEach((delay) => {
      act(() => rec.emitError('network'));
      act(() => rec.emitEnd());
      act(() => {
        vi.advanceTimersByTime(delay);
      });
      act(() => rec.emitStart());
      expect(result.current.isListening).toBe(true);
    });

    // الخامس يبلغ سقف سلسلة الأخطاء ⇒ توقّف صريح.
    act(() => rec.emitError('network'));
    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(result.current.error).toBe('restart-exhausted');
    expect(result.current.isListening).toBe(false);
    expect(result.current.isStarting).toBe(false);
    expect(rec.startCalls).toBe(5); // البدء الأول + أربع إعادات، لا خامسة
    expect(rec.abortCalls).toBe(1);
  });

  it('نتيجة ناجحة تُصفّر عدّاد المحاولات فلا يُستنزف السقف بجلسة سليمة', () => {
    vi.useFakeTimers();
    const { result } = renderVoice();
    startAndCapture(result);
    const rec = lastInstance();

    // محاولتان فاشلتان: الأولى فورية والثانية بعد 300ms ⇒ العدّاد = 2،
    // فالتالية بلا تصفير تنتظر 600ms.
    act(() => rec.emitEnd());
    act(() => vi.advanceTimersByTime(0));
    act(() => rec.emitEnd());
    act(() => vi.advanceTimersByTime(300));
    expect(rec.startCalls).toBe(3);

    // كلام مسموع ⇒ الجلسة سليمة ⇒ العودة إلى الدرجة الأولى: إعادة تشغيل فورية
    // لا بعد 600ms (وهو ما يُثبت التصفير لا مجرّد نضوج المؤقّت).
    act(() => rec.emitResult(finalResultEvent(0, ['كلام'])));
    act(() => rec.emitEnd());
    act(() => vi.advanceTimersByTime(0));
    expect(rec.startCalls).toBe(4);
    expect(result.current.error).toBeNull();
  });

  it('فشل start() أثناء إعادة التشغيل يُنهي الاستماع بـstart-failed', () => {
    vi.useFakeTimers();
    const { result } = renderVoice();
    startAndCapture(result);
    const rec = lastInstance();

    FakeSpeechRecognition.startThrows = true;
    act(() => rec.emitEnd());
    act(() => vi.advanceTimersByTime(300));

    expect(result.current.error).toBe('start-failed');
    expect(result.current.isListening).toBe(false);
    expect(result.current.isStarting).toBe(false);
  });
});

// ─── 3.ب عقد isStarting/isListening (B-437 §5) ──────────────────────────────

describe('isStarting مقابل isListening', () => {
  it('isStarting وحدها ترتفع عند start()، وisListening تنتظر onstart', () => {
    const { result } = renderVoice();

    act(() => result.current.start());
    // الطلب قائم والميكروفون لم يُفتح بعد (إذن معلّق مثلاً).
    expect(result.current.isStarting).toBe(true);
    expect(result.current.isListening).toBe(false);

    act(() => lastInstance().emitStart());
    expect(result.current.isStarting).toBe(false);
    expect(result.current.isListening).toBe(true);
  });

  it('في فجوة التراجع: isStarting قائمة وisListening كاذبة حتى onstart التالي', () => {
    vi.useFakeTimers();
    const { result } = renderVoice();
    startAndCapture(result);
    const rec = lastInstance();

    act(() => rec.emitEnd());
    // العيب الحرج الذي أسقطته المراجعة: الميكروفون متوقّف فعلاً هنا.
    expect(result.current.isListening).toBe(false);
    expect(result.current.isStarting).toBe(true);

    act(() => vi.advanceTimersByTime(300));
    expect(rec.startCalls).toBe(2);
    // حتى بعد استدعاء start(): الطلب أُرسل والالتقاط لم يبدأ بعد.
    expect(result.current.isListening).toBe(false);
    expect(result.current.isStarting).toBe(true);

    act(() => rec.emitStart());
    expect(result.current.isListening).toBe(true);
    expect(result.current.isStarting).toBe(false);
  });

  it('toggle يُلغي جلسة عالقة في isStarting لم يصلها onstart قط', () => {
    vi.useFakeTimers();
    const { result } = renderVoice();
    act(() => result.current.start());
    const rec = lastInstance();
    expect(result.current.isStarting).toBe(true);

    act(() => result.current.toggle());

    expect(rec.stopCalls).toBe(1);
    expect(result.current.isStarting).toBe(false);
    expect(result.current.isListening).toBe(false);
  });

  it('عشر دورات صمت تُنهيها onstart ناجحة لا تستنزف السقف', () => {
    vi.useFakeTimers();
    const { result } = renderVoice();
    startAndCapture(result);
    const rec = lastInstance();

    // Chrome يُنهي الالتقاط عند كل فترة صمت مع continuous=true. `onstart` الناجح
    // (لا النتيجة) هو ما يُصفّر العدّاد، فتبقى إعادة التشغيل عند الدرجة الأولى
    // (فورية) مهما طال الصمت — ولا يُبلَّغ `restart-exhausted` أبداً، ولا تُفتح
    // ثغرةُ 300ms التي كان يضيع فيها أوّل ما يُنطق بعد كل صمتة.
    for (let cycle = 0; cycle < 10; cycle++) {
      act(() => rec.emitError('no-speech'));
      act(() => rec.emitEnd());
      expect(result.current.isListening).toBe(false);
      expect(result.current.isStarting).toBe(true);

      act(() => vi.advanceTimersByTime(0));
      expect(rec.startCalls).toBe(cycle + 2);

      act(() => rec.emitStart());
      expect(result.current.isListening).toBe(true);
      expect(result.current.error).toBeNull();
    }

    act(() => vi.advanceTimersByTime(60_000));
    expect(result.current.error).toBeNull();
    expect(result.current.isListening).toBe(true);
    expect(instances()).toHaveLength(1);
    expect(rec.abortCalls).toBe(0);
  });

  it('بدء متكرّر لا يصل onstart أبداً يبلغ السقف وينتهي بخطأ ظاهر', () => {
    vi.useFakeTimers();
    const { result } = renderVoice();
    act(() => result.current.start());
    const rec = lastInstance();

    // ست دورات onend بلا onstart واحدة: المحرّك يُنهي كل محاولة قبل الالتقاط.
    for (let attempt = 0; attempt < 6; attempt++) {
      act(() => rec.emitEnd());
      act(() => vi.advanceTimersByTime(60_000));
    }

    expect(rec.startCalls).toBe(6); // البدء الأول + 5 إعادات، ثم توقّف
    expect(result.current.error).toBe('restart-exhausted');
    expect(result.current.isListening).toBe(false);
    expect(result.current.isStarting).toBe(false);
    expect(rec.abortCalls).toBe(1);
  });
});

// ─── 4. خطأ الإذن: لا إعادة محاولة ──────────────────────────────────────────

describe('أخطاء لا تُصلحها إعادة المحاولة', () => {
  it('not-allowed يوقف فوراً بلا إعادة تشغيل', () => {
    vi.useFakeTimers();
    const { result } = renderVoice();
    startAndCapture(result);
    const rec = lastInstance();

    act(() => rec.emitError('not-allowed'));
    expect(result.current.error).toBe('not-allowed');
    expect(result.current.isListening).toBe(false);
    expect(result.current.isStarting).toBe(false);

    act(() => rec.emitEnd());
    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(rec.startCalls).toBe(1);
    expect(instances()).toHaveLength(1);
    expect(result.current.error).toBe('not-allowed');
    expect(result.current.isListening).toBe(false);
  });

  it.each(['service-not-allowed', 'audio-capture', 'language-not-supported'])(
    '%s يوقف نهائياً كذلك',
    (code) => {
      vi.useFakeTimers();
      const { result } = renderVoice();
      startAndCapture(result);
      const rec = lastInstance();

      act(() => rec.emitError(code));
      act(() => rec.emitEnd());
      act(() => {
        vi.advanceTimersByTime(60_000);
      });

      expect(result.current.error).toBe(code);
      expect(result.current.isListening).toBe(false);
      expect(rec.startCalls).toBe(1);
    },
  );

  it('no-speech و aborted لا تُسجَّلان خطأً معروضاً', () => {
    vi.useFakeTimers();
    const { result } = renderVoice();
    startAndCapture(result);
    const rec = lastInstance();

    act(() => rec.emitError('no-speech'));
    expect(result.current.error).toBeNull();
    act(() => rec.emitError('aborted'));
    expect(result.current.error).toBeNull();
  });

  // طفرة: حذف `setError(null)` من `start()`. خطأ بائت من جلسة ماتت يبقى معروضاً
  // فوق زرّ يعمل — الـtooltip والنصّ الأحمر يقولان «مرفوض» والتفريغ جارٍ.
  it('بدء جديد يمحو خطأ الجلسة السابقة', () => {
    const { result } = renderVoice();
    startAndCapture(result);

    act(() => lastInstance().emitError('audio-capture'));
    expect(result.current.error).toBe('audio-capture');

    startAndCapture(result);

    expect(result.current.error).toBeNull();
    expect(result.current.isListening).toBe(true);
  });
});

// ─── 5. النسخة الزومبي ──────────────────────────────────────────────────────

describe('بدء جديد أثناء الاستماع', () => {
  it('يفصل مستمعات النسخة القديمة ويُجهضها', () => {
    const { result } = renderVoice();
    startAndCapture(result);
    const first = lastInstance();

    startAndCapture(result);
    const second = lastInstance();

    expect(instances()).toHaveLength(2);
    expect(second).not.toBe(first);
    expect(first.abortCalls).toBe(1);
    expect(first.onresult).toBeNull();
    expect(first.onerror).toBeNull();
    expect(first.onend).toBeNull();
    expect(first.onstart).toBeNull();
    expect(result.current.isListening).toBe(true);
  });

  it('onend متأخّر من النسخة المُجهضة لا يُعيد التشغيل ولا يمسّ الحالة', () => {
    vi.useFakeTimers();
    const { insert, result } = renderVoice();
    startAndCapture(result);
    const first = lastInstance();
    // نلتقط المستمعات قبل الفصل: المتصفّح يحتفظ بها في رحلة الحدث الجارية.
    const zombieEnd = first.onend!;
    const zombieResult = first.onresult!;

    startAndCapture(result);
    const second = lastInstance();

    act(() => zombieEnd());
    act(() => zombieResult(finalResultEvent(0, ['نصّ زومبي'])));
    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(insert).not.toHaveBeenCalled();
    expect(instances()).toHaveLength(2);
    expect(second.startCalls).toBe(1);
    expect(result.current.isListening).toBe(true);
    expect(result.current.error).toBeNull();
  });

  // طفرة: حذف حارس النسخة (`sessionCounterRef !== sessionId`) من `onerror`.
  // خطأ متأخّر من نسخة مُجهضة كان يُطفئ جلسة حيّة ويعرض خطأً كاذباً.
  it('onerror متأخّر من النسخة المُجهضة لا يُطفئ الجلسة الحيّة', () => {
    vi.useFakeTimers();
    const { result } = renderVoice();
    startAndCapture(result);
    const first = lastInstance();
    const zombieError = first.onerror!;

    startAndCapture(result);
    const second = lastInstance();

    act(() => zombieError({ error: 'not-allowed' }));
    act(() => vi.advanceTimersByTime(60_000));

    expect(result.current.error).toBeNull();
    expect(result.current.isListening).toBe(true);
    expect(second.abortCalls).toBe(0);
    expect(second.onresult).not.toBeNull();
  });

  it('النسخة الحيّة وحدها تُدرج النصّ بعد استبدال سابقتها', () => {
    const { insert, result } = renderVoice();
    startAndCapture(result);
    startAndCapture(result);
    const second = lastInstance();

    act(() => second.emitResult(finalResultEvent(0, ['نصّ حيّ'])));

    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith('نصّ حيّ');
  });
});

// ─── 6. فكّ التركيب ─────────────────────────────────────────────────────────

describe('فكّ التركيب أثناء الاستماع', () => {
  it('يُجهض النسخة الحيّة', () => {
    const { result, unmount } = renderVoice();
    startAndCapture(result);
    const rec = lastInstance();

    unmount();

    expect(rec.abortCalls).toBe(1);
    expect(rec.onend).toBeNull();
    expect(rec.onresult).toBeNull();
    expect(rec.onerror).toBeNull();
    // طفرة: `detachAndAbort` لا يُصفّر `onstart` ⇒ نسخة ميتة تُبلّغ بدء التقاط
    // بعد فكّ التركيب فتكتب في حالة مكوّن زال.
    expect(rec.onstart).toBeNull();
  });

  it('لا يترك مؤقّتاً يُعيد التشغيل بعد الموت', () => {
    vi.useFakeTimers();
    const { result, unmount } = renderVoice();
    startAndCapture(result);
    const rec = lastInstance();

    // مؤقّت إعادة تشغيل معلّق وقت فكّ التركيب — أخطر لحظة ممكنة.
    act(() => rec.emitEnd());
    unmount();
    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(rec.startCalls).toBe(1);
    expect(instances()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  // طفرة: التنظيف لا يُصفّر `activeSessionRef`. مستمع نجا في رحلة حدث جارية
  // (المتصفّح يحمل المرجع لا الخطّاف) يجد الجلسة «حيّة» بعد الموت فيجدول إعادة
  // تشغيل ويفتح الميكروفون على مكوّن غير موجود.
  it('onend ناجٍ بعد فكّ التركيب لا يجدول إعادة تشغيل', () => {
    vi.useFakeTimers();
    const { result, unmount } = renderVoice();
    startAndCapture(result);
    const rec = lastInstance();
    const survivingEnd = rec.onend!;

    unmount();
    act(() => survivingEnd());
    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(rec.startCalls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(instances()).toHaveLength(1);
  });
});

// ─── 6.ب الإيقاف القاطع stopAndDiscard ──────────────────────────────────────

describe('stopAndDiscard()', () => {
  it('يفصل المستمعات ويُجهض بدل الإيقاف اللطيف', () => {
    const onStateChange = vi.fn();
    const { result } = renderVoice({ onStateChange });
    startAndCapture(result);
    const rec = lastInstance();

    act(() => result.current.stopAndDiscard());

    expect(rec.abortCalls).toBe(1);
    expect(rec.stopCalls).toBe(0);
    expect(rec.onresult).toBeNull();
    expect(rec.onerror).toBeNull();
    expect(rec.onend).toBeNull();
    expect(rec.onstart).toBeNull();
    expect(result.current.isListening).toBe(false);
    expect(result.current.isStarting).toBe(false);
    expect(onStateChange.mock.calls.map((call) => call[0])).toEqual([true, false]);
  });

  it('نتيجة نهائية متأخّرة بعده لا تُدرَج — وهي تُدرَج بعد stop() اليدوي', () => {
    // جوهر B-437 §3: تبديل الجلسة يُبقي المكوّن مركَّباً ويُبدّل وجهة الإدراج،
    // فالمقطع المعلّق من المحادثة الأولى يُكتب في مسودّة الثانية. الإيقاف القاطع
    // يمنعه، واللطيف (زرّ المستخدم) يجب أن يظلّ يستقبله.
    const discarded = renderVoice();
    startAndCapture(discarded.result);
    const discardedRec = lastInstance();
    // المتصفّح يحتفظ بالمستمع في رحلة الحدث الجارية رغم تصفيرنا للخاصية.
    const pendingResult = discardedRec.onresult!;

    act(() => discarded.result.current.stopAndDiscard());
    act(() => pendingResult(finalResultEvent(0, ['تسرّب إلى محادثة أخرى'])));

    expect(discarded.insert).not.toHaveBeenCalled();
    discarded.unmount();

    const gentle = renderVoice();
    startAndCapture(gentle.result);
    const gentleRec = lastInstance();
    const gentlePending = gentleRec.onresult!;

    act(() => gentle.result.current.stop());
    act(() => gentlePending(finalResultEvent(0, ['مقطع أخير مشروع'])));

    expect(gentle.insert).toHaveBeenCalledTimes(1);
    expect(gentle.insert).toHaveBeenCalledWith('مقطع أخير مشروع');
  });

  it('لا يُعيد التشغيل ولا يترك مؤقّتاً بعده', () => {
    vi.useFakeTimers();
    const { result } = renderVoice();
    startAndCapture(result);
    const rec = lastInstance();
    const survivingEnd = rec.onend!;

    act(() => rec.emitEnd()); // مؤقّت إعادة تشغيل معلّق…
    act(() => result.current.stopAndDiscard());
    expect(vi.getTimerCount()).toBe(0);

    act(() => survivingEnd());
    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(rec.startCalls).toBe(1);
    expect(instances()).toHaveLength(1);
    expect(result.current.isListening).toBe(false);
  });
});

// ─── 7. الدعم والسياق الآمن ─────────────────────────────────────────────────

describe('isSupported', () => {
  it('يصير false في سياق غير آمن رغم وجود الباني', () => {
    setSecureContext(false);
    const { result } = renderVoice();
    expect(result.current.isSupported).toBe(false);
  });

  it('start() في سياق غير آمن يُسجّل unsupported ولا يُنشئ نسخة', () => {
    setSecureContext(false);
    const { result } = renderVoice();
    act(() => result.current.start());

    expect(result.current.error).toBe('unsupported');
    expect(instances()).toHaveLength(0);
    expect(result.current.isListening).toBe(false);
  });

  it('يصير false حين لا باني أصلاً', () => {
    delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
    const { result } = renderVoice();
    expect(result.current.isSupported).toBe(false);
  });

  it('يقبل باني webkit المُبادئ', () => {
    delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
    (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition =
      FakeSpeechRecognition;
    const { result } = renderVoice();
    expect(result.current.isSupported).toBe(true);
  });
});

// ─── 8. تطبيع اللغة وخياراتها ───────────────────────────────────────────────

describe('normalizeVoiceLang', () => {
  it('يُطابق تماماً بلا حساسية حالة', () => {
    expect(normalizeVoiceLang('ar-SA')).toBe('ar-SA');
    expect(normalizeVoiceLang('EN-us')).toBe('en-US');
  });

  it('يُطابق بادئة اللغة', () => {
    expect(normalizeVoiceLang('ar-EG')).toBe('ar-SA');
    expect(normalizeVoiceLang('ar')).toBe('ar-SA');
    expect(normalizeVoiceLang('fr-CA')).toBe('fr-FR');
  });

  it('يُبقي غير المطابق كما هو بدل إسقاطه صامتاً', () => {
    expect(normalizeVoiceLang('ja-JP')).toBe('ja-JP');
    expect(normalizeVoiceLang('zz')).toBe('zz');
  });

  it('يعود إلى ar-SA عند الفراغ أو العدم', () => {
    expect(normalizeVoiceLang('')).toBe('ar-SA');
    expect(normalizeVoiceLang('   ')).toBe('ar-SA');
    expect(normalizeVoiceLang(null)).toBe('ar-SA');
    expect(normalizeVoiceLang(undefined)).toBe('ar-SA');
  });
});

describe('languageOptions', () => {
  it('تبقى القائمة الأساسية حين تكون اللغة منها', () => {
    window.localStorage.setItem(voiceLangStorageKey(), 'en-US');
    const { result } = renderVoice();
    expect(result.current.lang).toBe('en-US');
    expect(result.current.languageOptions).toEqual([...VOICE_LANGUAGE_OPTIONS]);
  });

  it('تُضاف اللغة غير المطابقة في صدر القائمة', () => {
    window.localStorage.setItem(voiceLangStorageKey(), 'ja-JP');
    const { result } = renderVoice();
    expect(result.current.lang).toBe('ja-JP');
    expect(result.current.languageOptions).toEqual(['ja-JP', ...VOICE_LANGUAGE_OPTIONS]);
  });
});

// ─── 9. مفاتيح التخزين المُنطَّقة ────────────────────────────────────────────

describe('مفاتيح التخزين', () => {
  it('النطاق يغيّر المفتاح، وغيابه يُبقي الأساس', () => {
    expect(voiceLangStorageKey()).toBe('nassaj:voice:lang:v1');
    expect(voiceLangStorageKey(null)).toBe('nassaj:voice:lang:v1');
    expect(voiceLangStorageKey('7')).toBe('nassaj:voice:lang:v1:7');
    expect(voiceConsentStorageKey()).toBe('nassaj:voice:consent:v1');
    expect(voiceConsentStorageKey('7')).toBe('nassaj:voice:consent:v1:7');
    expect(voiceLangStorageKey('7')).not.toBe(voiceConsentStorageKey('7'));
  });

  it('تفضيل مستخدم لا يُقرأ لمستخدم آخر على الجهاز نفسه', () => {
    window.localStorage.setItem(voiceLangStorageKey('7'), 'fr-FR');
    const scoped = renderVoice({ storageScope: '7' });
    expect(scoped.result.current.lang).toBe('fr-FR');
    scoped.unmount();

    const other = renderVoice({ storageScope: '9' });
    expect(other.result.current.lang).not.toBe('fr-FR');
  });

  it('setLang يكتب في المفتاح المُنطَّق وحده', () => {
    const { result } = renderVoice({ storageScope: '7' });
    act(() => result.current.setLang('tr-TR'));

    expect(window.localStorage.getItem(voiceLangStorageKey('7'))).toBe('tr-TR');
    expect(window.localStorage.getItem(voiceLangStorageKey())).toBeNull();
    expect(result.current.lang).toBe('tr-TR');
  });

  it('لا ينهار حين يُطلق localStorage استثناءً قراءةً وكتابةً', () => {
    Storage.prototype.getItem = vi.fn(() => {
      throw new Error('storage disabled');
    });
    Storage.prototype.setItem = vi.fn(() => {
      throw new Error('storage disabled');
    });

    const { result } = renderVoice({ storageScope: '7' });
    expect(result.current.lang).toBe(normalizeVoiceLang(navigator.language));

    expect(() => act(() => result.current.setLang('de-DE'))).not.toThrow();
    expect(result.current.lang).toBe('de-DE');
  });
});

// ─── toggle واستئناف اللغة أثناء الاستماع ───────────────────────────────────

describe('toggle', () => {
  it('يبدأ ثم يوقف تبادلياً', () => {
    const { result } = renderVoice();
    act(() => result.current.toggle());
    act(() => lastInstance().emitStart());
    expect(result.current.isListening).toBe(true);
    act(() => result.current.toggle());
    expect(result.current.isListening).toBe(false);
    expect(lastInstance().stopCalls).toBe(1);
  });

  it('تغيير اللغة أثناء الاستماع يُعيد التشغيل بنسخة تحمل اللغة الجديدة', () => {
    const { result } = renderVoice();
    startAndCapture(result);
    expect(lastInstance().lang).toBe(normalizeVoiceLang(navigator.language));

    act(() => result.current.setLang('fa-IR'));
    act(() => lastInstance().emitStart());

    expect(instances()).toHaveLength(2);
    expect(lastInstance().lang).toBe('fa-IR');
    expect(instances()[0].abortCalls).toBe(1);
    expect(result.current.isListening).toBe(true);
  });

  it('تغيير اللغة بلا استماع لا يُنشئ نسخة', () => {
    const { result } = renderVoice();
    act(() => result.current.setLang('ur-PK'));
    expect(instances()).toHaveLength(0);
    expect(result.current.isListening).toBe(false);
  });
});

// ─── 10. تبدّل نطاق التخزين بعد التركيب (B-437 §5) ──────────────────────────

describe('تبدّل storageScope', () => {
  it('يُعيد قراءة التفضيل حين يصل المستخدم متأخّراً بعد التركيب', () => {
    window.localStorage.setItem(voiceLangStorageKey('9'), 'tr-TR');
    // هوية المستخدم تُحمَّل بعد تركيب المُؤلِّف: أول رندر بلا نطاق.
    const { result, rerender } = renderScopedVoice(null);
    expect(result.current.lang).toBe(normalizeVoiceLang(navigator.language));

    rerender({ scope: '9' });

    expect(result.current.lang).toBe('tr-TR');
  });

  it('يُطبّع المخزَّن عند إعادة القراءة', () => {
    window.localStorage.setItem(voiceLangStorageKey('9'), 'ar-EG');
    const { result, rerender } = renderScopedVoice(null);
    rerender({ scope: '9' });
    expect(result.current.lang).toBe('ar-SA');
  });

  it('يحترم الاختيار الحالي حين لا تفضيل محفوظاً للنطاق الجديد', () => {
    const { result, rerender } = renderScopedVoice(null);
    act(() => result.current.setLang('de-DE'));

    rerender({ scope: '9' });

    expect(result.current.lang).toBe('de-DE');
    // ولا يُنسخ تفضيل النطاق القديم إلى مفتاح الجديد بلا اختيار صريح.
    expect(window.localStorage.getItem(voiceLangStorageKey('9'))).toBeNull();
  });

  it('رندر بلا تبدّل نطاق لا يُلغي اختياراً يدوياً يخالف المخزَّن', () => {
    window.localStorage.setItem(voiceLangStorageKey('9'), 'tr-TR');
    const { result, rerender } = renderScopedVoice('9');
    expect(result.current.lang).toBe('tr-TR');

    act(() => result.current.setLang('fr-FR'));
    rerender({ scope: '9' });

    expect(result.current.lang).toBe('fr-FR');
  });

  it('تبدّل النطاق أثناء الاستماع لا يُنشئ نسخة بنفسه', () => {
    window.localStorage.setItem(voiceLangStorageKey('9'), normalizeVoiceLang(navigator.language));
    const { result, rerender } = renderScopedVoice(null);
    startAndCapture(result);

    rerender({ scope: '9' });

    // اللغة لم تتغيّر فعلياً ⇒ لا إعادة تشغيل (إعادة التشغيل مربوطة باللغة وحدها).
    expect(instances()).toHaveLength(1);
    expect(result.current.isListening).toBe(true);
  });
});

// ─── 11. صائدات الطفرات ─────────────────────────────────────────────────────
// كل اختبار هنا يقابل تعديلاً بعينه في كود الخطّاف بقي الاختبار أخضر معه في
// المراجعة العدائية. مكتوب بالسلوك المرصود لا بالتنفيذ: التوكيد يصف ما يراه
// المستخدم (متى يُعاد التشغيل، ماذا يُعرض، متى يعمل الميكروفون).

describe('صائدات الطفرات', () => {
  it('بدء يدوي يُصفّر عدّاد المحاولات فيعود التراجع إلى درجته الأولى', () => {
    // طفرة: حذف `restartAttemptsRef.current = 0` من `start()`. جلسة جديدة كانت
    // ترث تراجع الجلسة الفاشلة قبلها فتنتظر ثوانيَ قبل أول إعادة تشغيل، وتستنفد
    // سقفاً لم تستهلكه.
    vi.useFakeTimers();
    const { result } = renderVoice();
    act(() => result.current.start());
    const first = lastInstance();

    // محاولتان فاشلتان (بلا onstart) ⇒ العدّاد = 2 والتالي 600ms.
    act(() => first.emitEnd());
    act(() => vi.advanceTimersByTime(0));
    act(() => first.emitEnd());
    act(() => vi.advanceTimersByTime(300));
    expect(first.startCalls).toBe(3);

    // بدء يدوي جديد **بلا** المرور بـstop() (الذي يُصفّر العدّاد بنفسه).
    act(() => result.current.start());
    const second = lastInstance();
    expect(second).not.toBe(first);

    act(() => second.emitEnd());
    act(() => vi.advanceTimersByTime(0));
    expect(second.startCalls).toBe(2); // الدرجة الأولى (فوري) لا 600ms
  });

  it('stop() يُلغي مؤقّت إعادة التشغيل المعلّق لا يتركه ينضج', () => {
    // طفرة: حذف `clearRestartTimer()` من `endSession`. الحارس يمنع أثر المؤقّت
    // فيبقى الاختبار أخضر، لكنّ مؤقّتاً معلّقاً بعد إيقاف صريح تسريبٌ يبقى حيّاً
    // إلى ما بعد الإيقاف (و`vi.getTimerCount` هو ما يراه لأنّ الأثر مكتوم).
    vi.useFakeTimers();
    const { result } = renderVoice();
    startAndCapture(result);
    const rec = lastInstance();

    act(() => rec.emitEnd());
    expect(vi.getTimerCount()).toBe(1);

    act(() => result.current.stop());

    expect(vi.getTimerCount()).toBe(0);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(rec.startCalls).toBe(1);
  });

  it('البدء بعد سلسلة فاشلة يمحو restart-exhausted ويستأنف من جديد', () => {
    // يجمع طفرتين: `setError(null)` عند البدء، وتصفير العدّاد عنده.
    vi.useFakeTimers();
    const { result } = renderVoice();
    act(() => result.current.start());
    const first = lastInstance();
    for (let attempt = 0; attempt < 6; attempt++) {
      act(() => first.emitEnd());
      act(() => vi.advanceTimersByTime(60_000));
    }
    expect(result.current.error).toBe('restart-exhausted');

    startAndCapture(result);

    expect(result.current.error).toBeNull();
    expect(result.current.isListening).toBe(true);
    expect(lastInstance()).not.toBe(first);
  });

  it('عدّاد المحاولات يُصفَّر بـonstart وحده لا بمرور الوقت', () => {
    // طفرة: تصفير العدّاد في `onend` أو عند جدولة المؤقّت — عندها لا يُبلَغ
    // السقف أبداً وتعود حلقة إعادة التشغيل اللانهائية التي أسقطها B-428 §3.
    vi.useFakeTimers();
    const { result } = renderVoice();
    act(() => result.current.start());
    const rec = lastInstance();

    for (let attempt = 0; attempt < 5; attempt++) {
      act(() => rec.emitEnd());
      act(() => vi.advanceTimersByTime(60_000));
    }
    expect(rec.startCalls).toBe(6);
    expect(result.current.error).toBeNull();

    act(() => rec.emitEnd());
    act(() => vi.advanceTimersByTime(60_000));

    expect(rec.startCalls).toBe(6); // السقف بُلغ فعلاً
    expect(result.current.error).toBe('restart-exhausted');
  });
});


// ─── WebKit: النطق الواحد بدل الاستمرار المعطوب ────────────────────────────
//
// `continuous = true` معطوبٌ موثَّقاً في محرّك آبل (تكرار المقطع، سقوط كلمات،
// ميكروفونٌ لا يتوقّف). فالعقد أن نطلب منه نطقاً واحداً ونتولّى الاستمرارية
// بحلقة إعادة التشغيل — وهي نفسها حلقة أندرويد أحادي النطق.

describe('WebKit — نطق واحد لا استمرار', () => {
  const setUserAgent = (value: string) => {
    Object.defineProperty(navigator, 'userAgent', { value, configurable: true });
  };
  const setTouchPoints = (value: number) => {
    Object.defineProperty(navigator, 'maxTouchPoints', { value, configurable: true });
  };
  const originalUA = navigator.userAgent;
  const originalTouch = navigator.maxTouchPoints;

  afterEach(() => {
    setUserAgent(originalUA);
    setTouchPoints(originalTouch);
  });

  it('آيفون/آيباد ⇒ continuous=false، والحلقة تُبقي الاستماع حيّاً', () => {
    vi.useFakeTimers();
    setUserAgent(
      'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    );
    const { result } = renderVoice();
    startAndCapture(result);
    const rec = lastInstance();

    expect(rec.continuous).toBe(false);

    // نطقٌ واحد انتهى ⇒ إعادة تشغيل فورية على النسخة نفسها، فلا ينقطع الإملاء.
    act(() => rec.emitEnd());
    act(() => vi.advanceTimersByTime(0));
    expect(rec.startCalls).toBe(2);
    act(() => rec.emitStart());
    expect(result.current.isListening).toBe(true);
  });

  it('iPadOS المنتحل هوية macOS يُكشَف باللمس لا بالاسم', () => {
    setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
    );
    setTouchPoints(5);
    const { result } = renderVoice();
    startAndCapture(result);
    expect(lastInstance().continuous).toBe(false);
  });

  it('jsdom نفسه لا يُقرأ سفاري رغم حمله AppleWebKit', () => {
    // طفرة: شرطٌ يكتفي بـ`AppleWebKit` يقلب كل اختبارات الحزمة إلى مسار
    // سفاري بلا سفاري — وقد وقع فعلاً قبل تشديد البصمة.
    const { result } = renderVoice();
    startAndCapture(result);
    expect(lastInstance().continuous).toBe(true);
  });

  it('كروم على سطح المكتب يبقى على المسار المستمرّ', () => {
    setUserAgent(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    );
    setTouchPoints(0);
    const { result } = renderVoice();
    startAndCapture(result);
    expect(lastInstance().continuous).toBe(true);
  });
});

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * useVoiceDictation — تفريغ صوتي للإدخال عبر واجهة Web Speech الأصليّة (ADR-097).
 *
 * لماذا Web Speech دون غيرها: نسّاج OSS يُشغَّل ذاتياً؛ هذه الواجهة بلا
 * تبعية ولا كلفة ولا أسرار، فتعمل فوراً لكلّ مُشغّل. مسار Whisper الأدقّ
 * مؤجَّل لمرحلة لاحقة (§3 ADR-097).
 *
 * قيود محفوظة عمداً في الـMVP:
 *   • نتائج نهائية فقط (لا interim): النصّ المتدفّق داخل حقل له طبقة مرآة
 *     mentions ومُكتشف أوامر «/» قد يُفعّل كشفاً مزيفاً. الإدراج عند المؤشّر
 *     بالنمط نفسه لإدراج @file.
 *   • اللغة الافتراضية = navigator.language مُطبَّعة إلى أقرب خيار مدعوم
 *     (ar → ar-SA)، ولو لم تطابق بقيت كما اكتُشفت وأُضيفت خياراً. لا تُصلب ar-SA.
 *   • تدهور لطيف: isSupported=false يُخفي الزرّ لا أن يتعطّل بصمت. ويشترط
 *     سياقاً آمناً (isSecureContext) لأنّ getUserMedia خلف الواجهة يرفض
 *     صامتاً على http، فيبدو الزرّ عاملاً وهو ميّت.
 *   • الإفصاح لمرة واحدة (يُدار في المكوّن، لا هنا) قبل أوّل تفريغ، لأنّ
 *     محرّك Chromium يُرسل الصوت إلى خوادم Google.
 *
 * ثلاث مصائد عالجتها مراجعة B-428 وتُفسّر بنية الحرّاس أدناه:
 *   1. `event.results` تراكمية مع continuous=true ⇒ الحلقة تبدأ من
 *      `event.resultIndex` وإلا أُعيد إدراج كل ما قيل منذ بدء الجلسة.
 *   2. النسخة الزومبي: `abort()` لا يفصل المستمعات، والمستمع القديم يظلّ يكتب
 *      في حالة الخطّاف بعد بدء نسخة جديدة ⇒ نُصفّر المستمعات قبل الإجهاض،
 *      وكل مستمع محروس بمعرّف نسخته (`sessionId`) لا براية مشتركة.
 *   3. حلقة إعادة التشغيل: `onend` كان يُعيد `start()` بلا سقف ⇒ عدّاد محاولات
 *      وتراجع أُسّي وتوقّف نهائي بخطأ ظاهر.
 *
 * مصيدتان أضافتهما المراجعة الثانية (B-437):
 *   4. الصمت لا يستنزف عدّاد المحاولات: `no-speech` يُنهي الالتقاط عند كل فترة
 *      صمت في Chrome، وإعادة تشغيل **ناجحة** تُطلق `onstart` — فهو (لا النتيجة
 *      الناجحة وحدها) مصدر الحقيقة الذي يُصفّر العدّاد. هكذا يبقى العدّاد حارساً
 *      على فشل البدء المتكرّر وحده لا على المتكلّم الصامت لحظة.
 *   5. `isListening` لا يكذب: يصير true عند `onstart` (الالتقاط الفعلي) لا عند
 *      استدعاء `start()`، ويعود false فور التوقّف الفعلي. الاستجابة البصرية
 *      الفورية للزرّ مسؤولية `isStarting` (طلب استماع قائم لم يلتقط بعد).
 *
 * @param insertAtCursor  يُدرج النصّ النهائي عند مؤشّر الـtextarea (يملكه المكوّن).
 * @param options.onStateChange  اختياري — يُستدعى عند بدء/إيقاف جلسة الاستماع
 *                               (مستوى الجلسة لا مستوى الالتقاط، فلا يرفرف مع
 *                               إعادات التشغيل القصيرة بين فترات الصمت).
 * @param options.storageScope   اختياري — لاحقة نطاق مفاتيح التخزين (معرّف المستخدم).
 */
export type VoiceDictationErrorCode =
  | 'unsupported'
  | 'not-allowed'
  | 'service-not-allowed'
  | 'network'
  | 'audio-capture'
  | 'language-not-supported'
  | 'start-failed'
  | 'restart-exhausted'
  | (string & {});

export interface UseVoiceDictationResult {
  isSupported: boolean;
  /** التقاط جارٍ فعلاً (بين `onstart` والتوقّف الفعلي) — لا نيّة الاستماع. */
  isListening: boolean;
  /**
   * طلب استماع قائم لم يبدأ الالتقاط بعد: انتظار إذن الميكروفون، أو الفجوة
   * القصيرة بين توقّف الالتقاط وإعادة تشغيله. الزرّ يستجيب بصرياً بهذه لا
   * بـ`isListening` — فلا تُعرض «يستمع» والميكروفون صامت.
   */
  isStarting: boolean;
  lang: string;
  setLang: (lang: string) => void;
  /** خيارات اللغة المعروضة — القائمة الأساسية + اللغة المكتشفة إن لم تطابق. */
  languageOptions: string[];
  error: VoiceDictationErrorCode | null;
  start: () => void;
  /** إيقاف لطيف: يُبقي المستمعات كي تصل النتيجة النهائية المعلّقة. */
  stop: () => void;
  /**
   * إيقاف قاطع: يفصل المستمعات ويُجهض، فلا نتيجة متأخّرة تُدرَج بعده. يُستعمل
   * حين يتغيّر وجهة الإدراج نفسها (تبديل الجلسة) — النتيجة المعلّقة هناك ليست
   * «متأخّرة» بل تسرّب إلى مسودّة محادثة أخرى.
   */
  stopAndDiscard: () => void;
  toggle: () => void;
}

export interface UseVoiceDictationOptions {
  onStateChange?: (listening: boolean) => void;
  /**
   * لاحقة نطاق لمفاتيح التخزين (معرّف المستخدم عادةً). جهاز واحد قد يستضيف
   * أكثر من حساب في نسّاج، فتفضيل لغة أحدهم لا يُملى على الآخر.
   */
  storageScope?: string | null;
}

/** مفاتيح مُنطَّقة ومُنسَّخة (B-428): بادئة المنتَج + المجال + رقم النسخة. */
const LANG_STORAGE_KEY_BASE = 'nassaj:voice:lang:v1';

export function voiceLangStorageKey(scope?: string | null): string {
  return scope ? `${LANG_STORAGE_KEY_BASE}:${scope}` : LANG_STORAGE_KEY_BASE;
}

/** المفتاح المقابل للإفصاح — يستهلكه المكوّن (النافذة تعيش في طبقة العرض). */
const CONSENT_STORAGE_KEY_BASE = 'nassaj:voice:consent:v1';

export function voiceConsentStorageKey(scope?: string | null): string {
  return scope ? `${CONSENT_STORAGE_KEY_BASE}:${scope}` : CONSENT_STORAGE_KEY_BASE;
}

/** لغات التفريغ المعروضة في المنتقي. القائمة تقريبية لا حصرية. */
export const VOICE_LANGUAGE_OPTIONS = [
  'ar-SA',
  'en-US',
  'fr-FR',
  'es-ES',
  'de-DE',
  'tr-TR',
  'ur-PK',
  'fa-IR',
] as const;

const RESTART_MAX_ATTEMPTS = 5;
const RESTART_BASE_DELAY_MS = 300;
/**
 * B-4xx: المحاولة الأولى بلا تأخير. Chrome يُنهي الالتقاط عند كل فترة صمت،
 * فتأخيرُ 300ms كان يُطبَّق على المسار **الطبيعي** لا على الفشل: كل صمتة تفتح
 * ثغرةً يضيع فيها أوّل ما يُنطق بعدها — وهو ما يظهر للمستخدم «فصلاً عشوائياً
 * ثمّ عودة». التراجع الأُسّي يبقى كما هو للمحاولات التالية، أي لفشل البدء
 * المتكرّر وحده (العدّاد يُصفَّر عند `onstart`).
 */
const RESTART_FIRST_DELAY_MS = 0;
/**
 * لا يُعرض خطأ قابل للتعافي من أوّل مرّة: `network` عابرة تُصلحها إعادة تشغيل
 * واحدة، وإظهارها فوراً يرسم عطلاً لا يعيشه المستخدم. تُعرض عند تكرارها.
 */
const ERROR_DISPLAY_STREAK = 2;
// لا سقف مستقلّ للتأخير: السلّم مقيَّد أصلاً بـRESTART_MAX_ATTEMPTS
// (300…4800ms)، وسقف 5000 السابق لم يكن يُبلَغ أبداً فأوهم بحدٍّ لا وجود له.

/**
 * يُطبِّع وسم لغة إلى أقرب خيار مدعوم: مطابقة كاملة أولاً (بلا حساسية حالة)،
 * ثم مطابقة بادئة اللغة (`ar-EG` أو `ar` ⇒ `ar-SA`). وإلا يُعاد كما هو ليُضاف
 * خياراً إضافياً — قائمة ثابتة تُسقط لغة المستخدم صامتةً أسوأ من قائمة تنمو.
 */
export function normalizeVoiceLang(raw: string | null | undefined): string {
  const candidate = (raw || '').trim();
  if (!candidate) return 'ar-SA';
  const lower = candidate.toLowerCase();
  const exact = VOICE_LANGUAGE_OPTIONS.find((option) => option.toLowerCase() === lower);
  if (exact) return exact;
  const primary = lower.split('-')[0];
  const byPrefix = VOICE_LANGUAGE_OPTIONS.find(
    (option) => option.toLowerCase().split('-')[0] === primary,
  );
  if (byPrefix) return byPrefix;
  return candidate;
}

// النتائج النهائية فقط (isFinal=true) ابتداءً من `resultIndex`. `results`
// تراكمية طوال الجلسة مع continuous=true، فالقراءة من الصفر تُكرّر كل مقطع.
type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult:
    | ((event: {
        resultIndex: number;
        results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
      }) => void)
    | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
};

/**
 * WebKit: النطق الواحد بدل الاستمرار.
 *
 * ‏`continuous = true` معطوبٌ موثَّقاً في محرّك آبل بثلاثة أشكال يبلّغ عنها
 * المطوّرون منذ iOS 15: تكرار المقطع نفسه مرّتين (بـ`isFinal` وبدونه)، وسقوط
 * كلمات من منتصف الكلام، وميكروفونٍ لا يتوقّف فلا تصل النتيجة أصلاً. والثلاثة
 * تُنتج ما يراه المستخدم «نصّاً ناقصاً أو مشوّهاً».
 *
 * فنطلب منه ما يُحسنه: نطقاً واحداً في كل جلسة، ونتولّى نحن الاستمرارية بحلقة
 * إعادة التشغيل المبنيّة أصلاً لأندرويد — ومحرّكه أحادي النطق بدوره. وهذا
 * يجعل المسارين متطابقين بدل أن يعتمد أحدهما على وعدٍ لا يفي به المحرّك.
 *
 * ويشمل الشرط سفاري على سطح المكتب: الأعطال مُبلَّغ عنها على macOS كذلك.
 * وكل متصفّحات iOS تعمل بـWebKit إلزاماً — فبريف وكروم هناك سفاري تحت الغطاء.
 */
function prefersSingleUtterance(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const isIOS =
    /iP(hone|ad|od)/.test(ua) ||
    // iPadOS 13+ ينتحل هوية macOS؛ اللمس هو ما يفضحه.
    (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints ?? 0) > 1);
  // `AppleWebKit` وحده لا يكفي: كروم يحمله، وjsdom كذلك (فينقلب اختبارنا
  // إلى مسار سفاري بلا سفاري). البصمة المميِّزة هي `Version/x.y Safari/z`،
  // وهي في سفاري سطح المكتب وحده — يليها في كروم رقم بناء بلا `Version/`.
  const isDesktopSafari =
    /Version\/[\d.]+ Safari\//.test(ua) && !/Chrome|Chromium|Edg|OPR|CriOS/.test(ua);
  return isIOS || isDesktopSafari;
}

function getRecognitionCtor(): { new (): SpeechRecognitionLike } | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: { new (): SpeechRecognitionLike };
    webkitSpeechRecognition?: { new (): SpeechRecognitionLike };
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** يفصل كل المستمعات ثم يُجهض — بلا الفصل تبقى النسخة تكتب في الحالة (زومبي). */
function detachAndAbort(recognition: SpeechRecognitionLike | null): void {
  if (!recognition) return;
  recognition.onresult = null;
  recognition.onerror = null;
  recognition.onend = null;
  recognition.onstart = null;
  try {
    recognition.abort();
  } catch {
    // آمن: قد تُطلق إن لم تكن نشطة.
  }
}

export function useVoiceDictation(
  insertAtCursor: (text: string) => void,
  options?: UseVoiceDictationOptions,
): UseVoiceDictationResult {
  const { onStateChange, storageScope } = options ?? {};
  // يُقرأ باني الواجهة مرّة واحدة ويُعاد استعماله في كل بدء — لا استكشاف مكرّر.
  const [recognitionCtor] = useState(() => getRecognitionCtor());
  const [isSupported] = useState(
    () =>
      // سياق غير آمن ⇒ التقاط الصوت مرفوض على مستوى المتصفّح؛ إخفاء الزرّ
      // أصدق من زرّ يُضغط فلا يحدث شيء (الفشل الصامت في مراجعة B-428).
      recognitionCtor !== null && typeof window !== 'undefined' && Boolean(window.isSecureContext),
  );
  const [isListening, setIsListening] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<VoiceDictationErrorCode | null>(null);
  const [lang, setLangState] = useState<string>(() => {
    if (typeof window === 'undefined') return 'ar-SA';
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(voiceLangStorageKey(storageScope));
    } catch {
      stored = null;
    }
    return normalizeVoiceLang(stored || navigator.language);
  });

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  // هوية النسخة: `sessionCounterRef` آخر نسخة أُنشئت، و`activeSessionRef` النسخة
  // المُصرَّح لها بالاستمرار (0 = لا استماع). حارس مشترك واحد كان يُصفَّر تزامنياً
  // بعد abort فتنجو النسخة القديمة وتُعيد تشغيل نفسها (B-428 §2).
  const sessionCounterRef = useRef(0);
  const activeSessionRef = useRef(0);
  const restartAttemptsRef = useRef(0);
  // عدّاد أخطاء متتالية مستقلّ عن عدّاد فشل البدء: محرّك يفتح الالتقاط ثم يفشل
  // شبكياً يُصفّر الأول عند كل `onstart`، فلولا هذا العدّاد عادت حلقة إعادة
  // التشغيل التي أغلقها B-428 §3 من باب `onerror`. يُصفَّر بنتيجة ناجحة وحدها.
  const errorStreakRef = useRef(0);
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const insertRef = useRef(insertAtCursor);
  const onStateChangeRef = useRef(onStateChange);

  useEffect(() => {
    insertRef.current = insertAtCursor;
  }, [insertAtCursor]);
  useEffect(() => {
    onStateChangeRef.current = onStateChange;
  }, [onStateChange]);

  const clearRestartTimer = useCallback(() => {
    if (restartTimerRef.current) {
      clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }
  }, []);

  // B-437 §5: النطاق يصل متأخّراً (هوية المستخدم تُحمَّل بعد تركيب المُؤلِّف)،
  // فقراءةٌ واحدة عند التهيئة تُثبّت تفضيل المفتاح غير المُنطَّق ثم تكتب لاحقاً
  // في مفتاح آخر ⇒ تفضيل يتيم. نُعيد القراءة عند كل تبدّل نطاق فعلي، ولا نلمس
  // الاختيار الحالي إن لم يكن للنطاق الجديد تفضيل محفوظ.
  const storageScopeRef = useRef(storageScope);
  useEffect(() => {
    if (storageScopeRef.current === storageScope) return;
    storageScopeRef.current = storageScope;
    if (typeof window === 'undefined') return;
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(voiceLangStorageKey(storageScope));
    } catch {
      stored = null;
    }
    if (stored) {
      setLangState(normalizeVoiceLang(stored));
    }
  }, [storageScope]);

  const setLang = useCallback(
    (next: string) => {
      setLangState(next);
      try {
        window.localStorage.setItem(voiceLangStorageKey(storageScope), next);
      } catch {
        // تجاهل: التخزين قد يكون معطّلاً.
      }
    },
    [storageScope],
  );

  const endSession = useCallback(
    (discardPending: boolean) => {
      activeSessionRef.current = 0;
      clearRestartTimer();
      restartAttemptsRef.current = 0;
      const rec = recognitionRef.current;
      if (rec) {
        if (discardPending) {
          // فصل المستمعات + إجهاض + تصفير المرجع: النتيجة المعلّقة تُهمَل، ورفع
          // عدّاد النسخ يُبطل أي مستمع نجا في رحلة حدث جارية (حارس sessionId).
          sessionCounterRef.current += 1;
          detachAndAbort(rec);
          recognitionRef.current = null;
        } else {
          try {
            // stop (لا abort) كي تصل النتيجة النهائية المعلّقة قبل الإغلاق.
            rec.stop();
          } catch {
            // قد تُطلق إذا لم يكن نشطاً — آمن.
          }
        }
      }
      setIsListening(false);
      setIsStarting(false);
      onStateChangeRef.current?.(false);
    },
    [clearRestartTimer],
  );

  const stop = useCallback(() => endSession(false), [endSession]);
  const stopAndDiscard = useCallback(() => endSession(true), [endSession]);

  const start = useCallback(() => {
    const Ctor = recognitionCtor;
    if (!Ctor || (typeof window !== 'undefined' && !window.isSecureContext)) {
      setError('unsupported');
      return;
    }
    setError(null);
    clearRestartTimer();

    // افصل مستمعات النسخة السابقة قبل إجهاضها — النسخة المُجهضة تُطلق onend
    // (وأحياناً onerror) بعد الإجهاض، ومستمعها القديم يبقى حيّاً لولا التصفير.
    detachAndAbort(recognitionRef.current);
    recognitionRef.current = null;

    const sessionId = sessionCounterRef.current + 1;
    sessionCounterRef.current = sessionId;
    activeSessionRef.current = sessionId;
    restartAttemptsRef.current = 0;
    errorStreakRef.current = 0;
    // النسخة القديمة أُجهضت للتوّ: الالتقاط متوقّف حتى يصل `onstart` الجديد،
    // فلا تبقى «يستمع» مرفوعة عبر فجوة إعادة التشغيل (تغيير اللغة، بدء يدوي).
    setIsListening(false);

    const recognition = new Ctor();
    recognition.lang = lang;
    // على WebKit نطقٌ واحد ثم إعادة تشغيل بحلقتنا (انظر `prefersSingleUtterance`).
    recognition.continuous = !prefersSingleUtterance();
    recognition.interimResults = false; // نتائج نهائية فقط — انظر تعليق الواجهة.

    const finish = (nextError?: VoiceDictationErrorCode) => {
      activeSessionRef.current = 0;
      // الحارس يمنع إعادة التشغيل، لكنّه لا يُنهي النسخة عند المتصفّح: بلا إجهاض
      // صريح يبقى مؤشّر الميكروفون مضاءً بعد ما تعتبره الواجهة توقّفاً.
      if (recognitionRef.current === recognition) {
        detachAndAbort(recognition);
        recognitionRef.current = null;
      }
      if (nextError) setError(nextError);
      setIsListening(false);
      setIsStarting(false);
      onStateChangeRef.current?.(false);
    };

    // مصدر الحقيقة للالتقاط الفعلي (B-437 §4/§5): وصولُه يعني أنّ إعادة التشغيل
    // نجحت فعلاً ⇒ يُصفَّر عدّاد المحاولات، فيبقى العدّاد حارساً على فشل البدء
    // المتكرّر وحده ولا يستنزفه صمتٌ عادي يُنهي الالتقاط في Chrome.
    recognition.onstart = () => {
      if (activeSessionRef.current !== sessionId) return;
      restartAttemptsRef.current = 0;
      setIsStarting(false);
      setIsListening(true);
    };

    recognition.onresult = (event) => {
      // حارس النسخة: نتائج نسخة تجاوزتها نسخة أحدث تُهمَل. لا نشترط
      // activeSessionRef هنا كي تصل النتيجة النهائية المتأخّرة بعد stop() يدوي.
      if (sessionCounterRef.current !== sessionId) return;
      let appended = '';
      const startIndex = typeof event.resultIndex === 'number' ? event.resultIndex : 0;
      for (let i = startIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          appended += result[0].transcript;
        }
      }
      const trimmed = appended.trim();
      if (trimmed) {
        // نتيجة ناجحة = الجلسة سليمة أيضاً (تأكيد ثانٍ بعد onstart)، فيُصفَّر
        // العدّاد ويُمحى خطأ عابر (network مثلاً) بقي معروضاً بينما التفريغ عاد
        // يعمل فعلاً.
        restartAttemptsRef.current = 0;
        errorStreakRef.current = 0;
        setError(null);
        insertRef.current(trimmed);
      }
    };

    recognition.onerror = (event) => {
      if (sessionCounterRef.current !== sessionId) return;
      // no-speech = انتهى بلا كلام (طبيعي)، aborted = إيقافنا نحن.
      if (event.error && event.error !== 'no-speech' && event.error !== 'aborted') {
        errorStreakRef.current += 1;
        // العرض بعد تكرار: خطأ عابر تُصلحه إعادة التشغيل التالية لا يُعرض أصلاً،
        // فلا يومض نصّ عطلٍ يظنّه المستخدم انقطاعاً. أمّا الأخطاء غير القابلة
        // للتعافي فتُعرض فوراً في الفرع أدناه عبر `finish`.
        if (errorStreakRef.current >= ERROR_DISPLAY_STREAK) {
          setError(event.error);
        }
        if (errorStreakRef.current >= RESTART_MAX_ATTEMPTS) {
          // خطأ متكرّر بلا نتيجة واحدة بينهما (network مثلاً): أوقِف بدل حلقة
          // تُحرق المعالج وتقصف محرّك التعرّف كل 300ms.
          clearRestartTimer();
          finish('restart-exhausted');
          return;
        }
      }
      if (
        event.error === 'not-allowed' ||
        event.error === 'service-not-allowed' ||
        event.error === 'audio-capture' ||
        event.error === 'language-not-supported'
      ) {
        // أخطاء لا تُصلحها إعادة المحاولة — أوقِف نهائياً بدل حلقة صامتة.
        // ويُمرَّر الرمز صراحةً: عتبة التكرار أعلاه تكتم أوّل ظهور، وكتمُ خطأٍ
        // نهائي يُوقف التفريغ بلا تفسير أسوأ من ومضة.
        clearRestartTimer();
        finish(event.error);
      }
    };

    recognition.onend = () => {
      if (activeSessionRef.current !== sessionId) {
        // إيقاف يدوي أو نسخة متجاوَزة: لا إعادة تشغيل ولا لمس للحالة.
        return;
      }
      // الالتقاط توقّف فعلاً — تُرفع «يستمع» قبل أي إعادة تشغيل، فلا تُعرض
      // حالة استماع والميكروفون مطفأ خلال الفجوة.
      setIsListening(false);
      // continuous=true قد يُوقفه المتصفّح بعد صمت؛ نُعيد التشغيل بتراجع أُسّي
      // وسقف محاولات، فلا تتحوّل «الاستمرارية» إلى حلقة تُحرق المعالج والحصة.
      if (restartAttemptsRef.current >= RESTART_MAX_ATTEMPTS) {
        finish('restart-exhausted');
        return;
      }
      const delay =
        restartAttemptsRef.current === 0
          ? RESTART_FIRST_DELAY_MS
          : RESTART_BASE_DELAY_MS * 2 ** (restartAttemptsRef.current - 1);
      restartAttemptsRef.current += 1;
      setIsStarting(true);
      // لا `clearRestartTimer()` هنا: لا مؤقّت معلّق ممكن عند `onend` — المؤقّت
      // يُصفّر مرجعه قبل أن يستدعي start()، والانتهاء الطبيعي لا يسبقه مؤقّت.
      restartTimerRef.current = setTimeout(() => {
        restartTimerRef.current = null;
        if (activeSessionRef.current !== sessionId) return;
        try {
          recognition.start();
        } catch {
          finish('start-failed');
        }
      }, delay);
    };

    recognitionRef.current = recognition;

    // `isStarting` ترتفع تزامنياً فيستجيب الزرّ فوراً، بينما `isListening` تنتظر
    // `onstart`. وحتى لو لم يصل `onstart` أبداً (إذن معلّق، محرّك معطوب) تبقى
    // الجلسة قابلة للإلغاء: `toggle` يوقف على `isListening || isStarting`.
    setIsStarting(true);
    try {
      recognition.start();
      onStateChangeRef.current?.(true);
    } catch {
      finish('start-failed');
    }
  }, [clearRestartTimer, lang, recognitionCtor]);

  const startRef = useRef(start);
  useEffect(() => {
    startRef.current = start;
  }, [start]);

  // تغيير اللغة أثناء الاستماع: النسخة الحيّة تحمل اللغة القديمة (recognition.lang
  // يُقرأ عند البدء)، فنُعيد التشغيل بالنسخة الجديدة بدل تفريغ صامت بلغة خاطئة.
  const langRef = useRef(lang);
  useEffect(() => {
    if (langRef.current === lang) return;
    langRef.current = lang;
    if (activeSessionRef.current !== 0) {
      startRef.current();
    }
  }, [lang]);

  const toggle = useCallback(() => {
    // جلسة قائمة = التقاط جارٍ أو بدءٌ معلّق؛ كلاهما يُلغى بالزرّ نفسه.
    if (isListening || isStarting) {
      stop();
    } else {
      start();
    }
  }, [isListening, isStarting, start, stop]);

  // نظّف الجلسة عند فكّ التركيب.
  useEffect(() => {
    return () => {
      activeSessionRef.current = 0;
      if (restartTimerRef.current) {
        clearTimeout(restartTimerRef.current);
        restartTimerRef.current = null;
      }
      detachAndAbort(recognitionRef.current);
      recognitionRef.current = null;
    };
  }, []);

  const languageOptions = useMemo(() => {
    const base = [...VOICE_LANGUAGE_OPTIONS] as string[];
    return base.includes(lang) ? base : [lang, ...base];
  }, [lang]);

  return {
    isSupported,
    isListening,
    isStarting,
    lang,
    setLang,
    languageOptions,
    error,
    start,
    stop,
    stopAndDiscard,
    toggle,
  };
}

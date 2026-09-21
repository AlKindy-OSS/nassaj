import { useCallback, useEffect, useRef, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';

/**
 * useVoiceTranscription — الوضع «الدقيق» للتفريغ الصوتي (ADR-103 / T-1248).
 *
 * مقابل `useVoiceDictation` لا بديلاً عنه: ذاك يفرّغ لحظياً بمحرّك المتصفّح
 * (Web Speech) بلا كلفة ولا سرّ، وهذا يسجّل الصوت محلياً ثمّ يرفعه إلى
 * `POST /api/voice/transcription` الذي ينادي Whisper بمفتاح المُشغّل. الفرق
 * الذي يراه المستخدم: كشف لغة تلقائي وترقيم، مقابل ثانية أو ثانيتين انتظاراً.
 *
 * لماذا خطّافان لا خطّاف واحد بفرعين: دورتا الحياة متعامدتان تماماً. الأولى
 * حدثيّة (`onresult` يُدرج أثناء الكلام) والثانية دفعية (تسجيل ⇒ رفع ⇒ إدراج
 * واحد)، وحرّاس النسخة الزومبي في الأولى (B-428) لا يترجمون إلى مسار الرفع.
 * دمجهما يُنتج آلة حالات لكل فرع فيها حارس لا يخصّه.
 *
 * مصائد عولجت هنا صراحةً:
 *   1. **مسارات الـstream**: إيقاف `MediaRecorder` وحده يُبقي مؤشّر الميكروفون
 *      مضاءً في المتصفّح. كل مسار يُوقَف بـ`track.stop()` في كل مسار خروج —
 *      إيقاف عادي، إلغاء، خطأ، فكّ تركيب.
 *   2. **الإدراج المتأخّر**: الرفع رحلة شبكة قد تنتهي بعد تبديل الجلسة، ووجهة
 *      الإدراج حينها صارت مسودّة محادثة أخرى. كل تسجيل يحمل `sessionId` داخلياً،
 *      ولا يُدرج نصّ إلا إن كان معرّفه ما زال الأحدث، ومع ذلك يُجهض الطلب
 *      بـ`AbortController` كي لا يُصرف مفتاح المُشغّل على نصٍّ سيُهمَل.
 *   3. **حمولة محكوم عليها بالفشل**: سقف `maxMb` يُقرأ من الخادم ويُفحص قبل
 *      الرفع. رفع 12 ميغابايت لتعود 413 يهدر شبكة المستخدم ووقته.
 *   4. **التسجيل الأبدي**: مستخدم ينسى الزرّ يملأ الذاكرة ويصنع حمولة مرفوضة.
 *      سقف مدّة يوقف تلقائياً — ويُفرّغ ما سُجّل بدل رميه، مع إشعار صريح.
 *   5. **معامل الترميز في نوع MIME**: ‏`audio/webm;codecs=opus` هو ما يعطيه
 *      `MediaRecorder`، والخادم يطابق قائمة أنواع مطابقةً حرفية. النوع يُجرَّد
 *      من معاملاته قبل بناء الملف.
 *
 * @param insertAtCursor يُدرج النصّ المفرَّغ عند مؤشّر الـtextarea (يملكه المكوّن).
 */

/** ترتيب تفضيل الحاويات: opus أوّلاً (أصغر وأوضح كلاماً)، ثم بدائل Safari. */
export const VOICE_RECORDING_MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
  'audio/ogg',
] as const;

/** سقف مدّة التسجيل الواحد. دقيقتان تكفيان رسالةً طويلة وتمنع التسجيل المنسيّ. */
export const VOICE_RECORDING_MAX_MS = 120_000;

/** الحدّ المفترَض قبل وصول إعدادات الخادم — يُستبدل بـ`maxMb` الفعلي فور وصوله. */
const FALLBACK_MAX_MB = 10;

export type VoiceTranscriptionState = 'idle' | 'recording' | 'uploading' | 'error';

/**
 * رموز الخطأ: العلوية حرفياً كما يرسلها الخادم (فلا طبقة ترجمة ثالثة بين
 * العقد والواجهة)، والسفلية محليّة لأعطال لا تصل الخادم أصلاً.
 */
export type VoiceTranscriptionErrorCode =
  | 'NO_TRANSCRIPTION_KEY'
  | 'INVALID_TRANSCRIPTION_KEY'
  | 'TRANSCRIPTION_RATE_LIMITED'
  | 'TRANSCRIPTION_TIMEOUT'
  | 'TRANSCRIPTION_UNREACHABLE'
  | 'TRANSCRIPTION_FAILED'
  | 'AUDIO_TOO_LARGE'
  | 'UNSUPPORTED_AUDIO_TYPE'
  | 'EMPTY_AUDIO'
  | 'unsupported'
  | 'mic-denied'
  | 'no-mic'
  | 'capture-failed'
  | 'recorder-failed'
  | 'upload-failed'
  | (string & {});

export interface UseVoiceTranscriptionOptions {
  /** سقف الحجم من إعدادات الخادم؛ غيابه يُبقي الحدّ الاحتياطي. */
  maxMb?: number | null;
}

export interface UseVoiceTranscriptionResult {
  /** ‏MediaRecorder + getUserMedia + سياق آمن. غيابها يُخفي الوضع لا يُعطّله. */
  isSupported: boolean;
  state: VoiceTranscriptionState;
  isRecording: boolean;
  isUploading: boolean;
  error: VoiceTranscriptionErrorCode | null;
  /** سقف الحجم المطبَّق فعلاً (ميغابايت) — تعرضه رسالة `AUDIO_TOO_LARGE`. */
  maxMb: number;
  /** إشعار غير خطأ: بلغ التسجيل سقف المدّة فتوقّف تلقائياً وجرى تفريغه. */
  reachedMaxDuration: boolean;
  start: () => void;
  /** إيقاف التسجيل ورفعه. */
  stop: () => void;
  /** إلغاء قاطع: لا رفع ولا إدراج، ويُجهض رفعاً جارياً (تبديل الجلسة). */
  cancel: () => void;
  toggle: () => void;
}

/** مفاتيح مُنطَّقة ومُنسَّخة على نمط `nassaj:voice:*:v1[:userId]` القائم (B-428). */
const MODE_STORAGE_KEY_BASE = 'nassaj:voice:mode:v1';

export function voiceModeStorageKey(scope?: string | null): string {
  return scope ? `${MODE_STORAGE_KEY_BASE}:${scope}` : MODE_STORAGE_KEY_BASE;
}

/**
 * موافقة مستقلّة عن موافقة الوضع السريع: الإفصاحان يصفان رحلتين مختلفتين
 * للصوت (محرّك المتصفّح مقابل خادم نسّاج ثمّ مزوّد خارجي)، ومن وافق على
 * إحداهما لم يوافق على الأخرى.
 */
const ACCURATE_CONSENT_KEY_BASE = 'nassaj:voice:accurate-consent:v1';

export function voiceAccurateConsentStorageKey(scope?: string | null): string {
  return scope ? `${ACCURATE_CONSENT_KEY_BASE}:${scope}` : ACCURATE_CONSENT_KEY_BASE;
}

export type VoiceMode = 'fast' | 'accurate';

function readStoredMode(scope?: string | null): VoiceMode | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(voiceModeStorageKey(scope));
    return raw === 'accurate' || raw === 'fast' ? raw : null;
  } catch {
    return null;
  }
}

/**
 * تفضيل الوضع مخزَّناً. مثل تفضيل اللغة (B-437 §3): النطاق يصل متأخّراً لأنّ
 * هوية المستخدم تُحمَّل بعد تركيب المُؤلِّف، فتُعاد القراءة عند كل تبدّل نطاق
 * فعلي ولا يُلمَس الاختيار الحالي إن لم يكن للنطاق الجديد تفضيل محفوظ.
 */
export function useVoiceMode(scope?: string | null): [VoiceMode, (next: VoiceMode) => void] {
  // الافتراضي «المستمرّ» لا «السريع»: محرّك Web Speech خلف الوضع السريع مبنيّ
  // على النطق الواحد — على أندرويد يُغلق الجلسة عند كل سكتة ويُصدر نغمة نظام
  // عند كل إعادة فتح، فيتقطّع الإملاء وهو أثر لا يُصلحه كودٌ في المتصفّح.
  // الوضع المستمرّ يسجّل تسجيلاً واحداً حتى يوقفه المستخدم بنفسه.
  // وهذا التفضيل لا يُفرض: إن تعذّر المستمرّ (لا محرّك مهيَّأ) هبط المُؤلِّف إلى
  // السريع تلقائياً، ومن اختار السريع صراحةً بقي عليه.
  const [mode, setModeState] = useState<VoiceMode>(() => readStoredMode(scope) ?? 'accurate');

  const scopeRef = useRef(scope);
  useEffect(() => {
    if (scopeRef.current === scope) return;
    scopeRef.current = scope;
    const stored = readStoredMode(scope);
    if (stored) setModeState(stored);
  }, [scope]);

  const setMode = useCallback(
    (next: VoiceMode) => {
      setModeState(next);
      try {
        window.localStorage.setItem(voiceModeStorageKey(scope), next);
      } catch {
        // تجاهل: التخزين قد يكون معطّلاً — التفضيل يبقى لهذه الجلسة.
      }
    },
    [scope],
  );

  return [mode, setMode];
}

/** يُجرِّد معاملات النوع: `audio/webm;codecs=opus` ⇒ `audio/webm` (مصيدة §5). */
export function baseMimeType(mimeType: string): string {
  return (mimeType.split(';')[0] || '').trim().toLowerCase();
}

const EXTENSION_BY_MIME: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
};

function pickMimeType(): string | null {
  const Recorder =
    typeof window === 'undefined'
      ? undefined
      : (window as unknown as { MediaRecorder?: typeof MediaRecorder }).MediaRecorder;
  if (!Recorder) return null;
  if (typeof Recorder.isTypeSupported !== 'function') {
    // متصفّح بلا الاستعلام: نترك الاختيار له بتمرير null (سقوط لطيف لا تعطّل).
    return null;
  }
  for (const candidate of VOICE_RECORDING_MIME_CANDIDATES) {
    try {
      if (Recorder.isTypeSupported(candidate)) return candidate;
    } catch {
      // نوع مرفوض بالكامل — جرّب التالي.
    }
  }
  return null;
}

function detectSupport(): boolean {
  if (typeof window === 'undefined') return false;
  if (!window.isSecureContext) return false;
  const hasRecorder = typeof (window as unknown as { MediaRecorder?: unknown }).MediaRecorder !== 'undefined';
  const hasCapture =
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function';
  return hasRecorder && hasCapture;
}

/** خطأ getUserMedia ⇒ رمز يُترجَم لسبب مفهوم، لا «فشل» عامّ. */
function captureErrorCode(error: unknown): VoiceTranscriptionErrorCode {
  const name = (error as { name?: string } | null)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'mic-denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'no-mic';
  return 'capture-failed';
}

export function useVoiceTranscription(
  insertAtCursor: (text: string) => void,
  options?: UseVoiceTranscriptionOptions,
): UseVoiceTranscriptionResult {
  const maxMbOption = options?.maxMb;
  const maxMb = typeof maxMbOption === 'number' && maxMbOption > 0 ? maxMbOption : FALLBACK_MAX_MB;

  const [isSupported] = useState(detectSupport);
  const [state, setState] = useState<VoiceTranscriptionState>('idle');
  const [error, setError] = useState<VoiceTranscriptionErrorCode | null>(null);
  const [reachedMaxDuration, setReachedMaxDuration] = useState(false);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const durationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // هوية التسجيل: `counter` آخر تسجيل بُدئ، و`active` التسجيل المُصرَّح له
  // بإكمال دورته. رفعٌ يعود بعد إلغاء يفشل حارس المطابقة فلا يُدرج شيئاً.
  const counterRef = useRef(0);
  const activeRef = useRef(0);
  const startingRef = useRef(false);
  const maxMbRef = useRef(maxMb);
  maxMbRef.current = maxMb;

  const insertRef = useRef(insertAtCursor);
  useEffect(() => {
    insertRef.current = insertAtCursor;
  }, [insertAtCursor]);

  const clearDurationTimer = useCallback(() => {
    if (durationTimerRef.current) {
      clearTimeout(durationTimerRef.current);
      durationTimerRef.current = null;
    }
  }, []);

  /** مصيدة §1: مسار حيّ واحد يُبقي مؤشّر الميكروفون مضاءً بعد «التوقّف». */
  const releaseStream = useCallback(() => {
    const stream = streamRef.current;
    streamRef.current = null;
    if (!stream) return;
    try {
      stream.getTracks().forEach((track) => track.stop());
    } catch {
      // مسار أُغلق مسبقاً — آمن.
    }
  }, []);

  const detachRecorder = useCallback(() => {
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (!recorder) return;
    recorder.ondataavailable = null;
    recorder.onstop = null;
    recorder.onerror = null;
    try {
      if (recorder.state !== 'inactive') recorder.stop();
    } catch {
      // مسجّل خامل — آمن.
    }
  }, []);

  const upload = useCallback(
    async (blob: Blob, mimeType: string, recordingId: number) => {
      const controller = new AbortController();
      abortRef.current = controller;
      const extension = EXTENSION_BY_MIME[mimeType] ?? 'webm';
      const form = new FormData();
      // اسم الملفّ يحمل الامتداد: بعض الخوادم الوسيطة تستدلّ به، والخادم عندنا
      // يعتمد النوع لا الاسم — فالاسم مجاملة لا عقد.
      form.append('audio', new File([blob], `recording.${extension}`, { type: mimeType }));
      // بلا حقل `language` عمداً: غيابه = كشف تلقائي، وهو الفارق الذي يُشترى
      // بهذا الوضع أصلاً (مستخدم يخلط العربية والإنجليزية في الجملة نفسها).

      try {
        const response = await authenticatedFetch('/api/voice/transcription', {
          method: 'POST',
          body: form,
          signal: controller.signal,
        });
        let payload: { text?: string; code?: string; error?: string } | null = null;
        try {
          payload = await response.json();
        } catch {
          payload = null;
        }
        if (activeRef.current !== recordingId) return;
        if (!response.ok) {
          setError((payload?.code as VoiceTranscriptionErrorCode) ?? 'upload-failed');
          setState('error');
          return;
        }
        const text = typeof payload?.text === 'string' ? payload.text.trim() : '';
        if (!text) {
          setError('EMPTY_AUDIO');
          setState('error');
          return;
        }
        activeRef.current = 0;
        setState('idle');
        setError(null);
        insertRef.current(text);
      } catch (uploadError) {
        if ((uploadError as { name?: string } | null)?.name === 'AbortError') return;
        if (activeRef.current !== recordingId) return;
        setError('upload-failed');
        setState('error');
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [],
  );

  /** يُنهي التسجيل: يُحرّر الأجهزة ثم يقرّر الرفع أو الخطأ. */
  const finalize = useCallback(
    (mimeType: string, recordingId: number) => {
      clearDurationTimer();
      releaseStream();
      const chunks = chunksRef.current;
      chunksRef.current = [];
      if (activeRef.current !== recordingId) return;

      const base = baseMimeType(mimeType) || 'audio/webm';
      const blob = new Blob(chunks, { type: base });
      if (blob.size === 0) {
        activeRef.current = 0;
        setError('EMPTY_AUDIO');
        setState('error');
        return;
      }
      // مصيدة §3: الفحص قبل الرفع لا بعده — 413 بعد رفع كامل يهدر شبكة المستخدم.
      if (blob.size > maxMbRef.current * 1024 * 1024) {
        activeRef.current = 0;
        setError('AUDIO_TOO_LARGE');
        setState('error');
        return;
      }
      setState('uploading');
      void upload(blob, base, recordingId);
    },
    [clearDurationTimer, releaseStream, upload],
  );

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    clearDurationTimer();
    try {
      if (recorder.state !== 'inactive') {
        // `onstop` هو ما يُطلق `finalize`؛ إيقاف مسجّل خامل لا يُطلقه فنُحرّر يدوياً.
        recorder.stop();
        return;
      }
    } catch {
      // يقع أدناه إلى التحرير اليدوي.
    }
    recorderRef.current = null;
    releaseStream();
    setState('idle');
  }, [clearDurationTimer, releaseStream]);

  const cancel = useCallback(() => {
    // رفع العدّاد أوّلاً: أي `onstop` أو استجابة رفع في الطريق تفشل حارس المطابقة.
    counterRef.current += 1;
    activeRef.current = 0;
    startingRef.current = false;
    clearDurationTimer();
    detachRecorder();
    releaseStream();
    chunksRef.current = [];
    abortRef.current?.abort();
    abortRef.current = null;
    setState('idle');
    setError(null);
    setReachedMaxDuration(false);
  }, [clearDurationTimer, detachRecorder, releaseStream]);

  const start = useCallback(() => {
    if (!isSupported) {
      setError('unsupported');
      setState('error');
      return;
    }
    if (startingRef.current || recorderRef.current) return;
    startingRef.current = true;
    setError(null);
    setReachedMaxDuration(false);

    const recordingId = counterRef.current + 1;
    counterRef.current = recordingId;
    activeRef.current = recordingId;
    chunksRef.current = [];
    setState('recording');

    void (async () => {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (captureError) {
        startingRef.current = false;
        if (activeRef.current !== recordingId) return;
        activeRef.current = 0;
        setError(captureErrorCode(captureError));
        setState('error');
        return;
      }
      // أُلغي أثناء انتظار الإذن: المسارات المفتوحة للتوّ تُغلق فوراً.
      if (activeRef.current !== recordingId) {
        startingRef.current = false;
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;

      const preferred = pickMimeType();
      let recorder: MediaRecorder;
      try {
        const Recorder = (window as unknown as { MediaRecorder: typeof MediaRecorder }).MediaRecorder;
        recorder = preferred ? new Recorder(stream, { mimeType: preferred }) : new Recorder(stream);
      } catch {
        startingRef.current = false;
        activeRef.current = 0;
        releaseStream();
        setError('recorder-failed');
        setState('error');
        return;
      }

      // النوع الفعلي من المسجّل لا من تفضيلنا: متصفّح قد يتجاهل الطلب بصمت.
      const effectiveMime = recorder.mimeType || preferred || 'audio/webm';
      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data && event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        recorderRef.current = null;
        finalize(effectiveMime, recordingId);
      };
      recorder.onerror = () => {
        recorderRef.current = null;
        clearDurationTimer();
        releaseStream();
        if (activeRef.current !== recordingId) return;
        activeRef.current = 0;
        setError('recorder-failed');
        setState('error');
      };

      recorderRef.current = recorder;
      try {
        recorder.start();
      } catch {
        startingRef.current = false;
        recorderRef.current = null;
        activeRef.current = 0;
        releaseStream();
        setError('recorder-failed');
        setState('error');
        return;
      }
      startingRef.current = false;

      // مصيدة §4: السقف يُفرّغ ما سُجّل ولا يرميه — إسقاط دقيقتين من كلام
      // المستخدم عقوبةٌ على نسيان زرّ، والإشعار يكفي لتفسير التوقّف.
      durationTimerRef.current = setTimeout(() => {
        durationTimerRef.current = null;
        if (activeRef.current !== recordingId) return;
        setReachedMaxDuration(true);
        try {
          if (recorderRef.current && recorderRef.current.state !== 'inactive') {
            recorderRef.current.stop();
          }
        } catch {
          // آمن: قد يكون توقّف بالتوازي.
        }
      }, VOICE_RECORDING_MAX_MS);
    })();
  }, [clearDurationTimer, finalize, isSupported, releaseStream]);

  const toggle = useCallback(() => {
    if (state === 'recording') {
      stop();
      return;
    }
    // أثناء الرفع الزرّ معطَّل في الواجهة؛ الحارس هنا يمنع بدءاً ثانياً لو نُقر برمجياً.
    if (state === 'uploading') return;
    start();
  }, [start, state, stop]);

  // فكّ التركيب: كل شيء يُطفأ — مؤقّت، مسجّل، مسارات، ورفع جارٍ.
  const cancelRef = useRef(cancel);
  cancelRef.current = cancel;
  useEffect(() => {
    return () => {
      cancelRef.current();
    };
  }, []);

  return {
    isSupported,
    state,
    isRecording: state === 'recording',
    isUploading: state === 'uploading',
    error,
    maxMb,
    reachedMaxDuration,
    start,
    stop,
    cancel,
    toggle,
  };
}

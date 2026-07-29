import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * T-849 (+ الجزء العميلي من T-881) — القناة الجانبية «/btw».
 *
 * يدير حالة استعلام «/btw» الواحد النشط: يولّد btwId، يرسل `btw-query` على WS
 * الدردشة القائم، ويستقبل الإطارات الموسومة بنفس btwId (`btw-chunk` →
 * `btw-complete` أو `btw-error`) من فتحة `latestMessage` المشتركة. لا شيء من هذا
 * يمسّ سجل المحادثة: إطارات btw-* بلا حقل `kind` فيتجاهلها useChatRealtimeHandlers
 * (فرع legacy → default)، وهنا نستهلك فقط ما يطابق btwId النشط.
 *
 * يدعم استعلامات متتابعة: بدء استعلام جديد يستبدل النشط (الأحدث يظهر) ويُبطل
 * أي إطارات متأخّرة من سابقه (لأن activeBtwIdRef تغيّر).
 *
 * T-1090 (الفرك): مسارٌ ثانٍ فوق نفس القناة والـbtwId — «btw-fork» ← «btw-forked»
 * أو «btw-fork-error». يحوّل السؤال المكتمل إلى محادثة حقيقية (الخادم يفرع نصّ
 * الجلسة ويُلحق به السؤال والإجابة)، ولذلك يملك حالته ومهلته المستقلّتين: نجاحه
 * أو فشله لا يغيّران status الإجابة المعروضة.
 *
 * fallback: الخادم الحيّ قد يسبق «/btw» فلا يردّ إطلاقاً — بعد مهلة سماح بلا أي
 * إطار btw-* نعرض خطأ «الميزة تتطلب تحديث الخادم» بدل تعليق المؤشّر للأبد.
 */

export type BtwStatus = 'pending' | 'streaming' | 'complete' | 'error';

/**
 * T-1090 — حالة «فرك» السؤال الجانبي إلى محادثة حقيقية:
 *   idle    — لا فرك جارٍ (وهي حالة ما بعد النجاح أيضاً، إذ يُغلق الـoverlay)
 *   forking — أُرسل btw-fork وننتظر btw-forked
 *   error   — رُفض الفرك أو انقضت مهلته
 */
export type BtwForkStatus = 'idle' | 'forking' | 'error';

export interface BtwState {
  btwId: string;
  question: string;
  answer: string;
  status: BtwStatus;
  /** حالة زرّ الفرك لهذا السؤال بعينه (تُصفَّر مع كل استعلام جديد). */
  forkStatus: BtwForkStatus;
  /**
   * كود خطأ الفرك حين forkStatus==='error'. من عقد الخادم:
   *   busy | session_not_found | not_writable | unsupported_provider |
   *   invalid_request | transcript_not_found | source_empty | source_too_large |
   *   message_not_found | fork_failed
   * أو مُصطنَع عميلياً: timeout | disconnected
   */
  forkErrorCode?: string;
  /** رسالة الخادم الخام لخطأ الفرك (تُعرض حين لا مفتاح i18n مطابق). */
  forkErrorMessage?: string;
  /**
   * كود الخطأ حين status==='error'. من عقد الخادم:
   *   unsupported_provider | session_not_found | not_visible | busy | sdk_error
   * أو مُصطنَع عميلياً:
   *   timeout — لا ردّ btw-* خلال نافذة السماح (خادم يسبق الميزة)
   *   disconnected — WS غير مفتوح لحظة الإرسال
   */
  errorCode?: string;
  /** رسالة الخطأ الخام من الخادم (تُعرض حين لا مفتاح i18n مطابق للكود). */
  errorMessage?: string;
}

/** نافذة السماح قبل إعلان «يتطلّب تحديث الخادم» (لا ردّ btw-* إطلاقاً). */
export const BTW_FALLBACK_TIMEOUT_MS = 20_000;

/**
 * مهلة الفرك: نسخ نصّ محادثة (حتى عشرات الميغابايت) عملية قرصية لا استدلالية،
 * فثوانٍ قليلة تكفيها. المهلة هنا تحمي من خادم أقدم لا يعرف «btw-fork» (لا يردّ
 * إطلاقاً) ومن ضياع الإطار الطرفي في فتحة latestMessage المشتركة.
 */
export const BTW_FORK_TIMEOUT_MS = 30_000;

type SendResult = { ok: boolean; reason?: string } | void;

interface BtwFrame {
  type?: string;
  btwId?: string;
  text?: string;
  code?: string;
  message?: string;
  /** T-1090: معرّف الجلسة المفروعة في إطار «btw-forked». */
  forkedSessionId?: string;
  [key: string]: unknown;
}

interface UseBtwSideChannelArgs {
  /** الجلسة الجارية التي يُسأل عن سياقها؛ null = لا جلسة (خطأ فوري). */
  sessionId: string | null;
  /** فتحة آخر رسالة WS المشتركة (نفس مصدر useChatRealtimeHandlers). */
  latestMessage: BtwFrame | null;
  sendMessage: (message: unknown) => SendResult;
  /** اختياري: id آخر رسالة معروضة، يُرسَل upToMessageId لتثبيت حدّ السياق. */
  upToMessageId?: string | null;
  /**
   * T-1090: نجح الفرك ← معرّف الجلسة الجديدة. المستهلك ينتقل إليها (ويغلق
   * الـoverlay). يُقرأ من ref فلا يُعيد تشغيل مستقبِل الإطارات عند تغيّره.
   */
  onForked?: (forkedSessionId: string) => void;
}

/** مولّد btwId — crypto.randomUUID متى توفّر، وإلا بديل كافٍ للتوسيم. */
function generateBtwId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // يسقط إلى البديل أدناه.
  }
  return `btw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function useBtwSideChannel({
  sessionId,
  latestMessage,
  sendMessage,
  upToMessageId,
  onForked,
}: UseBtwSideChannelArgs) {
  const [activeBtw, setActiveBtw] = useState<BtwState | null>(null);
  // مرآة لـbtwId النشط تُقرأ في مستقبِل latestMessage دون إعادة تشغيل تأثيره على
  // كل تحديث حالة (كتراكم الإجابة).
  const activeBtwIdRef = useRef<string | null>(null);
  const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const forkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastProcessedRef = useRef<BtwFrame | null>(null);
  // مرآة للـcallback: المستهلك يمرّرها inline غالباً، فقراءتها من ref تُبقي
  // تأثير الإطارات مستقرّاً بدل إعادة تشغيله على كل render.
  const onForkedRef = useRef(onForked);
  onForkedRef.current = onForked;

  const clearFallbackTimer = useCallback(() => {
    if (fallbackTimerRef.current) {
      clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    }
  }, []);

  const clearForkTimer = useCallback(() => {
    if (forkTimerRef.current) {
      clearTimeout(forkTimerRef.current);
      forkTimerRef.current = null;
    }
  }, []);

  const closeBtw = useCallback(() => {
    clearFallbackTimer();
    clearForkTimer();
    activeBtwIdRef.current = null;
    setActiveBtw(null);
  }, [clearFallbackTimer, clearForkTimer]);

  const startBtwQuery = useCallback(
    (question: string) => {
      const trimmed = (question ?? '').trim();
      if (!trimmed) {
        return;
      }
      clearFallbackTimer();
      // استعلام جديد يُلغي أي فرك معلّق من سابقه (الفرك مرتبط بسؤال بعينه).
      clearForkTimer();
      const btwId = generateBtwId();
      activeBtwIdRef.current = btwId;

      // لا جلسة لنسأل عن سياقها → خطأ فوري (مطابق session_not_found) دون انتظار
      // الشبكة، فيرى المستخدم سبباً واضحاً بدل مهلة 20 ثانية.
      if (!sessionId) {
        setActiveBtw({
          btwId,
          question: trimmed,
          answer: '',
          status: 'error',
          errorCode: 'session_not_found',
          forkStatus: 'idle',
        });
        return;
      }

      setActiveBtw({ btwId, question: trimmed, answer: '', status: 'pending', forkStatus: 'idle' });

      const result = sendMessage({
        type: 'btw-query',
        btwId,
        sessionId,
        question: trimmed,
        ...(upToMessageId ? { upToMessageId } : {}),
      });

      // WS غير مفتوح — لن يردّ شيء. نفشل فوراً بدل انتظار المهلة.
      if (result && result.ok === false) {
        setActiveBtw((prev) =>
          prev && prev.btwId === btwId
            ? { ...prev, status: 'error', errorCode: 'disconnected' }
            : prev,
        );
        return;
      }

      // fallback: خادم يسبق «/btw» لن يرسل أي إطار btw-*. بعد نافذة السماح وبلا
      // أي ردّ (ما زال pending) نُظهر «يتطلّب تحديث الخادم».
      fallbackTimerRef.current = setTimeout(() => {
        fallbackTimerRef.current = null;
        setActiveBtw((prev) =>
          prev && prev.btwId === btwId && prev.status === 'pending'
            ? { ...prev, status: 'error', errorCode: 'timeout' }
            : prev,
        );
      }, BTW_FALLBACK_TIMEOUT_MS);
    },
    [sessionId, sendMessage, upToMessageId, clearFallbackTimer, clearForkTimer],
  );

  /**
   * T-1090 — يحوّل السؤال الجانبي المكتمل إلى محادثة حقيقية: يُرسل «btw-fork»
   * فيفرع الخادمُ نصَّ الجلسة على القرص ويُلحق به السؤال والإجابة المعروضة الآن.
   * بلا استدلال جديد ولا استهلاك حصة — الإجابة تُعاد استعمالاً لا سؤالاً.
   *
   * لا يُرسَل إلا على سؤال مكتمل بإجابة غير فارغة (نفس شرط «f» في الـCLI)، وفركٌ
   * واحد في الطيران لكل سؤال.
   */
  const forkBtw = useCallback(() => {
    // نقرأ الحالة الظاهرة مباشرةً (لا داخل updater): الـupdater يجب أن يبقى نقيّاً
    // لأن React قد يستدعيه أكثر من مرة.
    if (
      !activeBtw
      || activeBtw.status !== 'complete'
      || activeBtw.answer.trim() === ''
      || activeBtw.forkStatus === 'forking'
    ) {
      return;
    }
    const { btwId, question, answer } = activeBtw;

    setActiveBtw((prev) =>
      prev && prev.btwId === btwId
        ? { ...prev, forkStatus: 'forking', forkErrorCode: undefined, forkErrorMessage: undefined }
        : prev,
    );

    const failFork = (code: string) => {
      setActiveBtw((prev) =>
        prev && prev.btwId === btwId && prev.forkStatus === 'forking'
          ? { ...prev, forkStatus: 'error', forkErrorCode: code }
          : prev,
      );
    };

    // لا جلسة ⇒ لا نصّ نفرعه؛ نفشل فوراً بدل انتظار المهلة.
    if (!sessionId) {
      failFork('session_not_found');
      return;
    }

    const result = sendMessage({
      type: 'btw-fork',
      btwId,
      sessionId,
      question,
      answer,
      ...(upToMessageId ? { upToMessageId } : {}),
    });

    if (result && result.ok === false) {
      failFork('disconnected');
      return;
    }

    clearForkTimer();
    forkTimerRef.current = setTimeout(() => {
      forkTimerRef.current = null;
      failFork('timeout');
    }, BTW_FORK_TIMEOUT_MS);
  }, [activeBtw, sessionId, sendMessage, upToMessageId, clearForkTimer]);

  // استقبال إطارات btw-* من فتحة latestMessage المشتركة. نستهلك فقط ما يحمل
  // btwId النشط؛ أي شيء آخر (حركة الدردشة العادية، أو btwId من استعلام تجاوزناه)
  // يُتجاهَل — فلا يتسرّب شيء من btw إلى مخزن المحادثة.
  useEffect(() => {
    if (!latestMessage) {
      return;
    }
    if (lastProcessedRef.current === latestMessage) {
      return;
    }
    lastProcessedRef.current = latestMessage;

    const { type } = latestMessage;
    if (
      type !== 'btw-chunk' &&
      type !== 'btw-complete' &&
      type !== 'btw-error' &&
      type !== 'btw-accepted' &&
      type !== 'btw-forked' &&
      type !== 'btw-fork-error'
    ) {
      return;
    }

    const { btwId } = latestMessage;
    if (!btwId || btwId !== activeBtwIdRef.current) {
      return;
    }

    // T-1090: إطارا الفرك طرفيّان لمسارٍ مستقلّ عن مسار الإجابة — يُبطلان مهلة
    // الفرك وحدها ولا يمسّان حالة الاستعلام (status تبقى complete).
    if (type === 'btw-forked') {
      clearForkTimer();
      const forkedSessionId =
        typeof latestMessage.forkedSessionId === 'string' ? latestMessage.forkedSessionId : '';
      if (!forkedSessionId) {
        setActiveBtw((prev) =>
          prev && prev.btwId === btwId
            ? { ...prev, forkStatus: 'error', forkErrorCode: 'fork_failed' }
            : prev,
        );
        return;
      }
      setActiveBtw((prev) => (prev && prev.btwId === btwId ? { ...prev, forkStatus: 'idle' } : prev));
      onForkedRef.current?.(forkedSessionId);
      return;
    }

    if (type === 'btw-fork-error') {
      clearForkTimer();
      const forkErrorCode =
        typeof latestMessage.code === 'string' && latestMessage.code
          ? latestMessage.code
          : 'fork_failed';
      const forkErrorMessage =
        typeof latestMessage.message === 'string' ? latestMessage.message : undefined;
      setActiveBtw((prev) =>
        prev && prev.btwId === btwId
          ? { ...prev, forkStatus: 'error', forkErrorCode, forkErrorMessage }
          : prev,
      );
      return;
    }

    // وصل ردّ معترَف به للاستعلام النشط → الخادم يعرف «/btw» فعلاً: أبطِل fallback.
    clearFallbackTimer();

    if (type === 'btw-accepted') {
      // الخادم قَبِل الطلب وبدأ الفرك — المهلة أُبطلت أعلاه؛ لا تغيير على الحالة
      // (pending/streaming تبقى كما هي حتى يصل btw-chunk الأول).
      return;
    }

    if (type === 'btw-chunk') {
      const delta = typeof latestMessage.text === 'string' ? latestMessage.text : '';
      if (!delta) {
        return;
      }
      setActiveBtw((prev) =>
        prev && prev.btwId === btwId && prev.status !== 'complete' && prev.status !== 'error'
          ? { ...prev, answer: prev.answer + delta, status: 'streaming' }
          : prev,
      );
    } else if (type === 'btw-complete') {
      // B-270: the terminal frame carries the FULL answer (server accumulates it).
      // When present it is the source of truth — adopt it as the final answer, so
      // the reply is correct even if every intermediate btw-chunk was dropped (the
      // live failure: chunk + complete landed in the same shared latestMessage slot
      // and the chunk was overwritten before this effect saw it). When absent (an
      // older server, or a genuinely empty answer) keep the accumulated chunks.
      const finalText =
        typeof latestMessage.text === 'string' && latestMessage.text.length > 0
          ? latestMessage.text
          : null;
      setActiveBtw((prev) =>
        prev && prev.btwId === btwId
          ? { ...prev, status: 'complete', ...(finalText !== null ? { answer: finalText } : {}) }
          : prev,
      );
    } else {
      const errorCode =
        typeof latestMessage.code === 'string' && latestMessage.code ? latestMessage.code : 'sdk_error';
      const errorMessage =
        typeof latestMessage.message === 'string' ? latestMessage.message : undefined;
      setActiveBtw((prev) =>
        prev && prev.btwId === btwId
          ? { ...prev, status: 'error', errorCode, errorMessage }
          : prev,
      );
    }
  }, [latestMessage, clearFallbackTimer, clearForkTimer]);

  // تنظيف المؤقّتات عند التفكيك.
  useEffect(
    () => () => {
      clearFallbackTimer();
      clearForkTimer();
    },
    [clearFallbackTimer, clearForkTimer],
  );

  return { activeBtw, startBtwQuery, closeBtw, forkBtw };
}

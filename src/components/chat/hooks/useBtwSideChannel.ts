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
 * fallback: الخادم الحيّ قد يسبق «/btw» فلا يردّ إطلاقاً — بعد مهلة سماح بلا أي
 * إطار btw-* نعرض خطأ «الميزة تتطلب تحديث الخادم» بدل تعليق المؤشّر للأبد.
 */

export type BtwStatus = 'pending' | 'streaming' | 'complete' | 'error';

export interface BtwState {
  btwId: string;
  question: string;
  answer: string;
  status: BtwStatus;
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

type SendResult = { ok: boolean; reason?: string } | void;

interface BtwFrame {
  type?: string;
  btwId?: string;
  text?: string;
  code?: string;
  message?: string;
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
}: UseBtwSideChannelArgs) {
  const [activeBtw, setActiveBtw] = useState<BtwState | null>(null);
  // مرآة لـbtwId النشط تُقرأ في مستقبِل latestMessage دون إعادة تشغيل تأثيره على
  // كل تحديث حالة (كتراكم الإجابة).
  const activeBtwIdRef = useRef<string | null>(null);
  const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastProcessedRef = useRef<BtwFrame | null>(null);

  const clearFallbackTimer = useCallback(() => {
    if (fallbackTimerRef.current) {
      clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    }
  }, []);

  const closeBtw = useCallback(() => {
    clearFallbackTimer();
    activeBtwIdRef.current = null;
    setActiveBtw(null);
  }, [clearFallbackTimer]);

  const startBtwQuery = useCallback(
    (question: string) => {
      const trimmed = (question ?? '').trim();
      if (!trimmed) {
        return;
      }
      clearFallbackTimer();
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
        });
        return;
      }

      setActiveBtw({ btwId, question: trimmed, answer: '', status: 'pending' });

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
    [sessionId, sendMessage, upToMessageId, clearFallbackTimer],
  );

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
      type !== 'btw-accepted'
    ) {
      return;
    }

    const { btwId } = latestMessage;
    if (!btwId || btwId !== activeBtwIdRef.current) {
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
  }, [latestMessage, clearFallbackTimer]);

  // تنظيف المؤقّت عند التفكيك.
  useEffect(() => () => clearFallbackTimer(), [clearFallbackTimer]);

  return { activeBtw, startBtwQuery, closeBtw };
}

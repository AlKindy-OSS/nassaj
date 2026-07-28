/**
 * useConversationClosed — إغلاق/فتح المحادثة عبر
 * `POST|DELETE /api/sessions/:id/close`.
 *
 * التبديل متفائل: الزرّ ينقلب فوراً ثم يتراجع عند فشل الطلب — الإغلاق فعل
 * تنظيمي لا مالي، وانتظار الشبكة قبل ردّ الفعل يجعله يبدو معطّلاً.
 *
 * `initialClosed` يأتي من صفّ الجلسة (حمولة الشريط الجانبي تحمل `closed`).
 * التبنّي مشروط بتغيّر القيمة فعلاً: أب يعيد تمرير قيمة قديمة لم يُحدّثها بعد
 * لا يجوز أن يتراجع عن تبديل نفّذه المستخدم قبل لحظة.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';

export type UseConversationClosedResult = {
  closed: boolean;
  /** طلب طائر — الزرّ يُعطَّل ريثما يُحسَم. */
  pending: boolean;
  /** آخر محاولة فشلت وتراجعت الحالة. */
  failed: boolean;
  toggle: () => void;
};

export function useConversationClosed(
  sessionId: string | null | undefined,
  options: { initialClosed?: boolean; onChange?: (closed: boolean) => void } = {},
): UseConversationClosedResult {
  const { initialClosed = false, onChange } = options;

  const [closed, setClosed] = useState(initialClosed);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  const mountedRef = useRef(true);
  const syncedRef = useRef(initialClosed);
  const sessionRef = useRef(sessionId);
  // نداء الأب يُقرأ من ref كي لا يُعيد `toggle` بناءه على كل تصيير للأب.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const sessionChanged = sessionRef.current !== sessionId;
    sessionRef.current = sessionId;
    // تبدُّل المحادثة يعيد الضبط دائماً؛ ثبات المحادثة يتبنّى المُدخَل فقط
    // حين يتغيّر فعلاً (وإلا داس على تبديل متفائل لم يبلغ الأب بعد).
    if (sessionChanged || syncedRef.current !== initialClosed) {
      syncedRef.current = initialClosed;
      setClosed(initialClosed);
      setPending(false);
      setFailed(false);
    }
  }, [sessionId, initialClosed]);

  const toggle = useCallback(() => {
    if (!sessionId || pending) return;

    const previous = closed;
    const next = !previous;

    setClosed(next);
    setPending(true);
    setFailed(false);
    onChangeRef.current?.(next);

    const rollback = () => {
      if (!mountedRef.current) return;
      syncedRef.current = previous;
      setClosed(previous);
      setFailed(true);
      onChangeRef.current?.(previous);
    };

    void (async () => {
      try {
        const response = await authenticatedFetch(
          `/api/sessions/${encodeURIComponent(sessionId)}/close`,
          { method: next ? 'POST' : 'DELETE' },
        );

        // جسم غير قابل للتحليل على ردّ ناجح لا يُبطل النجاح؛ الحالة هي الحكم.
        const body = response.ok
          ? await response.json().catch(() => null as { success?: boolean } | null)
          : null;

        if (!mountedRef.current) return;

        if (!response.ok || body?.success === false) {
          rollback();
          return;
        }

        syncedRef.current = next;
      } catch {
        rollback();
      } finally {
        if (mountedRef.current) {
          setPending(false);
        }
      }
    })();
  }, [sessionId, closed, pending]);

  return { closed, pending, failed, toggle };
}

export default useConversationClosed;

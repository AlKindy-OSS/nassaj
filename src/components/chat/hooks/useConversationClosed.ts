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
 *
 * ولنفس الجلسة أكثر من مثيل حيّ في الشاشة: زرّ شريط المحادثة، وصفّها في الشريط
 * الجانبي. كلٌّ منهما يبني حالته من حمولته، فتبديلٌ في أحدهما كان لا يبلغ الآخر
 * إلا بعد دورة `projects_updated` كاملة (‏debounce الخادم، ثم إعادة بناء
 * الحمولة، وقد تُسقَط الدفعة كلياً إن كانت الجلسة تبثّ) — فيبدو الإغلاق
 * «متأخّراً عن الواجهة» رغم أن الزرّ المضغوط انقلب فوراً. لذلك يبثّ كل مثيل
 * تبديله إلى إخوته في نفس التبويب مباشرة. البثّ لا يستبدل حمولة الخادم: هو
 * الجسر بين مثيلات الخطّاف نفسه ريثما تصل، وتظلّ الحمولة هي مَن يحسم أخيراً.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';

type ClosedBroadcast = {
  sessionId: string;
  closed: boolean;
  /** حُسم على الخادم (نجاح أو تراجع) لا مجرّد تبديل متفائل. */
  settled: boolean;
  /** مثيل المصدر — لا يستقبل بثّه هو. */
  origin: symbol;
};

const closedSubscribers = new Set<(event: ClosedBroadcast) => void>();

/**
 * آخر حالة يعرفها التبويب لجلسة بُدِّلت، محفوظةً خارج شجرة React.
 *
 * البثّ وحده لا يكفي: صفوف الشريط الجانبي تُفكَّك وتُركَّب مع كل دفعة
 * `projects_updated`، ومثيلٌ جديد يبدأ من `initialClosed` — أي من الحمولة التي
 * لم تلحق بعد. فيظهر الإغلاق فوراً ثم **يرتدّ** بعد ثوانٍ إلى ما قبله، وهو
 * بالضبط «اشتغلت أول مرة ثم رجعت». والحمولة قد لا تلحق إطلاقاً: دفعة
 * `projects_updated` لجلسة تبثّ تُسقَط كلياً حين لا تكون additive.
 *
 * التجاوز يُمحى في اللحظة التي تحمل فيها الحمولة نفس القيمة — عندها لحق الخادم
 * وصار هو المصدر، فلا يبقى في الذاكرة رأيٌ ثانٍ يعمّر بعد صلاحيته.
 */
const closedOverrides = new Map<string, boolean>();

function publishClosed(event: ClosedBroadcast): void {
  closedOverrides.set(event.sessionId, event.closed);
  for (const subscriber of closedSubscribers) {
    subscriber(event);
  }
}

/**
 * تصفير التجاوزات — للاختبار وحده.
 *
 * الخريطة تعيش خارج شجرة React فتعبر بين حالات الاختبار في نفس الملف: جلسة
 * أُغلقت في حالة سابقة كانت تبدأ مغلقةً في التالية. في المتصفّح لا نظير لذلك،
 * فالتبويب واحد ومعرّفات الجلسات فريدة، والتجاوز يُمحى حين تلحق الحمولة.
 */
export function __resetConversationClosedOverrides(): void {
  closedOverrides.clear();
}

/** الحالة المعروضة عند التركيب: التجاوز إن وُجد، وإلا حمولة الخادم. */
function resolveClosed(sessionId: string | null | undefined, initialClosed: boolean): boolean {
  if (!sessionId) return initialClosed;
  const override = closedOverrides.get(sessionId);
  return override === undefined ? initialClosed : override;
}

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

  const [closed, setClosed] = useState(() => resolveClosed(sessionId, initialClosed));
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  const mountedRef = useRef(true);
  const syncedRef = useRef(initialClosed);
  const sessionRef = useRef(sessionId);
  const originRef = useRef<symbol>(Symbol('conversation-closed'));
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

    const override = sessionId ? closedOverrides.get(sessionId) : undefined;
    if (sessionId && override !== undefined && override === initialClosed) {
      // لحقت الحمولة بالتجاوز: يعود الخادم مصدراً وحيداً.
      closedOverrides.delete(sessionId);
    }

    // تبدُّل المحادثة يعيد الضبط دائماً، لكن إلى ما يعرفه التبويب لا إلى حمولة
    // متأخّرة: جلسة أُغلقت للتوّ ثم عُدنا إليها يجب أن تبقى مغلقة في العين.
    if (sessionChanged) {
      syncedRef.current = initialClosed;
      setClosed(resolveClosed(sessionId, initialClosed));
      setPending(false);
      setFailed(false);
      return;
    }

    // ثبات المحادثة يتبنّى المُدخَل فقط حين يتغيّر فعلاً — وحتى عندها لا يدوس
    // على تبديلٍ يعرفه التبويب ولم يبلغ الحمولةَ بعد.
    if (syncedRef.current !== initialClosed) {
      if (override !== undefined && override !== initialClosed) {
        return;
      }
      syncedRef.current = initialClosed;
      setClosed(initialClosed);
      setPending(false);
      setFailed(false);
    }
  }, [sessionId, initialClosed]);

  /* استقبال تبديل أخٍ على نفس الجلسة. `syncedRef` لا يتحرّك إلا على الحدث
     المحسوم: بقاؤه على القيمة القديمة أثناء التبديل المتفائل هو ما يمنع حمولةً
     قديمة في الطريق من الدوس على ما يراه المستخدم. */
  useEffect(() => {
    if (!sessionId) return undefined;

    const subscriber = (event: ClosedBroadcast) => {
      if (event.origin === originRef.current || event.sessionId !== sessionId) return;
      setClosed(event.closed);
      if (event.settled) {
        syncedRef.current = event.closed;
      }
    };

    closedSubscribers.add(subscriber);
    return () => {
      closedSubscribers.delete(subscriber);
    };
  }, [sessionId]);

  const toggle = useCallback(() => {
    if (!sessionId || pending) return;

    const previous = closed;
    const next = !previous;

    setClosed(next);
    setPending(true);
    setFailed(false);
    onChangeRef.current?.(next);
    publishClosed({ sessionId, closed: next, settled: false, origin: originRef.current });

    /* التراجع يُبثّ أيضاً — إخوة انقلبوا معك على التفاؤل، فتركهم على القيمة
       الفاشلة يجعل الشاشة تكذب في سطحين بدل واحد. */
    const rollback = () => {
      publishClosed({ sessionId, closed: previous, settled: true, origin: originRef.current });
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

        if (!response.ok || body?.success === false) {
          // قبل فحص التركيب: المثيل الذي أطلق الطلب قد يُفكَّك قبل ردّ الخادم
          // (قائمة سياق أُغلقت، جلسة بُدِّلت)، وإخوته ما زالوا على الشاشة
          // منتظرين الحسم.
          rollback();
          return;
        }

        publishClosed({ sessionId, closed: next, settled: true, origin: originRef.current });
        if (!mountedRef.current) return;

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

/**
 * useConversationCost — كلفة المحادثة المفتوحة من `GET /api/providers/costs/session/:id`.
 *
 * لا استطلاع دوري: الكلفة لا تتغيّر إلا حين يردّ النموذج، فالجلب مرّة عند
 * تبدُّل المحادثة ثم عند **هبوط** البثّ (`isLoading` من true إلى false) يغطّي
 * كل تغيّر حقيقي بطلبين لا بعشرات. الشارة تحتفظ بالرقم القديم أثناء إعادة
 * الجلب (انظر `resolveCostDisplay`) فلا يظهر وميض بعد كل ردّ.
 *
 * فشل أول طلب — شبكة، 404، أو `success:false` — يُترجَم «غير متاحة» لا
 * صفراً. أمّا فشل تحديث فوق لقطة موجودة فيُبقيها ظاهرة كقيمة قديمة؛ محو آخر
 * معلوم لا يجعل الشاشة أصدق.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';
import type {
  ConversationCost,
  ConversationCostStatus,
} from '../view/subcomponents/conversationCostFormat';

export type UseConversationCostResult = {
  cost: ConversationCost | null;
  status: ConversationCostStatus;
  /** إعادة جلب يدوية (يستعملها زرّ إعادة المحاولة في نافذة التفصيل). */
  refresh: () => void;
};

type CostState = {
  cost: ConversationCost | null;
  status: ConversationCostStatus;
};

const EMPTY_STATE: CostState = { cost: null, status: 'idle' };

export function useConversationCost(
  sessionId: string | null | undefined,
  options: { isLoading?: boolean; historyReady?: boolean } = {},
): UseConversationCostResult {
  const { isLoading, historyReady } = options;
  const [state, setState] = useState<CostState>(EMPTY_STATE);

  const mountedRef = useRef(true);
  const controllerRef = useRef<AbortController | null>(null);
  // عدّاد الطلبات: ردٌّ لمحادثة سابقة (أو لطلب سبقه أحدث) يُهمَل بدل أن يكتب
  // كلفة محادثة على أخرى.
  const requestRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      controllerRef.current?.abort();
      controllerRef.current = null;
    };
  }, []);

  const fetchCost = useCallback(async () => {
    if (!sessionId) return;

    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const isStale = () => !mountedRef.current || requestRef.current !== requestId;

    setState((previous) => ({ ...previous, status: 'loading' }));

    try {
      const response = await authenticatedFetch(
        `/api/providers/costs/session/${encodeURIComponent(sessionId)}`,
        { signal: controller.signal },
      );
      if (isStale()) return;

      if (!response.ok) {
        // فشل تحديث لقطة موجودة لا يمحو آخر رقم معلوم. حالة الطلب `error`
        // تجعل العرض يصفها بالقديمة، بينما أول طلب فاشل يبقى بلا كلفة.
        setState((previous) => ({ cost: previous.cost, status: 'error' }));
        return;
      }

      const body = (await response.json()) as { success?: boolean; cost?: ConversationCost };
      if (isStale()) return;

      if (body?.success && body.cost) {
        setState({ cost: body.cost, status: 'success' });
      } else {
        setState((previous) => ({ cost: previous.cost, status: 'error' }));
      }
    } catch (error) {
      if (isStale()) return;
      if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
        return;
      }
      setState((previous) => ({ cost: previous.cost, status: 'error' }));
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
      }
    }
  }, [sessionId]);

  // تبدُّل المحادثة: تصفير فوري ثم جلب. التصفير ضروري كي لا تُقرأ كلفة
  // المحادثة السابقة لحظةً على رأس المحادثة الجديدة.
  useEffect(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setState(EMPTY_STATE);
    if (!sessionId) {
      // إبطال أي طلب طائر يخصّ محادثة أُغلقت.
      requestRef.current += 1;
      return;
    }
    void fetchCost();
    return () => {
      controllerRef.current?.abort();
      controllerRef.current = null;
      requestRef.current += 1;
    };
  }, [sessionId, fetchCost]);

  // هبوط البثّ أو اكتمال استرجاع التاريخ يعني أن لقطةً أحدث قد أصبحت جاهزة.
  // المحفّزان في effect واحد عمداً: قد يقعان في التصيير نفسه بعد reload، وعندها
  // يكفي طلب واحد بدل طلبين يلغي ثانيهما الأول بلا فائدة.
  const wasLoadingRef = useRef(Boolean(isLoading));
  const wasHistoryReadyRef = useRef(Boolean(historyReady));
  useEffect(() => {
    const wasLoading = wasLoadingRef.current;
    const wasHistoryReady = wasHistoryReadyRef.current;
    wasLoadingRef.current = Boolean(isLoading);
    wasHistoryReadyRef.current = Boolean(historyReady);
    const streamCompleted = wasLoading && !isLoading;
    const historyCompleted = !wasHistoryReady && Boolean(historyReady);
    if (streamCompleted || historyCompleted) {
      void fetchCost();
    }
  }, [isLoading, historyReady, fetchCost]);

  const refresh = useCallback(() => {
    void fetchCost();
  }, [fetchCost]);

  return { cost: state.cost, status: state.status, refresh };
}

export default useConversationCost;

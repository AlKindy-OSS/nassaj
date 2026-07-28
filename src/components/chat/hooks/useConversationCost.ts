/**
 * useConversationCost — كلفة المحادثة المفتوحة من `GET /api/providers/costs/session/:id`.
 *
 * لا استطلاع دوري: الكلفة لا تتغيّر إلا حين يردّ النموذج، فالجلب مرّة عند
 * تبدُّل المحادثة ثم عند **هبوط** البثّ (`isLoading` من true إلى false) يغطّي
 * كل تغيّر حقيقي بطلبين لا بعشرات. الشارة تحتفظ بالرقم القديم أثناء إعادة
 * الجلب (انظر `resolveCostDisplay`) فلا يظهر وميض بعد كل ردّ.
 *
 * أي فشل — شبكة، 404 قبل نشر المسار الخادمي، أو `success:false` — يُترجَم
 * «غير متاحة» لا صفراً؛ اختلاق رقم أسوأ من الاعتراف بالجهل.
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
  options: { isLoading?: boolean } = {},
): UseConversationCostResult {
  const { isLoading } = options;
  const [state, setState] = useState<CostState>(EMPTY_STATE);

  const mountedRef = useRef(true);
  // عدّاد الطلبات: ردٌّ لمحادثة سابقة (أو لطلب سبقه أحدث) يُهمَل بدل أن يكتب
  // كلفة محادثة على أخرى.
  const requestRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const fetchCost = useCallback(async () => {
    if (!sessionId) return;

    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    const isStale = () => !mountedRef.current || requestRef.current !== requestId;

    setState((previous) => ({ ...previous, status: 'loading' }));

    try {
      const response = await authenticatedFetch(
        `/api/providers/costs/session/${encodeURIComponent(sessionId)}`,
      );
      if (isStale()) return;

      if (!response.ok) {
        setState({ cost: null, status: 'error' });
        return;
      }

      const body = (await response.json()) as { success?: boolean; cost?: ConversationCost };
      if (isStale()) return;

      if (body?.success && body.cost) {
        setState({ cost: body.cost, status: 'success' });
      } else {
        setState({ cost: null, status: 'error' });
      }
    } catch {
      if (isStale()) return;
      setState({ cost: null, status: 'error' });
    }
  }, [sessionId]);

  // تبدُّل المحادثة: تصفير فوري ثم جلب. التصفير ضروري كي لا تُقرأ كلفة
  // المحادثة السابقة لحظةً على رأس المحادثة الجديدة.
  useEffect(() => {
    setState(EMPTY_STATE);
    if (!sessionId) {
      // إبطال أي طلب طائر يخصّ محادثة أُغلقت.
      requestRef.current += 1;
      return;
    }
    void fetchCost();
  }, [sessionId, fetchCost]);

  // هبوط البثّ: الردّ اكتمل فالتوكنز كُتبت في السجل — أوان القراءة الوحيد.
  const wasLoadingRef = useRef(Boolean(isLoading));
  useEffect(() => {
    const wasLoading = wasLoadingRef.current;
    wasLoadingRef.current = Boolean(isLoading);
    if (wasLoading && !isLoading) {
      void fetchCost();
    }
  }, [isLoading, fetchCost]);

  const refresh = useCallback(() => {
    void fetchCost();
  }, [fetchCost]);

  return { cost: state.cost, status: state.status, refresh };
}

export default useConversationCost;

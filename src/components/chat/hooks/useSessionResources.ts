/**
 * useSessionResources — ما تستهلكه **هذه المحادثة** وحدها.
 *
 * حالة الجهاز ليست هنا عمداً: مكانها ذيل الشريط الجانبي (`SystemStats`) مع
 * بقيّة تلمترية المضيف. خلط المقياسين في شارة واحدة يجعل رقم الجهاز يُقرأ
 * رقمَ المحادثة، وهو أسوأ من غيابه.
 *
 * خلافاً للكلفة (تتغيّر عند ردّ النموذج فقط، فلا استطلاع لها)، **الموارد تتغيّر
 * كل ثانية بلا حدث يُعلن عنها**: وكيل يفتح متصفّحاً، أو حزمة اختبار تُطلق عاملاً
 * لكل نواة. فالاستطلاع هنا ضرورة لا كسل — لكنه مقيَّد بثلاثة حدود:
 *
 *   1. **كل 7 ثوانٍ** — أبطأ من أن يُثقل، وأسرع من أن يُفوّت انفجاراً.
 *   2. **يتوقّف حين تختفي الصفحة** (`visibilitychange`): تبويب في الخلفية لا
 *      يُقاس له شيء، وقد كان استطلاع تبويبات خاملة سبب عاصفة توكن سابقة.
 *   3. **يتسارع أثناء البثّ** إلى 4 ثوانٍ: لحظة العمل هي لحظة الانفجار.
 *
 * أي فشل — شبكة، أو 404 قبل نشر المسار — يُترجَم «غير متاح» لا صفراً. الصفر
 * يُقرأ «لا تستهلك شيئاً» وهو ادّعاء لا نملكه.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';

export type ResourceKind = 'session' | 'agent' | 'browser' | 'test' | 'build' | 'other';

export type SessionResourceBreakdown = {
  kind: ResourceKind;
  processCount: number;
  memoryMb: number;
};

export type SessionResources = {
  available: boolean;
  rootPid: number | null;
  pidSource: 'registry' | 'scan' | null;
  processCount: number;
  memoryMb: number;
  memorySource: 'pss' | 'rss' | 'mixed';
  cpuPercent: number | null;
  breakdown: SessionResourceBreakdown[];
};

export type UseSessionResourcesResult = {
  resources: SessionResources | null;
  status: 'idle' | 'loading' | 'ready' | 'unavailable';
  refresh: () => void;
};

const IDLE_INTERVAL_MS = 7000;
const ACTIVE_INTERVAL_MS = 4000;

export function useSessionResources(
  sessionId: string | null | undefined,
  options: { isLoading?: boolean } = {},
): UseSessionResourcesResult {
  const { isLoading } = options;
  const [resources, setResources] = useState<SessionResources | null>(null);
  const [status, setStatus] = useState<UseSessionResourcesResult['status']>('idle');

  const mountedRef = useRef(true);
  // عدّاد الطلبات: ردٌّ لمحادثة سابقة يُهمَل بدل أن يكتب أرقام محادثة على أخرى.
  const requestRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const fetchOnce = useCallback(async () => {
    if (!sessionId) return;
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    const isStale = () => !mountedRef.current || requestRef.current !== requestId;

    try {
      const response = await authenticatedFetch(
        `/api/providers/resources/session/${encodeURIComponent(sessionId)}`,
      );
      if (isStale()) return;

      const body = response.ok ? await response.json().catch(() => null) : null;
      if (isStale()) return;

      const nextResources: SessionResources | null = body?.resources ?? null;
      setResources(nextResources);
      setStatus(nextResources ? 'ready' : 'unavailable');
    } catch {
      if (isStale()) return;
      // يُمسح الرقم كما يُمسح في مسار الاستجابة غير الناجحة. تركُه يجعل العين
      // ترى رقماً بائتاً بينما يسمع قارئ الشاشة «غير متاحة» — مساران متناقضان.
      setResources(null);
      setStatus('unavailable');
    }
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) {
      setResources(null);
      setStatus('idle');
      return;
    }

    // تبديل المحادثة يمسح الرقم فوراً. بدونه تعرض شارةُ المحادثة الجديدة رقمَ
    // السابقة دورةَ شبكةٍ كاملة — وهو بعينه العيب الذي فُصلت الشارة عن مؤشّر
    // الجهاز لتفاديه: رقمٌ يُقرأ رقمَ شيء آخر.
    setResources(null);
    setStatus('loading');

    let timer: ReturnType<typeof setInterval> | null = null;

    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };

    const start = () => {
      stop();
      void fetchOnce();
      timer = setInterval(() => void fetchOnce(), isLoading ? ACTIVE_INTERVAL_MS : IDLE_INTERVAL_MS);
    };

    const onVisibility = () => {
      if (typeof document !== 'undefined' && document.hidden) stop();
      else start();
    };

    if (typeof document === 'undefined' || !document.hidden) start();
    document?.addEventListener?.('visibilitychange', onVisibility);

    return () => {
      stop();
      document?.removeEventListener?.('visibilitychange', onVisibility);
    };
  }, [sessionId, isLoading, fetchOnce]);

  return { resources, status, refresh: () => void fetchOnce() };
}

export default useSessionResources;

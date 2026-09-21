/**
 * useSessionActiveModel.ts — T-1028 / B-249
 *
 * يجلب النموذج الفعّال للجلسة من:
 *   GET /api/providers/:provider/sessions/:sessionId/active-model
 * ويوفّر `setDisplayModel` للتحديث التفاؤلي الفوري ثم المصالحة مع ردّ الخادم.
 *
 * ## لماذا هذا الـhook؟ (B-249)
 * `sessionCurrentModel` السابق كان يشتقّ العرض من الحالة العامة (claudeModel /
 * codexModel / …) المفهرَسة بـ displayProvider. لكن الحالة العامة لا تعكس
 * النموذج المخزَّن لكل جلسة — `resolveResumeModel` يقرأه من متجر الخادم، لذا
 * جلسة بُدِّلت إلى X تعرض Y في المبدّل بعد remount بينما الاستئناف يستعمل X فعلاً.
 *
 * ## سلوك حالات الفشل (مقصود وموثَّق)
 * • بلا sessionId      → يعرض `fallbackModel` (قيمة المنتقي العام) بلا جلب.
 *                        الدور الأول سيطبّق هذا النموذج ويُنشئ الجلسة.
 * • 404 SESSION_NOT_FOUND → يعرض `fallbackModel`؛ الجلسة الجديدة لا تملك
 *                        تجاوزاً مخزَّناً بعد — الخادم لا يميّز «غير موجود» عن
 *                        «غير مأذون» عمداً (provider.routes.ts).
 * • خطأ شبكة          → يعرض `fallbackModel` مع تحذير console — لا قيمة مختلقة
 *                        ولا إسقاط صامت للمبدّل. الجلبة التالية (عند تغيّر
 *                        sessionId/provider) ستصحّح الحالة.
 *
 * ## ما هو مستثنى من deps array
 * `fallbackModel` مستثنى قصداً من `useEffect` deps الأول:
 * لا نريد إعادة الجلب عند كل تغيير في المنتقي العام (حذف مفتاح، سكرول القائمة).
 * `fallbackModel` يُستعمل في حالة بلا sessionId فقط — معالج في effect منفصل.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { authenticatedFetch } from '../../../utils/api';

interface ActiveModelApiResponse {
  success: boolean;
  data?: {
    provider: string;
    sessionId: string;
    /** مضمون غير فارغ دائماً — من مواصفة الـendpoint. */
    model: string;
    source: 'session-override' | 'provider-current';
    supported: boolean;
    changed: boolean;
  };
}

export interface UseSessionActiveModelResult {
  /**
   * النموذج الفعّال للعرض:
   * - من الخادم إن توفّر sessionId وأُنجز الجلب.
   * - من `fallbackModel` (المنتقي العام) إن لا sessionId أو فشل الجلب.
   */
  displayModel: string;
  /**
   * يضبط `displayModel` مباشرة:
   * - استدعاء تفاؤلي فور اختيار المستخدم نموذجاً (قبل ردّ الخادم).
   * - استدعاء تأكيدي بعد عودة ردّ POST من الخادم (مصالحة).
   * - استدعاء للتراجع عند فشل POST.
   */
  setDisplayModel: (model: string) => void;
  /** صحيح أثناء أول جلب عند تغيّر الجلسة/المزوّد. */
  isLoading: boolean;
  /**
   * صحيح حين تملك الجلسة تثبيتاً صريحاً للنموذج (B-252).
   * مشتقّ من حقل `changed` في ردّ GET.
   * يُعاد ضبطه `false` تلقائياً عند تغيّر الجلسة أو مسح التثبيت.
   */
  changed: boolean;
  /**
   * يُستدعى بعد مسح تثبيت الجلسة (DELETE endpoint) — يُحدِّث `displayModel`
   * ويُعيد `changed` إلى `false` بلا جلب شبكي إضافي. B-252
   */
  resetOverride: (model: string) => void;
}

export function useSessionActiveModel(
  provider: string,
  sessionId: string | null | undefined,
  fallbackModel: string,
): UseSessionActiveModelResult {
  const [displayModel, setDisplayModel] = useState<string>(fallbackModel);
  const [isLoading, setIsLoading] = useState(false);
  const [changed, setChanged] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  /** يُعيد ضبط الحالة بعد مسح تثبيت الجلسة — بلا جلب. */
  const resetOverride = useCallback((model: string) => {
    setDisplayModel(model);
    setChanged(false);
  }, []);

  // Effect-1: جلب من الخادم عند تغيّر الجلسة أو المزوّد
  useEffect(() => {
    const sid = typeof sessionId === 'string' ? sessionId.trim() : '';

    if (!sid || !provider) {
      // لا sessionId → عرض المنتقي العام فوراً بلا جلب
      setDisplayModel(fallbackModel);
      setIsLoading(false);
      setChanged(false);
      return;
    }

    // إلغاء أي جلبة سابقة (تغيّر سريع في الجلسة)
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setIsLoading(true);
    // reset changed while loading so the «clear» button hides during transitions
    setChanged(false);

    const url = `/api/providers/${encodeURIComponent(provider)}/sessions/${encodeURIComponent(sid)}/active-model`;

    authenticatedFetch(url, { signal: controller.signal } as RequestInit)
      .then(async (response: Response) => {
        if (controller.signal.aborted) return;

        if (!response.ok) {
          // 404 SESSION_NOT_FOUND أو أي خطأ آخر:
          // لا نختلق قيمة — نعرض المنتقي العام ونتوقف.
          setDisplayModel(fallbackModel);
          // changed stays false (set at effect start)
          return;
        }

        const body = (await response.json()) as ActiveModelApiResponse;
        if (controller.signal.aborted) return;

        if (body.success && body.data?.model) {
          setDisplayModel(body.data.model);
          setChanged(body.data.changed === true);
        } else {
          // ردّ غير متوقّع: احتياط بالمنتقي العام
          setDisplayModel(fallbackModel);
          // changed stays false
        }
      })
      .catch((err: unknown) => {
        if ((err as Error)?.name === 'AbortError') return;
        // خطأ شبكة: تحذير صريح، لا قيمة مختلقة
        console.warn('[useSessionActiveModel] fetch error:', (err as Error)?.message ?? err);
        setDisplayModel(fallbackModel);
        // changed stays false
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false);
      });

    return () => {
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, sessionId]);
  // ^ fallbackModel مستثنى قصداً — انظر التعليق في رأس الملف.

  // Effect-2: بلا sessionId → تتبّع المنتقي العام في الوقت الفعلي
  useEffect(() => {
    const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!sid) {
      setDisplayModel(fallbackModel);
      setChanged(false);
    }
  }, [fallbackModel, sessionId]);

  return { displayModel, setDisplayModel, isLoading, changed, resetOverride };
}

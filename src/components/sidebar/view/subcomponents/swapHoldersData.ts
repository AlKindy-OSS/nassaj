/**
 * swapHoldersData — عقد `GET /api/system/swap-holders` وجلبه.
 *
 * منفصل عن `SwapHoldersPanel.tsx` كي يبقى ملف المكوّن مصدِّراً لمكوّناتٍ فقط
 * (شرط `react-refresh`)، وكي لا يسكن منطقُ الجلب داخل عرضٍ محض — نفس تقسيم
 * `systemStatsFormat` المجاور.
 */
import { useEffect, useState } from 'react';

import { authenticatedFetch } from '../../../../utils/api';

import type { TmpfsEntry } from './systemStatsFormat';

/** عمليةٌ تحمل صفحاتٍ في الـswap، كما يرسلها `GET /api/system/swap-holders`. */
export type SwapHolder = {
  pid: number;
  /** ‏**نصٌّ تكتبه العملية نفسها وغير موثوق** — يُعرض نصّاً عادياً لا أكثر. */
  name: string;
  kind?: string;
  /** قد يكون `null` حين تعذّر نسب العملية إلى مشروع. */
  project?: string | null;
  swapMb: number;
  /** `vmswap` = مجموعٌ قد يَعدّ الصفحة المشتركة بين عمليتين مرّتين. */
  swapSource?: string;
  ageHours?: number;
};

export type SwapHoldersPayload = {
  available: boolean;
  measuredAt?: number;
  swapUsedMb?: number;
  swapCachedMb?: number;
  holders?: SwapHolder[];
  system?: { count: number; swapMb: number } | null;
  unattributedMb?: number;
  tmpfs?: TmpfsEntry[];
};

export type SwapHoldersState = {
  status: 'idle' | 'loading' | 'ready' | 'error';
  data: SwapHoldersPayload | null;
};

/** ما دون هذا العمر يُعاد عرضه من المحفوظ بلا طلبٍ جديد. */
export const SWAP_HOLDERS_STALE_MS = 30_000;

/**
 * يجلب تفصيل حاملي الـswap **عند الفتح وحده**.
 *
 * لا يُلحَق باستطلاع الخمس ثوانٍ عمداً: القراءة تمسح `/proc` لكلّ عملية، وهي
 * كلفةٌ تُدفع حين ينظر أحدٌ إليها لا كلّ خمس ثوانٍ للأبد. وإعادة الفتح خلال
 * ثلاثين ثانية تعرض المحفوظ — الأرقام لم تتغيّر بما يستحقّ مسحاً ثانياً.
 */
export function useSwapHolders(open: boolean): SwapHoldersState {
  const [state, setState] = useState<SwapHoldersState>({ status: 'idle', data: null });
  // اللقطة الأخيرة مع لحظة وصولها. ساعة الخادم قد تنحرف عن ساعة المتصفّح،
  // فالبيانات تُعدّ بائتةً إن دلّ **أيٌّ** من الزمنين على ذلك — انحرافٌ يجمّد
  // اللوحة على لقطة قديمة أسوأ من طلبٍ زائد.
  const [cache, setCache] = useState<{ data: SwapHoldersPayload; fetchedAt: number } | null>(null);

  useEffect(() => {
    if (!open) return;

    const now = Date.now();
    if (
      cache !== null &&
      now - cache.fetchedAt <= SWAP_HOLDERS_STALE_MS &&
      (typeof cache.data.measuredAt !== 'number' ||
        now - cache.data.measuredAt <= SWAP_HOLDERS_STALE_MS)
    ) {
      setState({ status: 'ready', data: cache.data });
      return;
    }

    const controller = new AbortController();
    let cancelled = false;

    setState(prev => ({ status: 'loading', data: prev.data }));

    (async () => {
      try {
        const res = await authenticatedFetch('/api/system/swap-holders', {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as SwapHoldersPayload;
        if (cancelled) return;
        setCache({ data, fetchedAt: Date.now() });
        setState({ status: 'ready', data });
      } catch {
        // الإلغاء عند الإغلاق يمرّ من هنا أيضاً — ولهذا الحارس قبل أيّ setState.
        if (!cancelled) setState({ status: 'error', data: null });
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
    // `cache` عمداً خارج التبعيات: هو مُدخَلٌ يُقرأ عند الفتح لا محفّزٌ لإعادة
    // الجلب، وإدراجه يُطلق الأثر على نتيجة الجلب نفسها فيدور.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return state;
}


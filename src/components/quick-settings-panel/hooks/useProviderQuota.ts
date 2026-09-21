import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '../../../utils/api';
import {
  nextQuotaTickMs,
  resolveQuotaWindows,
  type ProviderQuotaPayload,
  type QuotaWindowView,
} from '../providerQuotaHelpers';

export type ProviderQuotaState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: ProviderQuotaPayload }
  /** لا مصدر لهذا المزوّد (‏404) — جوابٌ صريح لا خطأ، والسطح يصمت. */
  | { status: 'none' }
  /**
   * الخادم حسم أن هذا النموذج يُفوتَر على **حساب Claude** — جوابٌ صريح يجب أن
   * يُميَّز عن «لا نعرف»: بلا هذا التمييز يعرض السطح نوافذ Anthropic كملاذٍ عند
   * أي تعذّر، وهو الرقم الخاطئ نفسه الذي جاء بلاغ 2026-07-30 عنه.
   */
  | { status: 'anthropic' }
  | { status: 'error' };

type KeyedProviderQuotaState = {
  requestKey: string;
  state: ProviderQuotaState;
};

/** يطابق TTL الخادم؛ لا نعيد الطلب قبل أن تصبح نتيجة جديدة ممكنة. */
export const PROVIDER_QUOTA_RETRY_MS = 180_000;

/** مزوّدات حصّتها مرتبطة بحسابها مباشرةً، لا بالنموذج البائت في الجلسة. */
const DIRECT_QUOTA_PROVIDERS = new Set(['codex', 'glm']);

/**
 * نوافذ حصّة المزوّد من مصدره الرسمي (‏`/api/providers/:provider/quota`).
 *
 * الجلب **لكل مزوّد على حِدة** بخلاف عقد الدورة: كل مزوّد endpoint مختلف عند
 * صاحبه، فلا حمولةٌ واحدة تجمعهم. ولذلك يلزم هنا ما لم يلزم هناك:
 *  • إلغاء بـ`AbortController` عند تبديل المزوّد أو التفريغ.
 *  • **تصفير الحالة فوراً عند تبديل المزوّد** (‏`status:'loading'` لا إبقاء
 *    حمولة السابق): وإلا ظهرت نسبة codex ثوانيَ على مزوّد آخر — وهو عيب
 *    «القيمة البائتة» الذي منعته المراجعة النقدية صراحةً.
 *
 * لا استقصاء متسارع: الخادم يُكاش 180ث ويوحّد الطلبات المتزامنة. حالات
 * `none/error` فقط تُعاد مرة بعد انقضاء الـTTL كي يلتقط السطح تجديد اعتماد CLI
 * من دون reload يدوي، مع مؤقّت واحد تنظّفه كل إعادة جلب/تبديل/تفريغ.
 */
export function useProviderQuota(
  provider: string | null | undefined,
  /**
   * النموذج الفعّال إن عُرف. يُمرَّر فقط للأجسام الحاملة كي يحلّ الخادم المورّد
   * (`resolveModelVendor` — مصدرٌ واحد للحقيقة): جسم `claude` يشغّل `glm-5.2`
   * ⇒ المورّد glm. أمّا Codex/GLM المباشران فهويتهما تحسم المصدر بلا نموذج.
   */
  activeModel: string | null | undefined,
  enabled: boolean,
): ProviderQuotaState & {
  refetch: () => void;
  windows: QuotaWindowView[];
  plan: string | null;
  isAnthropic: boolean;
} {
  const isDirectProvider = Boolean(provider && DIRECT_QUOTA_PROVIDERS.has(provider));
  // لا يجوز أن يحوّل نموذج Claude بائت طلب Codex/GLM إلى مورّد Anthropic.
  // الحوامل (ومنها جسم claude مع محرّك آخر) تبقي النموذج كي يحسم الخادم المورّد.
  const requestModel = isDirectProvider ? undefined : (activeModel ?? undefined);
  const requestKey = `${provider ?? ''}\u0000${requestModel ?? ''}`;
  const [snapshot, setSnapshot] = useState<KeyedProviderQuotaState>({
    requestKey: '',
    state: { status: 'idle' },
  });
  const abortRef = useRef<AbortController | null>(null);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  const fetchQuota = useCallback(async () => {
    if (!provider) {
      setSnapshot({ requestKey, state: { status: 'none' } });
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    // تصفير صريح لا احتفاظ بحمولة المزوّد السابق.
    setSnapshot({ requestKey, state: { status: 'loading' } });

    try {
      const response = await api.providers.providerQuota(provider, {
        signal: controller.signal,
        model: requestModel,
      });
      if (controller.signal.aborted) return;

      if (response.status === 404) {
        // نُفرِّق بين «هذا حساب Claude» و«لا مصدر» بالكود لا بالحالة.
        let code: string | null = null;
        try {
          const body = (await response.json()) as { code?: string };
          code = body?.code ?? null;
        } catch {
          code = null;
        }
        if (controller.signal.aborted) return;
        setSnapshot({
          requestKey,
          state: {
            status:
              code === 'PROVIDER_QUOTA_ANTHROPIC'
                ? isDirectProvider
                  ? 'error'
                  : 'anthropic'
                : 'none',
          },
        });
        return;
      }
      if (!response.ok) {
        setSnapshot({ requestKey, state: { status: 'error' } });
        return;
      }

      const body = (await response.json()) as Partial<ProviderQuotaPayload>;
      if (controller.signal.aborted) return;

      // عقدٌ بلا مصفوفة نوافذ مكسور: يُعامل «لا نعرف» لا «صفر نوافذ».
      if (!Array.isArray(body?.windows)) {
        setSnapshot({ requestKey, state: { status: 'error' } });
        return;
      }

      // لا نعرض أبداً حمولة مزوّد آخر على سطح direct provider. غياب الحقل
      // متوافق رجعياً، أمّا التناقض الصريح ففشلٌ قابل للتعافي بعد TTL.
      if (
        isDirectProvider &&
        typeof body.provider === 'string' &&
        body.provider.toLowerCase() !== provider.toLowerCase()
      ) {
        setSnapshot({ requestKey, state: { status: 'error' } });
        return;
      }

      setSnapshot({
        requestKey,
        state: {
          status: 'success',
          data: {
            provider: typeof body.provider === 'string' ? body.provider : provider,
            plan: typeof body.plan === 'string' ? body.plan : null,
            windows: body.windows,
            ...(body.extraUsageCredits &&
              typeof body.extraUsageCredits === 'object' &&
              typeof body.extraUsageCredits.balance === 'number' &&
              Number.isFinite(body.extraUsageCredits.balance) &&
              body.extraUsageCredits.balance >= 0 &&
              typeof body.extraUsageCredits.unlimited === 'boolean'
              ? {
                  extraUsageCredits: {
                    balance: body.extraUsageCredits.balance,
                    unlimited: body.extraUsageCredits.unlimited,
                  },
                }
              : {}),
            observedAt: typeof body.observedAt === 'string' ? body.observedAt : undefined,
          },
        },
      });
      setNowMs(Date.now());
    } catch {
      if (controller.signal.aborted) return;
      setSnapshot({ requestKey, state: { status: 'error' } });
    }
  }, [provider, isDirectProvider, requestKey, requestModel]);

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }
    fetchQuota();
    return () => {
      abortRef.current?.abort();
    };
  }, [enabled, fetchQuota]);

  // ربط الحالة بمفتاح الطلب يمنع ظهور نوافذ المزوّد/النموذج السابق في render
  // المتزامن الذي يسبق تشغيل effect التبديل.
  const state = useMemo<ProviderQuotaState>(
    () =>
      !enabled
        ? { status: 'idle' }
        : snapshot.requestKey === requestKey
          ? snapshot.state
          : { status: 'loading' },
    [enabled, requestKey, snapshot],
  );

  // تعافٍ محافظ بعد TTL الخادم للحالات التي قد تتغيّر بعد تجديد اعتماد CLI.
  useEffect(() => {
    if (!enabled || (state.status !== 'none' && state.status !== 'error')) return undefined;
    const timer = window.setTimeout(fetchQuota, PROVIDER_QUOTA_RETRY_MS);
    return () => window.clearTimeout(timer);
  }, [enabled, fetchQuota, requestKey, state.status]);

  const windows = useMemo(
    () => (state.status === 'success' ? resolveQuotaWindows(state.data, nowMs) : []),
    [state, nowMs],
  );

  // مؤقّت واحد إلى لحظة نقصان أقرب أفق — لا استقصاء، ولا عدّاد ساكن في تبويب
  // مفتوح («تُصفَّر بعد ساعتين» يبقى ساعتين إلى الأبد بلا هذا).
  useEffect(() => {
    if (windows.length === 0) return undefined;
    const tick = nextQuotaTickMs(windows, nowMs);
    if (tick === null) return undefined;
    const delay = Math.max(1_000, tick - nowMs);
    const timer = window.setTimeout(() => setNowMs(Date.now()), delay);
    return () => window.clearTimeout(timer);
  }, [windows, nowMs]);

  return {
    ...state,
    windows,
    plan: state.status === 'success' ? state.data.plan : null,
    /** الخادم أكّد أن الفوترة على حساب Claude (فيتولّاه مسار حصّة كلود). */
    isAnthropic: state.status === 'anthropic',
    refetch: fetchQuota,
  };
}

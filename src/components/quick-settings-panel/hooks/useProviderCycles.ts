import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../../../utils/api';
import type { ProviderCycleRow } from '../providerCycleHelpers';

/**
 * حصار حصةٍ نافدة لمزوّد (T-1191): موعد التجدّد ونصّ المزوّد الذي أعلنه.
 *
 * ليس نسبة استهلاك ولا رصيداً متبقياً — agy لا يُصدِّر شيئاً من ذلك. هو حدثُ
 * ارتطامٍ بالسقف ومهلةُ الخروج منه، وهذا كل ما في الوجود منه.
 */
export type ProviderQuotaBlock = {
  provider: string;
  /** ISO-8601 */
  resetsAt: string;
  reason: string;
};

export type ProviderCyclesState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; rows: ProviderCycleRow[]; quotaBlocks: ProviderQuotaBlock[] }
  | { status: 'error' };

type UseProviderCyclesResult = ProviderCyclesState & {
  refetch: () => void;
};

/**
 * دورة الفوترة لكل مزوّد — الطبقة العميلية لـ`GET /api/providers/costs/cycle`.
 *
 * **بديلٌ عن `useSubscriptionCosts` في السطوح دائمة الظهور، لا غلافٌ حوله.**
 * ذاك يقرأ سجلات المحادثات لنافذة الدورة كاملة (مقيس: ~14 ثانية لكل نداء على
 * القاعدة الحيّة، و54 ثانية لكلٍّ من أربعة متزامنة) ولهذا هو موثَّق بأنه «لا
 * يُستقصى» ومُبوَّب على «اللوحة مفتوحة والقسم موسَّع». والشريط العلوي ظاهرٌ
 * دائماً، فوصله بذلك المسار كان فيتو المراجعة النقدية. هذا الـendpoint لا يقرأ
 * سجلاً واحداً (‏742ms بارداً، ‏0ms دافئاً) ولا يحمل مبلغاً.
 *
 * **لا استقصاء دورياً:** الدورة تتحرّك مرّة في الشهر. الجلب مرّة عند التفعيل،
 * والخادم يُكاش 60 ثانية ويوحّد الطلبات المتزامنة (‏single-flight)، فتحميلُ
 * صفحةٍ بعدة مشاهدين لا يُضاعف شيئاً.
 *
 * **الإلغاء لا الإسقاط:** الطلب المعلّق يُلغى بـ`AbortController` عند التفريغ
 * أو عند إعادة الجلب. النسخة الأولى في `useSubscriptionCosts` تُسقط الردّ
 * المتأخّر بمعرّف طلب وتترك العمل الخادمي يكتمل مهدوراً — وهو ما لا يجوز
 * تكراره على سطحٍ يُعاد تركيبه مع كل تبديل.
 *
 * **لا قيمة بائتة عبر التبديل:** الحمولة تحمل كل المزوّدات مرّة واحدة، والسطح
 * يقرأ صفَّه منها بالبحث (‏`findCycleRow`) — فتبديل المزوّد لا يُطلق طلباً ولا
 * يُبقي رقم المزوّد السابق معروضاً لحظةً واحدة.
 */
export function useProviderCycles(enabled: boolean): UseProviderCyclesResult {
  const [state, setState] = useState<ProviderCyclesState>({ status: 'idle' });
  const abortRef = useRef<AbortController | null>(null);

  const fetchCycles = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setState((previous) => (previous.status === 'success' ? previous : { status: 'loading' }));

    try {
      const response = await api.providers.providerCycles({ signal: controller.signal });
      if (controller.signal.aborted) return;

      if (!response.ok) {
        setState({ status: 'error' });
        return;
      }

      const body = (await response.json()) as { cycles?: unknown; quotaBlocks?: unknown };
      if (controller.signal.aborted) return;

      // حمولة بلا المصفوفة عقدٌ مكسور لا «حساب بلا اشتراكات»: عرضها كقائمة
      // فارغة يقول «لا دورة لأي مزوّد» وهو ادّعاء لا نملكه. نفس قاعدة
      // `useSubscriptionCosts`.
      if (!Array.isArray(body?.cycles)) {
        setState({ status: 'error' });
        return;
      }

      // T-1191: ‏`quotaBlocks` **اختياري** بخلاف `cycles` — وهذا فرقٌ مقصود لا
      // تساهل. الدورة عقدٌ قائم منذ ADR-081 فغيابها عطب، أمّا حصار الحصة فحقلٌ
      // أحدث قد يخاطب العميلُ خادماً أقدم منه (نشر الواجهة يسبق نشر الخادم في
      // هذا المستودع بحكم أن build:client وحده لا يحتاج restart). فغيابه يُقرأ
      // «لا حصار» لا «حمولة مكسورة»، وقيمةٌ ليست مصفوفة تُهمَل بالمثل.
      const quotaBlocks = Array.isArray(body?.quotaBlocks)
        ? (body.quotaBlocks as ProviderQuotaBlock[])
        : [];

      setState({ status: 'success', rows: body.cycles as ProviderCycleRow[], quotaBlocks });
    } catch {
      // الإلغاء ليس خطأً: تفريغ المكوّن أو إعادة جلب لا يجوز أن يُظهر حالة خطأ.
      if (controller.signal.aborted) return;
      setState({ status: 'error' });
    }
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    fetchCycles();
    return () => {
      abortRef.current?.abort();
    };
  }, [enabled, fetchCycles]);

  return { ...state, refetch: fetchCycles };
}

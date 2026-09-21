/**
 * دورة الفوترة لكل مزوّد — **بلا أي مسح للسجلات**.
 *
 * لماذا خدمة منفصلة عن `getSubscriptionCosts`؟ مقيس، لا مفترَض: نداء
 * `GET /costs/subscriptions` يستغرق ~14 ثانية في كل مرّة (ثلاث نداءات متتالية
 * على القاعدة الحيّة: 15.2/13.9/13.9ث، وأربعة متوازية 54ث لكل واحد) لأنه يقرأ
 * سجلات المحادثات من القرص لنافذة الدورة كاملة — 230 ملفاً / ~692MB هنا —
 * وكاشه الداخلي يرتطم بسقفه (‏LRU 512 مقابل ~690 مدخلاً لثلاث نوافذ). ولهذا
 * هوكه العميلي موثَّق بأنه «لا يُستقصى» ومُبوَّب على «اللوحة مفتوحة والقسم
 * موسَّع».
 *
 * والشريط العلوي **ظاهر دائماً**. فوصله بذلك المسار يعني 14 ثانية من مسح قرص
 * على كل تحميل صفحة ولكل مشاهد — وهو فيتو المراجعة النقدية (‏N1).
 *
 * أمّا **الدورة** فرخيصة: `subscriptionConfigService.listActive` لا يقرأ سجلاً
 * واحداً — فحص مصادقة مُكاش بTTL، ومرساة من مصدر الاشتراك نفسه (‏JWT كودكس /
 * ‏.claude.json)، ثم حساب نافذة تقويمي صِرف. هذه الخدمة تكشف ذلك الجزء وحده.
 *
 * **ما لا تُعيده هذه الخدمة مقصودٌ كالذي تُعيده:** لا مبالغ ولا `metered` ولا
 * `available/reason`. المبلغ في هذا العقد كان سيكون كذبةً في الشريط: لاشتراك
 * ثابت (‏`metered=false`) المبلغ «قيمة مكافئة بأسعار API لا مالٌ مفوتَر» بنصّ
 * العقد، وسطرٌ في هيدر لا يتّسع لهذا التحفّظ ولا لختم `pricesAsOf` يُقرأ فاتورة.
 *
 * `anchorSource` يُمرَّر كما هو ولا يُطبَّع: القرار «هل يُعرض موعد التجديد
 * أصلاً» يُبنى عليه (‏`unknown`/`derived` = تقدير لا واقعة)، وطبعُه هنا يُنتج
 * موعداً مختلقاً في الواجهة.
 */

import {
  resolveBillingCycle,
  subscriptionConfigService,
  type SubscriptionDeps,
} from '@/modules/providers/services/cost/subscription-config.service.js';
import type { ProviderBillingCycle } from '@/shared/types.js';

/**
 * نافذة الكاش. الدورة تتغيّر مرّة في الشهر والمرساة تُكتشف من ملف على القرص،
 * فستّون ثانية كافية لامتصاص رشقة الإقلاع (هيدر + شريط جانبي مطويّ + عدة
 * مشاهدين) بلا تعليق أي قيمة قد تُقرأ بائتة بما يهمّ.
 */
const CACHE_TTL_MS = 60_000;

/**
 * `SubscriptionDeps` لا يحمل `now` (‏`SessionCostDeps` هو الذي يحمله)، والدورة
 * تُحسَب بلحظةٍ يجب أن تكون قابلة للتثبيت في الاختبار — وإلا صار اختبار «عبور
 * منتصف الليل» رهنَ ساعة المُشغِّل.
 */
export type ProviderCycleDeps = SubscriptionDeps & { now?: () => Date };

type CacheEntry = { at: number; rows: ProviderBillingCycle[] };

// المفتاح يحمل المستخدم: المرساة تُقرأ من جذر اعتمادات المستخدم (‏resolveProviderEnv)،
// فكاشٌ مشترك كان سيُسرّب دورة عضو إلى آخر. نفس سابقة `authCache` في
// subscription-config.service.
const cache = new Map<string, CacheEntry>();

// single-flight: عشرة فحوص مصادقة + قراءات مرساة لا تُكرَّر لأن أربعة طلبات
// وصلت في نفس اللحظة (وهذا بالضبط ما يفعله الهيدر مع الشريط الجانبي عند
// الإقلاع، وما يضاعف كلفة المسار الغالي أربع مرات).
const inFlight = new Map<string, Promise<ProviderBillingCycle[]>>();

const cacheKey = (userId: string | number | null): string => `cycle|${userId ?? ''}`;

async function computeCycles(
  userId: string | number | null,
  deps: ProviderCycleDeps,
): Promise<ProviderBillingCycle[]> {
  const now = deps.now?.() ?? new Date();
  const active = await subscriptionConfigService.listActive(userId, deps);

  return active.map((entry) => {
    const cycle = resolveBillingCycle(entry.anchorDay, now);
    return {
      provider: entry.provider,
      displayName: entry.displayName,
      plan: entry.plan,
      anchorDay: entry.anchorDay,
      anchorSource: entry.anchorSource,
      cycleStart: cycle.start.toISOString(),
      cycleEnd: cycle.end.toISOString(),
    };
  });
}

export const providerCycleService = {
  /**
   * دورة كل مزوّد مُصادَق عليه وغير مخفيّ. المخفيّ يبقى مخفيّاً (‏`listActive`
   * يُرشّحه) — إخفاء المالك لبطاقة قرارٌ لا يُنقَض من سطح آخر.
   *
   * الكاش يعمل **دائماً**، بما في ذلك حين تُحقَن `deps`. النسخة الأولى كانت
   * تتجاوزه عند الحقن كي لا تتسرّب نتيجة محاكاة إلى طلب حقيقي، لكنّ ذلك جعل
   * الكاش نفسه غير قابل للاختبار إلا بمسار غير محقون يقرأ قرص المطوّر — أي
   * اختبارٌ يتعلّق باشتراكه. الحلّ: كاشٌ واحد لا استثناء له، و`__resetCache`
   * بين الحالات (والإنتاج لا يمرّر `deps` أصلاً).
   */
  async list(
    userId: string | number | null = null,
    deps: ProviderCycleDeps = {},
  ): Promise<ProviderBillingCycle[]> {
    const key = cacheKey(userId);
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return cached.rows;
    }

    const pending = inFlight.get(key);
    if (pending) {
      return pending;
    }

    const promise = computeCycles(userId, deps)
      .then((rows) => {
        cache.set(key, { at: Date.now(), rows });
        return rows;
      })
      .finally(() => {
        inFlight.delete(key);
      });

    inFlight.set(key, promise);
    return promise;
  },

  /** للاختبارات: يُفرِّغ الكاش والطلبات المعلّقة. */
  __resetCache(): void {
    cache.clear();
    inFlight.clear();
  },
};

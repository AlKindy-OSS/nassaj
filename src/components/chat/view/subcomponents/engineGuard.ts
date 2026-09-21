/**
 * engineGuard.ts — B-312: حارس محور المحرّك، نقياً وبلا DOM، لكل سطح يعرض نماذج.
 *
 * ## لماذا وحدة مشتركة؟
 * نفس العطل ظهر مرّتين في سطحين: B-261 في `InlineModelSwitcher` (مبدّل شريط
 * المؤلِّف) وB-312 في `CommandResultModal` (لوحة `/models`). في الحالتين
 * السطح يعرض كتالوج الجسد (Claude الرسمي) لجلسة تُنفَّذ على نقطة مورّد
 * (ADR-037: ‏ANTHROPIC_BASE_URL نحو z.ai/Moonshot)، فاختيار المستخدم يكتب
 * معرّف نموذج Claude في تجاوز الجلسة، ويُرسَل في الدور التالي إلى محرّك لا
 * يعرفه — نوبة فاشلة لا تبديلَ نموذج. إبقاء المنطق في كل مكوّن أنتج سطحاً
 * محكوماً وآخر مكشوفاً، فصار مصدره واحداً هنا.
 *
 * ## مصدران للحقيقة، لا واحد
 *   1. **الختم** (`stamp`): ما كُتب لحظة `session_created` في localStorage
 *      (‏T-915/engineProviderSession.ts). أدقّ ما لدينا، لكنه محلّي بالجهاز.
 *   2. **الاستنباط من النموذج** (B-311): الختم يضيع بمتصفّح آخر أو تخزين مُسِح
 *      (‏B-258/B-262 — لا عمود engine في الخادم بعد)، فتبدو الجلسة رسميةً
 *      وحارس الختم ينام. نموذجٌ ليس في كتالوج الجسد لكنه في كتالوج محرّك
 *      مؤهَّل يُثبت المحرّك من البيانات نفسها.
 *
 * ## حدود مقصودة
 * — لا يمنح قدرة تبديل محرّك (B-246 باقية محكومة بعقد إعادة الختم).
 * — أي غموض (كتالوج غير محمَّل، معرّف بائت لا ينتمي لأي كتالوج، جسد غير
 *   claude) يُعيد null فيبقى السلوك كما كان — تفادياً لتقييد زائد (درس B-250).
 */

import {
  ELIGIBLE_ENGINE_PROVIDERS,
  type EligibleEngineProviderId,
} from '../../../../../shared/engineProviders';
import type { LLMProvider, ProviderModelsDefinition } from '../../../../types/app';

/** كتالوجات النماذج لكل مزوّد كما تحملها حالة التطبيق. */
export type ModelCatalogMap = Partial<Record<LLMProvider, ProviderModelsDefinition>>;

/** هل يحوي كتالوج هذا المزوّد معرّف النموذج المعطى؟ */
export function catalogHasModel(
  catalog: ModelCatalogMap,
  provider: LLMProvider,
  model: string,
): boolean {
  return (catalog[provider]?.OPTIONS ?? []).some((option) => option.value === model);
}

/**
 * B-311: يستنبط محرّك الجلسة من النموذج الفعّال حين يغيب الختم.
 *
 * يُعيد معرّف محرّك مؤهَّل فقط حين تتوفّر ثلاثة شروط معاً: الجسد claude، و
 * النموذج **ليس** في كتالوج Claude، وهو في كتالوج محرّك مؤهَّل.
 */
export function inferEngineFromModel(
  provider: string,
  currentModel: string,
  catalog: ModelCatalogMap,
): EligibleEngineProviderId | null {
  if (provider !== 'claude' || !currentModel) return null;
  if (catalogHasModel(catalog, 'claude', currentModel)) return null;
  return (
    ELIGIBLE_ENGINE_PROVIDERS.find((engine) => catalogHasModel(catalog, engine, currentModel)) ??
    null
  );
}

/**
 * المحرّك العامل فعلاً على هذه الجلسة: الختم إن وُجد، وإلا مستنبَطاً من
 * النموذج. غير null ⇒ الجلسة محرَّكة فيُمنع التبديل ويُعلَن السبب.
 *
 * `stamp` نصّ حرّ قادم من التخزين، فيُقبل كما هو حين يكون غير فارغ (تعقيمه
 * وظيفة `sanitizeEngineProviderValue` عند القراءة، لا وظيفة هذا الحارس).
 */
export function resolveEffectiveEngine(
  stamp: string | null | undefined,
  provider: string,
  currentModel: string,
  catalog: ModelCatalogMap,
): string | null {
  const stamped = typeof stamp === 'string' && stamp.trim().length > 0 ? stamp.trim() : null;
  return stamped ?? inferEngineFromModel(provider, currentModel, catalog);
}

/**
 * لصيقة نموذج من كتالوج المحرّك — تُستعمل حين تكون الجلسة محرَّكة فلا يجد
 * السطح صفّ النموذج في كتالوج الجسد ويعرض المعرّف خاماً (ADR-073 §6).
 * تُعيد undefined إن لم يكن الكتالوج محمَّلاً أو النموذج غير موجود فيه.
 */
export function engineModelLabel(
  catalog: ModelCatalogMap,
  engine: string,
  model: string,
): string | undefined {
  return (catalog[engine as LLMProvider]?.OPTIONS ?? []).find(
    (option) => option.value === model,
  )?.label;
}

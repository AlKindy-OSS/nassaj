/**
 * متجر انعكاسي لقيمة `selected-provider` (المزوّد العام المختار).
 *
 * الغرض الوحيد: إتاحة المزوّد العام لأي مكوّن بعيد بلا prop-drilling، تفاعلياً.
 * استخدام اليوم: `HeaderUsageIndicator` يحتاج المزوّد الفعلي
 * (`selectedSession?.__provider ?? globalProvider`) لإخفاء أشرطة حصّة كلود حين لا
 * تكون الجلسة المفتوحة (أو المنتقي العام) كلوداً. قبل هذا المتجر كان الهيدر يقرأ
 * مزوّد الجلسة وحده، فحين لا جلسة مفتوحة تسقط القيمة على `'claude'` افتراضياً
 * داخل `getProviderCapabilities`، فيُظهر الحصّة مع أيّ نموذج آخر.
 *
 * **انعكاسي لا مصدرَ للحقيقة** (قرار ما بعد المراجعة النقدية): المتجر لا يكتب
 * `localStorage` ولا يُوحّد مواقع الكتابة. الكتابة تبقى حيث هي في
 * `useChatProviderState`/`ChatInterface`/`AppContent`/`ProviderSelectionEmptyState`
 * (ومن خلفها يلتقطها `preferencesSync`). كل ما يفعله المتجر هو عكس قيمة React state
 * `provider` الحيّة عبر `setSelectedProvider(provider)` في effect واحد داخل
 * `useChatProviderState`، فتتدفّق أيّ تغييرات (منتقّى، engine، auth fallback، تفضيل
 * خادمي) إلى كل المشتركين تلقائياً. هذا يتجنّب لمس `selectClaudeEngineProvider` أو
 * `preferencesSync` ويمنع حلقات الكتابة. القيمة هنا هي العرض فقط، لا قرار صلاحية.
 *
 * النمط مطابق لـ`workflowStatusStore` (vanilla + `useSyncExternalStore`)؛ القيمة
 * primitive (string) ففحص `Object.is` في `useSyncExternalStore` سليم بلا مشاكِل
 * استقرار مرجعي.
 */

import { useSyncExternalStore } from 'react';

const STORAGE_KEY = 'selected-provider';

function readInitialSnapshot(): string {
  if (typeof window === 'undefined') return 'claude';
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? 'claude';
  } catch {
    return 'claude';
  }
}

let currentSnapshot: string = readInitialSnapshot();

/**
 * محور **المحرّك** (‏ADR-037/T-915) منفصلٌ عن محور الجسم: جلسة جسمها `claude`
 * قد يعمل محرّكها على نقطة z.ai المتوافقة مع Anthropic (‏`glm`) أو moonshot
 * (‏`kimi`). وحينها **تُفوتَر التوكنز على ذلك المورّد لا على اشتراك Anthropic**،
 * فسطح الحصّة يجب أن يتبع المحرّك لا الجسم.
 *
 * ولهذا وُجد هذا الحقل: بلاغ المالك 2026-07-30 بلقطة شاشة تُظهر «C 0% W 0%»
 * (نوافذ حساب Claude) على جلسة تعمل فعلاً على `glm-5.2` — رقمٌ لا علاقة له بما
 * يُستهلك. القيمة `null` = المسار الرسمي (‏Anthropic) وهو الافتراض.
 */
let currentEngineSnapshot: string | null = null;

/**
 * النموذج الفعّال للجلسة المفتوحة (‏`glm-5.2`, `claude-opus-5`…). الدليل
 * **المستقلّ عن الجهاز** على محور المحرّك: ختم المحرّك في `localStorage` لكل
 * متصفّح ولا يُحفَظ خادمياً، فمالكٌ يفتح الجلسة من جوّاله لا ختم عنده — أمّا
 * النموذج فمصدره خادمي (`/active-model`) فيصل كل جهاز. الخادم يحوّله إلى مورّد
 * بـ`resolveModelVendor` (نفس دالّة نظام الكلفة).
 */
let currentActiveModelSnapshot: string | null = null;

const listeners = new Set<() => void>();

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): string {
  return currentSnapshot;
}

function getServerSnapshot(): string {
  return 'claude';
}

/**
 * يحدّث القيمة المنعكسة في المتجر. **لا يكتب localStorage** — الكتابة مسؤولية
 * المصدر (`useChatProviderState`) لا المتجر. يتجنّب التنبيه حين لا تتغيّر القيمة
 * حتى لا يُعاد رسم المشتركين بلا داعٍ.
 */
export function setSelectedProvider(next: string): void {
  const value = next || 'claude';
  if (value === currentSnapshot) {
    return;
  }
  currentSnapshot = value;
  emitChange();
}

/**
 * مزامنة التبويبات: حدث `storage` يُطلَق فقط عبر التبويبات الأخرى؛ نُحدّث snapshot
 * ولا نكتب (التبويب الآخر كتب localStorage بالفعل). إن لم تتغيّر القيمة لا تنبيه.
 */
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) {
      return;
    }
    const value = event.newValue ?? 'claude';
    if (value !== currentSnapshot) {
      currentSnapshot = value;
      emitChange();
    }
  });
}

/**
 * يحدّث محرّك الجلسة المفتوحة المنعكس. `null` = المسار الرسمي.
 *
 * يُغذّى من نفس effect الانعكاس في `useChatProviderState` حيث حالة
 * `engineProvider` مُحلَّةٌ أصلاً بترتيبها الصحيح (ختم الجلسة المفتوحة، وإلا
 * اختيار المنتقي العام للجلسة القادمة).
 */
export function setSelectedEngineProvider(next: string | null): void {
  const value = next && next.trim() ? next : null;
  if (value === currentEngineSnapshot) {
    return;
  }
  currentEngineSnapshot = value;
  emitChange();
}

function getEngineSnapshot(): string | null {
  return currentEngineSnapshot;
}

function getEngineServerSnapshot(): string | null {
  return null;
}

/**
 * محرّك الجلسة المفتوحة (‏`glm`/`kimi`) أو `null` للمسار الرسمي. المستهلك
 * الحسّاس يقدّمه على مزوّد الجسم في كل ما يتعلّق بالفوترة والحصّة.
 */
export function useSelectedEngineProvider(): string | null {
  return useSyncExternalStore(subscribe, getEngineSnapshot, getEngineServerSnapshot);
}

/** يحدّث النموذج الفعّال المنعكس (‏`null` = غير معروف بعد). */
export function setSelectedActiveModel(next: string | null): void {
  const value = next && next.trim() ? next : null;
  if (value === currentActiveModelSnapshot) {
    return;
  }
  currentActiveModelSnapshot = value;
  emitChange();
}

function getActiveModelSnapshot(): string | null {
  return currentActiveModelSnapshot;
}

function getActiveModelServerSnapshot(): string | null {
  return null;
}

/** النموذج الفعّال للجلسة المفتوحة، أو `null` إن لم يُعرَف بعد. */
export function useSelectedActiveModel(): string | null {
  return useSyncExternalStore(subscribe, getActiveModelSnapshot, getActiveModelServerSnapshot);
}

/**
 * للاختبارات فقط: يُعيد اللقطة إلى `'claude'` ويُفرِّغ المشتركين، كي لا تتسرّب
 * حالة حالةِ اختبار إلى التالية (الحالة module-level بطبيعتها). نفس عُرف
 * `__resetWorkflowStatusStore`.
 */
export function __resetSelectedProviderStore(): void {
  resetSelectedProviderIdentityState();
  listeners.clear();
}

/** Clears account-derived provider reflections without detaching live consumers. */
export function resetSelectedProviderIdentityState(): void {
  currentSnapshot = 'claude';
  currentEngineSnapshot = null;
  currentActiveModelSnapshot = null;
  emitChange();
}

if (typeof window !== 'undefined') {
  window.addEventListener('auth:identity-changing', resetSelectedProviderIdentityState);
}

/**
 * قارئة تفاعلية للمزوّد العام الحالي. تُستخدم كاحتياط حين لا توجد جلسة مفتوحة
 * (الحالة الحدّية) — مزوّد الجلسة المفتوحة يبقى مقدَّماً عند وجودها.
 */
export function useSelectedProvider(): string {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

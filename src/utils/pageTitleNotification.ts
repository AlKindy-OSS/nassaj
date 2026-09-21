/**
 * علامة عنوان التبويب — واجهةُ حالةِ المحادثات لمن ليس أمام الشاشة (B-544).
 *
 * **العلامات لاتينيّة عمداً ولا تُترجَم أبداً** (‏T-1294):
 *
 *  • بادئة بلا حرف لاتيني قوي (‏`[!]` مثلاً) تجعل أول حرف قوي في العنوان عربياً،
 *    فينقلب اتجاه العنوان كلّه في RTL وتظهر العلامة في آخره.
 *  • وعلامةٌ مترجَمة تكسر `stripIndicator` عند تبديل اللغة: العلامة الموضوعة
 *    بلغةٍ لا تُنزع بأخرى فتتكدّس البادئات — وهو انحدار مباشر على B-506.
 *
 * ‏**ولا مؤقّت لها** (B-538/B-544): كانت تُوضع لحظة الحدث وتُمسح بعد ثانيتين من
 * حضور المستخدم، فمن كان غائباً — وهو وحده من تعنيه — لم يرها قطّ. صارت
 * إعلانَ حالةٍ قائمة يُشتقّ من `sessionCompletionStore`: تُرفع ما دامت محادثةٌ
 * تنتظر صاحبها، وتزول بفتحها. ولذلك لا تُوضع من طبقة البثّ إطلاقاً — كاتبٌ
 * لحظيٌّ واحد يكفي لينقض حالةً يُفترض بقاؤها.
 */

import type { SessionOutcome } from '../stores/sessionCompletionStore';

/** أيّ حالةٍ تُعلنها العلامة. مطابقة لـ`SessionOutcome`. */
export type TitleIndicatorKind = SessionOutcome;

/** الاسم المعروض حين لا يضبط المالك اسم علامةٍ في الإعدادات. */
export const DEFAULT_PAGE_BRAND = 'ـنسَّاجـ';

let indicatorKind: TitleIndicatorKind | null = null;

const MARKERS: Record<TitleIndicatorKind, string> = {
  question: '[Ask]',
  error: '[Error]',
  done: '[Done]',
};

const getIndicatorPrefix = (kind: TitleIndicatorKind) => `${MARKERS[kind]} `;

const stripIndicator = (title: string): string => {
  for (const marker of Object.values(MARKERS)) {
    const prefix = `${marker} `;
    if (title.startsWith(prefix)) {
      return title.slice(prefix.length);
    }
  }
  return title;
};

/**
 * الكاتب الوحيد للعلامة: يرفعها أو يبدّلها أو يزيلها، بلا مؤقّت ولا انتظار.
 *
 * ‏`null` ⇒ لا محادثة تنتظر شيئاً ⇒ عنوانٌ مجرّد.
 */
export const setTitleOutcome = (kind: TitleIndicatorKind | null): void => {
  if (typeof document === 'undefined') {
    return;
  }
  if (indicatorKind === kind) {
    return;
  }
  indicatorKind = kind;
  const base = stripIndicator(document.title || DEFAULT_PAGE_BRAND);
  document.title = kind ? `${getIndicatorPrefix(kind)}${base}` : base;
};


/**
 * The single writer for the page's BASE title (everything but the marker).
 *
 * Every owner of `document.title` must go through this instead of assigning
 * directly: a direct assignment silently destroys a live marker. When one is
 * active the new base is written with the prefix re-applied, so a background
 * completion stays visible for as long as the state that raised it lasts.
 */
export const setPageBaseTitle = (base: string): void => {
  if (typeof document === 'undefined') {
    return;
  }
  const clean = stripIndicator(base);
  document.title = indicatorKind ? `${getIndicatorPrefix(indicatorKind)}${clean}` : clean;
};

/**
 * العنوان الأساس **جزآن لا سلسلة واحدة**: اسم العلامة (إعداد المالك، من
 * `BrandingContext`) واسم السياق (المشروع المختار، من الشريط الجانبي).
 *
 * العلّة: لكل جزء مالكٌ يعيد تشغيل تأثيره في وقت مختلف. لمّا كان كلاهما يركّب
 * السلسلة كاملةً ويمرّرها إلى `setPageBaseTitle`، كان آخر الكاتبَين يمحو نصيب
 * الآخر — فتأثير الشريط الجانبي كان يكتب `ـنسَّاجـ` مثبَّتاً في الكود فيدهس اسم
 * العلامة المخصّص لحظة اختيار مشروع، وتأثير العلامة يكتب الاسم وحده فيُسقط اسم
 * المشروع. وبتخزين الجزأين هنا يكتب كلٌّ نصيبه فقط، ويُركَّب العنوان من آخر
 * قيمتين معروفتين مهما كان ترتيب التأثيرات.
 */
let brandName: string | null = null;
let contextName: string | null = null;

const normalizeTitlePart = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

const composePageTitle = (): string => {
  const brand = brandName ?? DEFAULT_PAGE_BRAND;
  return contextName ? `${contextName} - ${brand}` : brand;
};

/** اسم العلامة في عنوان التبويب. `null` ⇒ العودة إلى الاسم الافتراضي. */
export const setPageBrandName = (value: string | null | undefined): void => {
  brandName = normalizeTitlePart(value);
  setPageBaseTitle(composePageTitle());
};

/** سياق العنوان (المشروع المختار). `null` ⇒ اسم العلامة وحده. */
export const setPageContextName = (value: string | null | undefined): void => {
  contextName = normalizeTitlePart(value);
  setPageBaseTitle(composePageTitle());
};

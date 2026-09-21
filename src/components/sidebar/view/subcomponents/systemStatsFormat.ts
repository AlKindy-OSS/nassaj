/**
 * systemStatsFormat — دوالّ صياغة ذيل الشريط الجانبي، منفصلة عن المكوّن.
 *
 * ملف مستقلّ كي تُختبر صرفةً ويبقى ملف المكوّن مصدِّراً لمكوّنات فقط
 * (شرط `react-refresh`). نفس تقسيم `conversationResourceFormat` المجاور.
 */

export type TmpfsEntry = { mount: string; usedMb: number; sizeMb: number };

/** ميغابايت إلى نصّ مقروء: دون 1024 بالميغا، وفوقها بالغيغا. */
export function formatMbText(mb: number): string {
  if (!Number.isFinite(mb) || mb < 0) return '—';
  return mb < 1024 ? `${Math.round(mb)}MB` : `${(mb / 1024).toFixed(1)}GB`;
}

/**
 * أثقل مسار يعيش في الذاكرة — واحد يكفي في ذيل ضيّق. ونعرض **الأثقل** لا
 * الأول: الصفّ موجود ليُنذر، فليحمل أسوأ رقم لا أوّل رقم.
 */
export function heaviestTmpfs(entries: TmpfsEntry[] | undefined): TmpfsEntry | null {
  if (!entries || entries.length === 0) return null;
  return entries.reduce((worst, entry) => (entry.usedMb > worst.usedMb ? entry : worst));
}

/**
 * نسبة ما يحجزه مسارٌ يعيش في الذاكرة **من ذاكرة الجهاز كلّها** — لا من سعة
 * المسار نفسها.
 *
 * لماذا المقام هو RAM لا سعة المسار: سعة tmpfs سقفٌ اسمي (5.1GB هنا) لا حجزٌ
 * فعلي، واتّخاذه مقاماً يكذب في اللحظة الحرجة — ‏3.3GB من 5.1GB تُقرأ «64%،
 * وما زال هناك متّسع»، بينما هي في الحقيقة **ثلث ذاكرة الجهاز** وقد أسقطته
 * فعلاً في 29–31 يوليو 2026. المقام الصادق هو ما تنافس عليه: الذاكرة.
 */
export function tmpfsPercentOfRam(usedMb: number, ramTotalMb: number): number | null {
  if (!Number.isFinite(usedMb) || !Number.isFinite(ramTotalMb) || ramTotalMb <= 0) return null;
  return (usedMb / ramTotalMb) * 100;
}

/** نسبة SWAP من القيم الأصلية؛ السعة الغائبة أو غير الصالحة لا تنتج نسبة. */
export function swapPercentOfTotal(usedMb: number, totalMb: number): number | null {
  if (!Number.isFinite(usedMb) || usedMb < 0 || !Number.isFinite(totalMb) || totalMb <= 0) return null;
  const percent = (usedMb / totalMb) * 100;
  return Number.isFinite(percent) ? percent : null;
}

/**
 * نسبة الامتلاء من **سعة المسار نفسه** — للوحة «مَن يحمل الـswap؟».
 *
 * ولماذا المقام هنا سعة المسار بينما هو ذاكرة الجهاز في `tmpfsPercentOfRam`
 * أعلاه: الصفّ في الذيل يجيب «هل يهدّد هذا المسار الجهاز؟» فمقامه الذاكرة،
 * أمّا صفّ اللوحة فيجيب «كم بقي فيه قبل أن يمتلئ ويُفشل الكتابة؟» فمقامه سعته.
 * سؤالان مختلفان، ولكلٍّ مقامه الصادق.
 */
export function tmpfsPercentOfSize(usedMb: number, sizeMb: number): number | null {
  if (!Number.isFinite(usedMb) || !Number.isFinite(sizeMb) || sizeMb <= 0) return null;
  return (usedMb / sizeMb) * 100;
}

/**
 * ‏`/tmp` أوّلاً لا الأثقل: هو جذر حادثة 29–31 يوليو 2026 (بناء وتثبيت داخل
 * ‏tmpfs حجزا 2.7GB خمساً وأربعين ساعة)، فهو أوّل ما يُسأل عنه. وإن غاب من
 * قائمة الخادم رجعنا إلى الأثقل — صفٌّ صادقٌ خيرٌ من لا صفّ.
 */
export function primaryTmpfs(entries: TmpfsEntry[] | undefined): TmpfsEntry | null {
  if (!entries || entries.length === 0) return null;
  return entries.find(entry => entry.mount === '/tmp') ?? heaviestTmpfs(entries);
}

/**
 * مدّة مقروءة بلغة الواجهة: «قبل 41 ساعة»، «قبل 12 دقيقة»، «قبل 4 ثوانٍ».
 *
 * بُنيت على `Intl.RelativeTimeFormat` لا على مفاتيح ترجمة يدوية: العربية ستّ
 * صيغ جمع (ساعة/ساعتين/ثلاث ساعات/41 ساعة…) وكتابتها بيدٍ تُنتج «2 ساعة»
 * حتماً في أوّل حالة منسيّة. والأرقام تُجبَر لاتينيةً (`-u-nu-latn`) لتوافق
 * `tabular-nums` وبقيّة الأرقام في الذيل.
 */
export function formatAgoText(
  ms: number,
  locale: string,
  style: 'long' | 'narrow' = 'long',
): string {
  if (!Number.isFinite(ms)) return '—';
  // ساعةُ الخادم قد تسبق ساعة المتصفّح بثوانٍ؛ «قبل -3 ثوانٍ» كذبةٌ مربكة.
  const elapsed = Math.max(0, ms);
  const seconds = elapsed / 1000;

  const [value, unit]: [number, Intl.RelativeTimeFormatUnit] =
    seconds < 60
      ? [Math.round(seconds), 'second']
      : seconds < 3600
        ? [Math.round(seconds / 60), 'minute']
        : seconds < 3600 * 48
          ? [Math.round(seconds / 3600), 'hour']
          : [Math.round(seconds / 86400), 'day'];

  const tag = locale.startsWith('ar') ? 'ar-u-nu-latn' : locale;
  try {
    return new Intl.RelativeTimeFormat(tag, { numeric: 'auto', style }).format(-value, unit);
  } catch {
    return `${value}${unit[0]}`;
  }
}

/**
 * الصيغة المضغوطة لعمود ضيّق: «قبل ٣٦ س» بدل «قبل ٣٦ ساعة».
 *
 * العمود يزاحم اسم العملية على عرضٍ لا يتجاوز 250 بكسلاً، والاسم أولى بالمساحة
 * — العمر يُقرأ رتبةً (ساعات أم أيام؟) لا رقماً دقيقاً.
 */
export function formatAgoShort(ms: number, locale: string): string {
  return formatAgoText(ms, locale, 'narrow');
}

export type LoadLevel = 'low' | 'medium' | 'high';

/**
 * حالة العتاد في كلمة واحدة — للعرض المطوي.
 *
 * القاعدة: **أسوأ ما فيها يحكم**. متوسّطُ المقاييس يُخفي الحالة الحرجة تماماً؛
 * جهازٌ معالجه خامل وذاكرته على وشك النفاد ليس «متوسّطاً»، بل عالٍ. ولهذا
 * يكفي مقياسٌ واحد ليرفع الحالة.
 *
 * العتبات مشتقّة من الحادثة والقياس لا من الذوق:
 *  • ذاكرة ≥85% مستخدَمة = المتاح دون 15%، وهي عتبة `critical` نفسها خادمياً.
 *  • swap ≥90% = ما قيس فعلاً قبل سقوط 31 يوليو بسبع ساعات (94.8%).
 *  • القرص ≥90% = هامش أقل من 10% للكتابة والبناء والسجلات.
 *  • مسارٌ في الذاكرة ≥10% من RAM = عُشر الجهاز محجوزٌ لا يستردّه النظام.
 *  • معالج ≥90% = إشباع فعلي.
 * وحدود «المتوسّط» أدنى منها بمسافة تكفي للتحرّك قبل الحرج.
 */
export function resolveLoadLevel(input: {
  cpuPercent: number | null | undefined;
  memPercent: number | null | undefined;
  swapUsedMb?: number | null;
  swapTotalMb?: number | null;
  tmpfsPercent?: number | null;
  storagePercent?: number | null;
}): LoadLevel {
  const { cpuPercent, memPercent, swapUsedMb, swapTotalMb, tmpfsPercent, storagePercent } = input;
  const swapPercent =
    typeof swapUsedMb === 'number' && typeof swapTotalMb === 'number' && swapTotalMb > 0
      ? (swapUsedMb / swapTotalMb) * 100
      : null;

  const at = (value: number | null | undefined, limit: number): boolean =>
    typeof value === 'number' && Number.isFinite(value) && value >= limit;

  if (
    at(memPercent, 85) ||
    at(cpuPercent, 90) ||
    at(swapPercent, 90) ||
    at(tmpfsPercent, 10) ||
    at(storagePercent, 90)
  ) {
    return 'high';
  }
  if (
    at(memPercent, 65) ||
    at(cpuPercent, 60) ||
    at(swapPercent, 40) ||
    at(tmpfsPercent, 5) ||
    at(storagePercent, 80)
  ) {
    return 'medium';
  }
  return 'low';
}

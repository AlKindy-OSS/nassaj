/**
 * T-1904 e2e (bug 3) — كاشف أمر «/steer» خالص، مستقلّ عن قائمة الأوامر
 * الديناميكية (`slashCommands`/`steerAvailable`).
 *
 * الخطأ المُصلَح: كان اعتراض «/steer» في handleSubmit يعتمد على إيجاد مدخلة
 * `/steer` داخل `slashCommands` — وهذه المدخلة **لا تُحقَن إلا حين
 * `steerAvailable` (canSteer) صحيح**. فحين تكون الموافقة الشخصية معطَّلة، أو
 * سياسة الخادم `off`، أو الدور لم يعد جارياً، لا توجد مدخلة لمطابقتها،
 * فيسقط النص عبر المسار العام ويُرسَل كرسالة محادثة عادية — وهذا بالضبط ما
 * رصده اختبار المستخدمَين الحقيقي (رُفض بـ«session_busy» بدل رسالة توجيه
 * واضحة). البادئة «/steer» **حجز نحوي دائم** بصرف النظر عن الأهلية: يُعترَض
 * دائماً ويُرسَل كطلب `session-steer` إلى الخادم، الذي يملك وحده معرفة السبب
 * الدقيق (سياسة/موافقة/دور غير جارٍ) عبر `SteerRejectCode`.
 */

export const STEER_PREFIX = '/steer ';

/** النصّ بعد «/steer » بعد إزالة الفراغات المحيطة؛ فارغ إن لم تُطابق البادئة. */
export function parseSteerText(input: string): string {
  if (typeof input !== 'string') {
    return '';
  }
  const leadingTrimmed = input.replace(/^\s+/, '');
  const normalized = leadingTrimmed.toLowerCase();
  return normalized.startsWith(STEER_PREFIX)
    ? leadingTrimmed.slice(STEER_PREFIX.length).trim()
    : '';
}

/** صحيحٌ لأيّ إدخال يبدأ برمز «/steer» — بنصّ بعده أو بلا نصّ (يُعترَض دائماً). */
export function isReservedSteerCommand(input: string): boolean {
  if (typeof input !== 'string') return false;
  const token = input.trimStart().split(/\s/u, 1)[0]?.toLowerCase();
  return token === '/steer';
}

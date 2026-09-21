/**
 * T-1737 — مساعدات مصدر الصورة المضمَّنة في رسائل المساعد.
 *
 * كلّ منطق تصنيف المصدر وتحليل جسم السياج مُجمَّع هنا خارج المكوّنات
 * ليسهل اختباره بشكل معزول.
 */

/**
 * تصنيف مصدر الصورة — يحدّد طريقة الجلب.
 *
 * - 'data'   → data: URL، يُمرَّر كما هو إلى <img>.
 * - 'api'    → /api/... مثل /api/chat-images/...، يُجلب عبر authenticatedFetch.
 * - 'path'   → مسار مطلق محلي، يُعاد توجيهه إلى /api/assistant-images.
 * - 'remote' → http(s)://، معطَّل في المرحلة الأولى (§4 من التصميم).
 * - 'empty'  → مصدر فارغ أو غير معروف → حالة خطأ.
 */
export type ImageSrcKind = 'data' | 'api' | 'path' | 'remote' | 'empty';

/**
 * يصنّف نصّ مصدر الصورة الخام.
 *
 * لا يُنشئ URLات — يقتصر على إعادة تصنيف النوع ليفصل منطق التصنيف
 * عن منطق بناء الـURL (مفيد للاختبار).
 */
export function classifyImageSrc(src: string): ImageSrcKind {
  const s = src.trim();
  if (!s) return 'empty';
  if (s.startsWith('data:')) return 'data';
  if (s.startsWith('/api/')) return 'api';
  if (s.startsWith('http://') || s.startsWith('https://')) return 'remote';
  if (s.startsWith('/')) return 'path';
  // مسارات نسبية وغير معروفة
  return 'empty';
}

/**
 * يحلّل جسم سياج `image` وفق نحو العقد المعتمَد (م-3):
 *
 * ```image
 * <المسار المطلق — أول سطر غير فارغ بعد trim>
 * <caption اختياري — بقية الأسطر>
 * ```
 *
 * - يدعم CRLF وCR وLF.
 * - يتجاهل الأسطر الفارغة قبل المصدر.
 * - `source` فارغ إن لم يوجد أي سطر غير فارغ.
 * - `caption` سلسلة أسطر ما بعد المصدر مفصولة بـ \n (ترتيب المصادق).
 */
export function parseFenceBody(raw: string): { source: string; caption: string } {
  const lines = raw.replace(/\r\n|\r/g, '\n').split('\n').map((l) => l.trim());
  const srcIndex = lines.findIndex((l) => l.length > 0);
  if (srcIndex === -1) return { source: '', caption: '' };
  const source = lines[srcIndex];
  const captionLines = lines.slice(srcIndex + 1).filter((l) => l.length > 0);
  const caption = captionLines.join('\n');
  return { source, caption };
}

/**
 * يبني URL الجلب لمسار مطلق محلي عبر نقطة النهاية المصادَقة.
 *
 * العقد: GET /api/assistant-images?path=<encoded>&session=<sessionId>
 * الخادم يشتق الجذور المسموحة من حالة الجلسة (ح-3).
 */
export function buildAssistantImageUrl(absolutePath: string, sessionId: string): string {
  return `/api/assistant-images?path=${encodeURIComponent(absolutePath)}&session=${encodeURIComponent(sessionId)}`;
}

/**
 * يعيد نصّ الخطأ العربي المناسب لرمز HTTP أو 'network' (جدول العقد).
 *
 * الرسائل محدَّدة في العقد؛ أي رمز خارج القائمة يُعامَل معاملة 500.
 */
export function resolveAssistantImageError(statusOrKind: number | 'network'): string {
  if (statusOrKind === 'network') return 'تعذّر تحميل الصورة';
  switch (statusOrKind) {
    case 400: return 'طلب صورة غير صالح';
    case 403: return 'المسار غير مسموح';
    case 404: return 'الملف غير موجود';
    case 413: return 'الصورة أكبر من الحدّ';
    case 415: return 'نوع غير مدعوم';
    default:  return 'تعذّر تحميل الصورة';
  }
}

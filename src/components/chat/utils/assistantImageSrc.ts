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
 * - 'api'    → مسار صور مصادَق من قائمة السماح (/api/chat-images/ و/api/assistant-images)،
 *              يُجلب عبر authenticatedFetch بتوكن المشاهد.
 * - 'path'   → مسار مطلق محلي، يُعاد توجيهه إلى /api/assistant-images.
 * - 'remote' → أي مخطّط (http:، HTTPS:، javascript:…) أو مضيف نسبي البروتوكول (//host، /\host):
 *              معطَّل، فلا يكشف عرضُ الرسالة عنوانَ المشاهد ولا بياناته لخادم خارجي (B-1667).
 * - 'empty'  → مصدر فارغ أو غير معروف أو /api/ خارج قائمة السماح → حالة خطأ.
 */
export type ImageSrcKind = 'data' | 'api' | 'path' | 'remote' | 'empty';

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
/** `//host` و`\\host` و`/\host` كلها مضيف خارجي بعد تطبيع المتصفح. */
const PROTOCOL_RELATIVE_RE = /^[/\\][/\\]/;
const ENCODED_PATH_TRICK_RE = /\\|%2e|%2f|%5c/i;
const IMAGE_API_PREFIX = '/api/chat-images/';
const ASSISTANT_IMAGE_API = '/api/assistant-images';

/**
 * يطبّع المصدر كما يطبّعه محلّل URL في المتصفح: يحذف TAB وأسطر الجديد أينما
 * وقعت ومحارف التحكّم والمسافات في الطرفين، فلا يمرّ `/\t/evil` على أنه مسار.
 */
export function normalizeImageSrc(src: string): string {
  return src.replace(/[\t\n\r]/g, '').replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, '');
}

/** مسارات /api/ المسموح أن يجلبها عارض الصور بتوكن المشاهد، بلا مقاطع `..` أو ترميز ملتفّ. */
function isAllowedImageApi(source: string): boolean {
  const pathname = source.split(/[?#]/, 1)[0];
  if (ENCODED_PATH_TRICK_RE.test(pathname)) return false;
  if (pathname.split('/').some((segment) => segment === '.' || segment === '..')) return false;
  return pathname === ASSISTANT_IMAGE_API || pathname.startsWith(IMAGE_API_PREFIX);
}

/**
 * يصنّف نصّ مصدر الصورة الخام.
 *
 * لا يُنشئ URLات — يقتصر على إعادة تصنيف النوع ليفصل منطق التصنيف
 * عن منطق بناء الـURL (مفيد للاختبار).
 */
export function classifyImageSrc(src: string): ImageSrcKind {
  const s = normalizeImageSrc(src);
  if (!s) return 'empty';
  if (/^data:/i.test(s)) return 'data';
  if (SCHEME_RE.test(s) || PROTOCOL_RELATIVE_RE.test(s)) return 'remote';
  if (s.startsWith('/api/')) return isAllowedImageApi(s) ? 'api' : 'empty';
  if (s.startsWith('/')) return 'path';
  // مسارات نسبية وغير معروفة
  return 'empty';
}

export type AssistantImageResolution = { ok: true; src: string } | { ok: false; message: string };

/**
 * B-1667: القرار الواحد لكل صورة تعرضها المحادثة — سياج `image` وصورة
 * Markdown العادية `![](…)` معاً — فلا يمرّ مصدر بعيد من أيٍّ منهما.
 */
export function resolveAssistantImage(rawSource: string, sessionId: string | null): AssistantImageResolution {
  const source = normalizeImageSrc(rawSource);
  switch (classifyImageSrc(source)) {
    case 'remote':
      return { ok: false, message: 'الروابط البعيدة معطّلة' };
    case 'empty':
      return { ok: false, message: 'طلب صورة غير صالح' };
    case 'data':
    case 'api':
      return { ok: true, src: source };
    default:
      return sessionId
        ? { ok: true, src: buildAssistantImageUrl(source, sessionId) }
        : { ok: false, message: resolveAssistantImageError(400) };
  }
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

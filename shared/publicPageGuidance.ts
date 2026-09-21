/**
 * publicPageGuidance — المصدر الوحيد لنصّ إرشاد نشر الصفحات العامّة (T-1804).
 *
 * الحادثة: مشغّل/وكيل زرع صفحة هبوط داخل `dist/` فكسر تحديث العقدة
 * (`client_asset_manifest_changed`) ومُحي محتواه عند أوّل تبديل جيل. قرار المالك
 * أنّ العلاج لا يكون في ملفّ تعليماتٍ يحرّره أحد، بل داخل كود نسّاج نفسه: يُشحن
 * مع الحزمة فيصل كلَّ من يحمّلها، ويُعطي الوكيلَ البديلَ الصحيح بدل أن يتركه
 * يبتكر طرقاً خاطئة لا محدودة.
 *
 * ولذلك يعيش هنا **نصٌّ واحد** يخدم قناتين لا ثالثة لهما:
 *   1. الحقن عند الإطلاق — عبر `documentSharingInstructions.ts` إلى كل مزوّد.
 *   2. رسالة الرفض عند الأداة — في قفص Claude التفاعلي.
 * تكرار النصّ بين القناتين يُنتج تناقضاً يقرؤه المستخدم، فمُنع بنيوياً بأن
 * تستوردا الباني نفسه.
 *
 * **الموضعُ وسيطٌ لا ثابت.** `node scripts/…` مسارٌ نسبيّ، وcwd الوكيل هو
 * مشروع المستخدم لا جذر نسّاج؛ وعلى عقدةٍ مثبّتةٍ من الحزمة لا وجود لـ`scripts/`
 * أصلاً (الناشر في `dist-server/UPDATE_RUNTIME_BUNDLE/scripts/`). فالنصّ يُبنى
 * بمسارٍ **مطلقٍ محلولٍ خادميّاً** يختلف بين الأجهزة، وحين لا يوجد ناشرٌ أصلاً
 * يُحقن سطرُ المنع وحده: الإرشادُ إلى أداةٍ غائبة أسوأ من السكوت.
 *
 * الملفّ **نقيّ**: لا `node:` ولا حلَّ مسارٍ ولا قراءةَ قرص، كي يبقى قابلاً
 * للاستيراد من أيّ طبقة. الحلُّ كلُّه في `server/services/public-page-agent-guidance.js`.
 *
 * النصّ **إنجليزي** عمداً: مُحقَنٌ في مطالبة النموذج لا معروضٌ للمستخدم — نفس
 * قاعدة `coordinationDirectives.ts`.
 */

/** وسم الكتلة. مُصدَّر لأنّ تجريد السجلّ القديم يرتكز عليه بنيويّاً لا بمطابقة نصّ. */
export const PUBLIC_PAGE_TAG = 'nassaj_public_pages';

/** اقتباسٌ POSIX لمسارٍ قد يحمل مسافةً أو محرفاً ذا معنى للصَدَفة. */
function quote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** كلُّ ما يختلف بين جهازٍ وجهاز، محلولاً خادميّاً. `null` = غير متاح. */
export interface PublicPagePlace {
  /** مسار الناشر المطلق على هذا الجهاز. */
  publisherPath: string | null;
  /** جذر المحتوى كما حلّه الخادم لنفسه. */
  contentRoot: string | null;
  /** الأصل العام الموثوق (https)، إن كان مضبوطاً وصالحاً. */
  origin?: string | null;
}

/**
 * الأمر الكامل، أو `null` حين ينقص أحد ركنيه.
 *
 * **`--root` ليس زينة.** الوكيل يعمل في عمليةٍ ابنٍ بـ`HOME` و`XDG_DATA_HOME`
 * مُبدَّلين إلى `~/.nassaj-users/<id>` (`resolve-provider-env.js`)، فلو حلّ
 * الناشرُ الجذرَ من بيئته هو لكتب في جذرٍ لا يقرؤه الخادم أبداً: «published»
 * ظاهرياً و404 فعلياً. فيُحقن هنا الجذرُ **المحلول خادميّاً** بعينه.
 *
 * وحين لا جذر (الميزة مطفأة) لا يُبنى أمر: الإرشادُ إلى نشرٍ لن يُخدَم أسوأ من
 * السكوت — وهو نفس منطق غياب الناشر.
 */
export function buildPublicPagePublishCommand(place: PublicPagePlace): string | null {
  if (!place.publisherPath || !place.contentRoot) return null;
  return `node ${quote(place.publisherPath)} publish --site <id> --dir <path> --root ${quote(place.contentRoot)}`;
}

/**
 * سطرُ المنع: الحدّ الأدنى الذي يُحقن دائماً، بناشرٍ أو بغيره. لا يُستنتج سببُه
 * من شيء، وبلا السبب يلتفّ الوكيل حول المنع.
 */
const PROHIBITION_LINE =
  'Never write page, site or user content inside the Nassaj installation tree (dist/, dist-server/): '
  + 'it breaks node updates (client_asset_manifest_changed) and the next generation swap erases it.';

/**
 * سطرُ التمييز عن كتلة `nassaj_document_sharing` المجاورة. الكتلتان متجاورتان في
 * نفس البادئة وكلتاهما تنتهيان برابط، فبلا هذا السطر يخلط الوكيل بينهما. لا
 * يكرّر محتوى الكتلة الأخرى: يشير إليها ويفصل الحالتين بكلماتٍ معدودة.
 */
const DISTINCTION_LINE =
  'This is a public website or landing page for everyone — not the members/client document '
  + 'Share action described above.';

/**
 * أين يُخدَم الناتج. الأصلُ المطلق حين يكون مضبوطاً وموثوقاً — الاختبارُ الأعمى
 * أظهر الوكيل يكتب «https://<نطاق-نسّاج>/…» لأنه لا يعرف الأصل — وإلا فالنصّ
 * النسبيّ كما هو، ولا يُستنتج أصلٌ من رأس الطلب أبداً.
 */
function servedAt(origin: string | null | undefined): string {
  return origin ? `it is served at ${origin}/<id>/` : 'it is served at /<id>/ on this Nassaj origin';
}

/**
 * ثلاثة أسطر بحدٍّ أقصى، وطولُها مقصود ومحسوب — كلفةُ توكناتٍ على كلّ جولة لكلّ
 * مزوّد، فلا تحمل إلا ما لا يُستنتج: التمييزَ عن المشاركة، وموضعَ ملفّات المصدر
 * (الوكيل الأعمى كتبها داخل جذر المحتوى فلوّثه)، والأمرَ بمساره المطلق وأعلامه،
 * وسببَ المنع، وموضعَ الخدمة. ما عداه مطروح.
 */
export function buildPublicPageInstructions(place: PublicPagePlace): string {
  const command = buildPublicPagePublishCommand(place);
  return [
    'Nassaj public page publishing:',
    ...(command
      ? [
        DISTINCTION_LINE,
        `To publish one, write the page files in your own project directory (never under --root) `
        + `and run: ${command} — ${servedAt(place.origin)}.`,
      ]
      : []),
    PROHIBITION_LINE,
  ].join('\n');
}

/** الكتلة الموسومة كما تُحقن في قناة التعليمات الأصيلة لكل مزوّد. */
export function buildPublicPageGuidanceBlock(place: PublicPagePlace): string {
  return `<${PUBLIC_PAGE_TAG}>\n${buildPublicPageInstructions(place)}\n</${PUBLIC_PAGE_TAG}>`;
}

/**
 * رسالة رفض الأداة. ليست تأنيباً: تذكر الأداة المرفوضة والسبب ثمّ **البديل
 * القابل للتنفيذ حرفياً**، لأنّ الرفض بلا بديل هو بالضبط ما يدفع الوكيل إلى
 * ابتكار طريق خاطئ ثانٍ. وحين لا ناشر، ترفض بالسبب وحده بلا وعدٍ بأداةٍ غائبة.
 */
export function buildPublicPageDenialMessage(toolName: string, place: PublicPagePlace): string {
  const command = buildPublicPagePublishCommand(place);
  const reason = `${toolName} is blocked inside the Nassaj installation's build output (dist/, dist-server/): `
    + 'those files are inventoried by CLIENT_ASSET_MANIFEST.json, so writing there breaks node updates '
    + '(client_asset_manifest_changed) and the next generation swap erases the file.';
  return command
    ? `${reason} To publish a public page or site instead, write it in your own project directory and run: `
      + `${command} — ${servedAt(place.origin)}.`
    : `${reason} Write it outside the Nassaj installation tree instead.`;
}

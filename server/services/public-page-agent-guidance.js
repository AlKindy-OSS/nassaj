/**
 * public-page-agent-guidance — قفص الكتابة في مخرجات بناء نسّاج، وحلُّ مسار
 * ناشر الصفحات العامّة (T-1804).
 *
 * النصُّ كلُّه في `shared/publicPageGuidance.ts`؛ هنا المنطقُ وحده — أي ما يلزمه
 * `node:fs` من حلِّ مسارٍ وقراءةِ قرص، وهو ما منع دمج الوحدتين في ملفّ واحد:
 * بقاء النصّ نقيّاً يجعله صالحاً لكلّ طبقة، وسحبُ `fs` إليه كان سيقيّده بالخادم.
 *
 * ما يُمنع: `dist/` و`dist-server/` **تحت جذر تثبيت نسّاج وحده**. هذان مُخرَجا
 * بناءٍ مُتجاهَلان في git، لا يكتبهما مسارٌ مشروع بأدوات التحرير أصلاً (يكتبهما
 * `vite`/`server-build-atomic.mjs` ببرمجة الملفّات)، فالمنعُ لا يعترض وكيلاً
 * يطوّر نسّاج في عمله المشروع.
 *
 * ما لا يُمنع عمداً: `public/` — ملفّات مصدريّة متتبَّعة ومدخلٌ شرعيّ للبناء،
 * ومنعُه كان سيكسر تطوير نسّاج نفسه. وكذلك `dist/` في أيّ مشروعٍ آخر يعمل عليه
 * المستخدم: القاعدة مُرساةٌ بجذر نسّاج لا باسم المجلّد.
 *
 * ولا يُحاوَل تحليلُ أوامر Bash: `>`، `tee`، `cp`، `install`، `python -c`… معركةٌ
 * لا تنتهي. **وكذلك الكتابةُ عبر أدوات MCP خارج القفص عمداً**: أسماءُ أدوات
 * الخوادم الخارجية وشكلُ مُدخَلاتها غيرُ مضمونين ويتغيّران بتغيّر الخادم، فأيّ
 * مطابقةٍ لها تخمينٌ يُكسَر صامتاً ويمنح أماناً موهوماً. الحدُّ مُعلَنٌ لا مستور،
 * وشبكةُ الأمان الخلفية في الحالتين واحدة: فحصُ مانيفست الأصول يكشف كلّ ملفٍّ
 * دخيلٍ في `dist/` أيّاً كانت الأداة التي كتبته.
 */
import fs from 'node:fs';
import path from 'node:path';

import { buildPublicPageDenialMessage } from '../../shared/publicPageGuidance.js';
import { findAppRoot, getModuleDir } from '../utils/runtime-paths.js';

import { trustedDocumentShareOrigin } from './document-share-url.js';
import { resolvePublicContentRoot } from './public-content-root.mjs';

/** مخرجات البناء المحميّة، بأسمائها كما تُنتَج تحت جذر التطبيق. */
const BUILD_OUTPUT_DIRS = new Set(['dist', 'dist-server']);

/** أدوات التحرير التي يمرّ عليها القفص. Bash خارجه عمداً (انظر رأس الملفّ). */
export const PUBLIC_PAGE_GUARDED_TOOLS = new Set([
  'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
]);

/**
 * جذرُ التثبيت. **لا يُحسب بـ`../..`**: في الإنتاج يعمل الخادم من
 * `dist-server/server/services/`، فصعودان يُعطيان `<root>/dist-server` لا
 * `<root>` — وعندها لا يقع `<root>/dist` داخل الجذر المحسوب فيصير القفصُ كودَ
 * لا-عمل في الإنتاج وحده. `findAppRoot` هي القافزة فوق `dist-server` التي
 * يستعملها `server/index.js` لنفس السبب بالضبط.
 */
const DEFAULT_APP_ROOT = findAppRoot(getModuleDir(import.meta.url));

/**
 * مواضع الناشر، بترتيب الأولوية: شجرةُ المصدر أوّلاً، ثمّ حزمةُ التحديث حيث
 * يهبط على عقدةٍ مثبّتة (لا `scripts/` هناك أصلاً).
 */
const PUBLISHER_CANDIDATES = Object.freeze([
  'scripts/public-page-publish.mjs',
  'dist-server/UPDATE_RUNTIME_BUNDLE/scripts/public-page-publish.mjs',
]);

/** مسار overlay الجلسة تحت الجذر: نسخةُ عملٍ كاملةٌ، فـ`…/workspace/dist` هو dist نسّاج. */
const OVERLAY_SEGMENTS = ['.git', 'nassaj-session-overlays', 'instances'];

let cachedPublisher;

/**
 * جذرُ المحتوى العام **بنفس استدعاء الخادم**، وهو مصدرُ الحلّ الوحيد الذي
 * يشترك فيه `server/index.js` (عند `mountPublicContent`) وواجهةُ حقن التعليمات.
 *
 * حلّان منفصلان — ولو تطابق منطقُهما اليوم — يتباعدان بأوّل تغييرٍ في أحدهما،
 * والعَرَض لا يظهر عند التعديل بل عند نشرٍ يُقال عنه «نجح» ثمّ يُرجع 404.
 *
 * @param {object} [options]
 * @param {string} [options.appRoot]
 * @returns {string|null} مطلقٌ، أو `null` حين تكون الميزة مطفأة.
 */
export function resolvePublicPageContentRoot({ appRoot = DEFAULT_APP_ROOT } = {}) {
  return resolvePublicContentRoot({ appRoot });
}

/**
 * أوّلُ ناشرٍ موجودٍ فعلاً بمسارٍ **مطلق**، أو `null` حين لا ناشر على هذا الجهاز.
 *
 * الوجودُ يُفحص ولا يُفترض: الإرشادُ إلى أداةٍ غائبة يدفع الوكيل إلى الالتفاف،
 * وهو عين ما تعالجه هذه المهمّة.
 *
 * @param {object} [options]
 * @param {string} [options.appRoot]
 * @param {boolean} [options.refresh] تخطّي الذاكرة المؤقّتة (للاختبارات).
 * @returns {string|null}
 */
export function resolvePublicPagePublisher({ appRoot = DEFAULT_APP_ROOT, refresh = false } = {}) {
  if (!refresh && appRoot === DEFAULT_APP_ROOT && cachedPublisher !== undefined) return cachedPublisher;
  const found = PUBLISHER_CANDIDATES
    .map(relative => path.join(appRoot, relative))
    .find(candidate => { try { return fs.statSync(candidate).isFile(); } catch { return false; } }) ?? null;
  if (appRoot === DEFAULT_APP_ROOT) cachedPublisher = found;
  return found;
}

/**
 * الأصلُ العام الموثوق، أو `null` حين لا يكون مضبوطاً أو لا يجتاز التحقّق.
 *
 * يُعاد استعمالُ مُتحقِّق مشاركة المستندات نفسه (`trustedDocumentShareOrigin`:
 * https حصراً، بلا اعتماد ولا مسار ولا استعلام) بدل كتابة قارئٍ ثانٍ يتباعد عنه.
 * وهو يرمي عند الفساد لأنّ المشاركة تفشل حينها؛ أمّا هنا فالغياب ليس عطلاً:
 * يسقط الرابطُ المطلق ويبقى النصُّ النسبيّ. ورأسُ `Host` **ليس مُدخَلاً أبداً**:
 * أصلٌ مُستنتَجٌ من الطلب يجعل النصَّ المحقون قابلاً للتوجيه بترويسةٍ مزوّرة.
 *
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @returns {string|null}
 */
export function resolvePublicPageOrigin({ env = process.env } = {}) {
  try { return trustedDocumentShareOrigin(env.NASSAJ_PUBLIC_ORIGIN); } catch { return null; }
}

/** أطولُ سلفٍ موجودٍ فعلاً محلولَ الروابط، مضافاً إليه ما لم يوجد بعد. */
function resolveThroughSymlinks(absolute) {
  let head = absolute;
  const tail = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(head), ...tail);
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return absolute;
      tail.unshift(path.basename(head));
      head = parent;
    }
  }
}

/**
 * يُسقِط بادئة overlay الجلسة إن وُجدت، فيعود المسارُ نسبيّاً إلى جذر نسخة عمل.
 * `.git/nassaj-session-overlays/instances/<id>/workspace/x` ⇐ `x`.
 */
function stripOverlayPrefix(segments) {
  const [dotGit, overlays, instances, , workspace] = segments;
  const isOverlay = dotGit === OVERLAY_SEGMENTS[0] && overlays === OVERLAY_SEGMENTS[1]
    && instances === OVERLAY_SEGMENTS[2] && workspace === 'workspace';
  return isOverlay ? segments.slice(5) : segments;
}

/**
 * هل يقع `candidate` داخل مخرجات بناء تثبيت نسّاج؟
 *
 * @param {unknown} candidate مسار من مُدخَل الأداة، مطلقاً كان أو نسبيّاً.
 * @param {object} [options]
 * @param {string} [options.appRoot] جذر التثبيت (افتراضه المحلول بـ`findAppRoot`).
 * @param {string} [options.cwd] ما تُحلّ به المسارات النسبية.
 * @returns {boolean}
 */
export function isNassajBuildOutputPath(candidate, { appRoot = DEFAULT_APP_ROOT, cwd = process.cwd() } = {}) {
  if (typeof candidate !== 'string' || candidate === '' || candidate.includes('\0')) return false;
  const resolved = resolveThroughSymlinks(path.resolve(cwd, candidate));
  const root = resolveThroughSymlinks(path.resolve(appRoot));
  const relative = path.relative(root, resolved);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return false;
  const segments = stripOverlayPrefix(relative.split(path.sep));
  return segments.length > 1 && BUILD_OUTPUT_DIRS.has(segments[0]);
}

/** المسار الذي تكتبه الأداة، أو `null` لأداةٍ بلا مسار. */
function toolTargetPath(toolName, input) {
  if (!input || typeof input !== 'object') return null;
  const target = toolName === 'NotebookEdit' ? input.notebook_path : input.file_path;
  return typeof target === 'string' ? target : null;
}

/**
 * حكمُ القفص على استدعاء أداةٍ واحد.
 *
 * @param {string} toolName
 * @param {object} input مُدخَل الأداة كما ورد من الـSDK.
 * @param {object} [options] كما في `isNassajBuildOutputPath`.
 * @returns {{ok: true}|{ok: false, message: string}} الرفضُ يحمل الأمرَ البديل.
 */
export function evaluatePublicPageWrite(toolName, input, options = {}) {
  if (!PUBLIC_PAGE_GUARDED_TOOLS.has(toolName)) return { ok: true };
  const target = toolTargetPath(toolName, input);
  if (!isNassajBuildOutputPath(target, options)) return { ok: true };
  return {
    ok: false,
    message: buildPublicPageDenialMessage(toolName, {
      publisherPath: resolvePublicPagePublisher(options),
      contentRoot: resolvePublicPageContentRoot(options),
      origin: resolvePublicPageOrigin(options),
    }),
  };
}

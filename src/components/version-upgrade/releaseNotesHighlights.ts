/**
 * releaseNotesHighlights — استخراج أبرز بنود ملاحظات الإصدار
 *
 * يحلّل نص Markdown القادم من GitHub Releases API ويعيد قائمة بنود نظيفة
 * مرتّبة بحسب الأولوية: مزايا جديدة (### Added) أولاً، ثم تحسينات
 * (### Changed)، ثم إصلاحات (### Fixed / ### Bug Fixes)، ثم غيرها.
 *
 * لا يُلقي استثناءً ولا يخترع محتوى — إن لم تكن هناك بنود يعيد [].
 */

export type HighlightCategory = 'feature' | 'improvement' | 'fix' | 'other';

export interface ReleaseHighlight {
  text: string;
  category: HighlightCategory;
}

/** الأوزان لترتيب الفئات (أصغر = أولى) */
const CATEGORY_WEIGHT: Record<HighlightCategory, number> = {
  feature: 0,
  improvement: 1,
  fix: 2,
  other: 3,
};

/** تصنيف عنوان القسم إلى فئة */
function classifySection(heading: string): HighlightCategory {
  const h = heading.toLowerCase().replace(/[^a-z ]/g, '').trim();
  if (/\b(add(ed|s)?|new|feat(ure)?s?)\b/.test(h)) return 'feature';
  if (/\b(chang(ed|es?)|improv(ed|ement)?s?|enhanc(ed|ement)?s?|updat(ed|es?)|deprecat(ed|ion)?s?)\b/.test(h)) return 'improvement';
  if (/\b(fix(ed|es?)?|bug|bugfix|patch|hotfix|resolv(ed|es?)?)\b/.test(h)) return 'fix';
  return 'other';
}

/** بادئات Conventional Commits المدعومة (مع نطاق اختياري وعلامة !) */
const CC_PREFIX_RE = /^(?:feat|fix|chore|docs|refactor|test|style|perf|improvement|build|ci|revert)(?:\([^)]*\))?!?:\s*/i;

/**
 * يُزيل بادئة Conventional Commit من بداية النص إن وُجدت.
 * مثال: "feat: إضافة RTL" → "إضافة RTL"
 * مثال: "fix(auth): إصلاح تسجيل الدخول" → "إصلاح تسجيل الدخول"
 */
export function stripConventionalPrefix(text: string): string {
  return text.replace(CC_PREFIX_RE, '');
}

/**
 * تنظيف نص البند من رموز Markdown الشائعة:
 * – يزيل التنسيق السميك والمائل والكود المُضمَّن
 * – يحوّل الروابط `[نص](رابط)` إلى `نص`
 * – يُزيل الروابط المجرّدة
 * – يُزيل علامات التعجب للصور `![alt](src)`
 * – يُزيل علامات HTML البسيطة
 * – يُزيل عناوين PR/commit المختصرة (hash وما شابهه)
 * – يُزيل بادئات Conventional Commits (feat:، fix:، …)
 */
export function stripMarkdownInline(text: string): string {
  const stripped = text
    // الصور أولاً
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '')
    // الروابط: [نص](رابط) → نص
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    // الروابط المرجعية: [نص][مرجع] → نص
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    // روابط مجرّدة
    .replace(/https?:\/\/\S+/gi, '')
    // كود مُضمَّن بثلاث علامات
    .replace(/```[^`]*```/gs, '')
    // كود مُضمَّن
    .replace(/`([^`]+)`/g, '$1')
    // سميك + مائل
    .replace(/\*{3}([^*]+)\*{3}/g, '$1')
    .replace(/_{3}([^_]+)_{3}/g, '$1')
    // سميك
    .replace(/\*{2}([^*]+)\*{2}/g, '$1')
    .replace(/_{2}([^_]+)_{2}/g, '$1')
    // مائل
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/_([^_\n]+)_/g, '$1')
    // علامات HTML بسيطة
    .replace(/<[^>]+>/g, '')
    // إشارات التغيير الكاملة (#NNN أو commit hash)
    .replace(/\B#\d+\b/g, '')
    .replace(/\b[0-9a-f]{7,40}\b/gi, '')
    // مسافات زائدة
    .replace(/\s{2,}/g, ' ')
    .trim();
  // بادئات Conventional Commits — تُزال بعد تنظيف Markdown حتى لا يبقى تنسيق مُضمَّن
  return stripped.replace(CC_PREFIX_RE, '').trimStart();
}

/** استخراج قائمة نقطية من قسم نصي */
function extractBullets(sectionText: string, category: HighlightCategory): ReleaseHighlight[] {
  const bullets: ReleaseHighlight[] = [];
  const lines = sectionText.split('\n');
  for (const line of lines) {
    // أسطر البنود: تبدأ بـ - أو * أو + أو رقم. (مع مسافة بادئة اختيارية، حد واحد)
    const match = /^\s{0,2}[-*+][ \t]+(.+)$/.exec(line)
      ?? /^\s{0,2}\d+\.[ \t]+(.+)$/.exec(line);
    if (!match) continue;
    const text = stripMarkdownInline(match[1]);
    // تجاهل البنود الفارغة أو القصيرة جداً (< 8 محارف) أو التي تبدو روابط
    if (text.length < 8) continue;
    bullets.push({ text, category });
  }
  return bullets;
}

/**
 * استخراج أبرز التغييرات من نص ملاحظات إصدار بصيغة Markdown.
 *
 * @param body   نص الـbody من GitHub Releases API
 * @param maxItems الحدّ الأقصى للبنود (افتراضي 6)
 * @returns قائمة بنود نظيفة مرتّبة بحسب الأهمية
 */
export function extractReleaseHighlights(body: string, maxItems = 6): ReleaseHighlight[] {
  if (!body || !body.trim()) return [];

  // تقسيم النص إلى أقسام بحسب عناوين ### أو ## (مستوى 2/3)
  // نحتفظ بعنوان كل قسم معه
  const sectionPattern = /^#{2,3}[ \t]+(.+)$/m;
  const sections: Array<{ heading: string; content: string; category: HighlightCategory }> = [];

  const parts = body.split(/^#{2,3}[ \t]+/m);
  // parts[0] = ما قبل أول عنوان (يُتجاهل إن لم يحوِ بنوداً)
  const headings = [...body.matchAll(/^#{2,3}[ \t]+(.+)$/gm)].map((m) => m[1].trim());

  headings.forEach((heading, idx) => {
    const content = (parts[idx + 1] ?? '').replace(/^[^\n]*\n/, ''); // إزالة سطر العنوان نفسه من parts
    sections.push({
      heading,
      content,
      category: classifySection(heading),
    });
  });

  // إذا لم نجد أي أقسام مُعنوَنة، نستخرج أي بنود من النص كله
  if (sections.length === 0) {
    const fallback = extractBullets(body, 'other');
    return fallback.slice(0, maxItems);
  }

  // تجميع البنود من كل قسم
  const allBullets: ReleaseHighlight[] = [];
  for (const section of sections) {
    const bullets = extractBullets(section.content, section.category);
    allBullets.push(...bullets);
  }

  // ترتيب بحسب الفئة (مزايا أولاً، تحسينات، إصلاحات، أخرى)
  allBullets.sort((a, b) => CATEGORY_WEIGHT[a.category] - CATEGORY_WEIGHT[b.category]);

  // تقليص إلى maxItems
  return allBullets.slice(0, maxItems);
}


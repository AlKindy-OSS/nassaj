/**
 * codeHighlightScope — نطاق تلوين الشيفرة كتفضيل مستخدم بثلاثة مستويات.
 *
 * الخلفية (قياس 2026-07-28): `react-syntax-highlighter` عبر `Prism` الكامل يجرّ
 * `refractor` بكل لغاته (277 وحدة، ‏871 كيلوبايت خام على القرص) داخل حزمة البدء،
 * فيدفع كل مستخدم ثمن 300 لغة ليقرأ كتلة `bash` واحدة. الحلّ ليس حذف اللغات بل
 * جعل عمقها اختياراً: الافتراضي يبقى ساكناً في الحزمة، وما فوقه لا يُحمَّل إلا
 * عند طلبه صراحةً.
 *
 * هذه الوحدة **بيانات ودوال خالصة فقط** — لا استيراد لـPrism ولا لـReact — كي
 * تُستورَد من طبقة التفضيلات (`useUiPreferences`) دون أن تجرّ معها أي مُلوِّن.
 * كسر هذه القاعدة يُعيد الحزمة كلها إلى مسار البدء من الباب الخلفي.
 */

/** مستويات التلوين الثلاثة. */
export type CodeHighlightScope = 'core' | 'extended' | 'full';

export const CODE_HIGHLIGHT_SCOPES: readonly CodeHighlightScope[] = ['core', 'extended', 'full'];

/** الافتراضي: أخفّ مستوى، وهو وحده المُضمَّن في حزمة البدء. */
export const DEFAULT_CODE_HIGHLIGHT_SCOPE: CodeHighlightScope = 'core';

/**
 * ترتيب المستويات — يُستعمل لمعرفة «هل المستوى المطلوب أعلى مما حُمِّل؟».
 * التسجيل تراكمي بطبيعته (refractor لا يملك إلغاء تسجيل)، فالمقارنة رقمية.
 */
export const CODE_HIGHLIGHT_SCOPE_RANK: Record<CodeHighlightScope, number> = {
  core: 0,
  extended: 1,
  full: 2,
};

/**
 * لغات المستوى الأول — مُسجَّلة **ساكناً** في حزمة البدء.
 *
 * `javascript` و`css` و`markup` (‏HTML/XML/SVG) مسجَّلة أصلاً داخل
 * `refractor/core` فلا تُستورَد ثانيةً؛ القائمة هنا هي العقد المعروض للمستخدم،
 * لا قائمة الاستيراد. المقابل الفعلي للاستيراد في `prismRegistry.ts`.
 */
export const CORE_LANGUAGE_IDS: readonly string[] = [
  'javascript',
  'typescript',
  'python',
  'bash',
  'json',
  'css',
  'markup',
  'markdown',
  'yaml',
  'rust',
];

/**
 * لغات المستوى الثاني — تُحمَّل ديناميكياً عند اختيار المستوى.
 *
 * `c` غير مذكورة لأن `cpp` تُسجّلها بنفسها (تبعية داخلية في refractor)،
 * و`jsx`/`tsx` تجرّان `javascript`/`typescript` المُسجَّلتين سلفاً.
 */
export const EXTENDED_LANGUAGE_IDS: readonly string[] = [
  'jsx',
  'tsx',
  'go',
  'java',
  'cpp',
  'csharp',
  'php',
  'ruby',
  'sql',
  'docker',
];

/**
 * أسماء بديلة يفتقدها Prism ويكتبها الناس في أسوار الماركداون.
 *
 * `shell` مُعرَّفة أصلاً كبديل لـ`bash`، أما `sh` و`zsh` فلا — وهي أشيع ما
 * يُكتب في محادثاتنا. بدون هذا الجدول تسقط كتلة ```sh``` إلى نصّ بلا تلوين.
 */
export const LANGUAGE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  bash: ['sh', 'zsh', 'console', 'shell-session'],
  markdown: ['mdx'],
  docker: ['dockerfile'],
};

/**
 * يقرأ قيمة مخزَّنة/واردة ويعيد مستوىً صالحاً دائماً.
 *
 * أي قيمة غريبة (مفتاح قديم، تخريب يدوي في localStorage، حقل من خادم أحدث)
 * تسقط إلى `fallback` بدل أن تُعطِّل التلوين كله.
 */
export function parseCodeHighlightScope(
  value: unknown,
  fallback: CodeHighlightScope = DEFAULT_CODE_HIGHLIGHT_SCOPE,
): CodeHighlightScope {
  if (typeof value === 'string' && (CODE_HIGHLIGHT_SCOPES as readonly string[]).includes(value)) {
    return value as CodeHighlightScope;
  }
  return fallback;
}

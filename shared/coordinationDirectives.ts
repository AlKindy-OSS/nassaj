/**
 * coordinationDirectives — المصدر الوحيد لمستوى تنسيق الجولة ونصّه ودرجة إنفاذه.
 *
 * كان النصّ محبوساً في `server/claude-sdk.js` فلم يصل غير Claude. نُقل هنا (نفس
 * موضع `bodyEngineMatrix.ts` و`engineProviders.ts`) ليقرأه كل مُشعِل مزوّد
 * والواجهة معاً، فلا يفترق نصٌّ عن نصّ ولا وصفٌ عن واقع.
 *
 * النصّ يبقى **إنجليزياً** عمداً: هو مُحقَن في مطالبة النموذج لا معروض للمستخدم.
 * المعروض للمستخدم مترجَم في `src/i18n/locales/{ar,en}/chat.json`.
 *
 * ─── درجات الإنفاذ (المبدأ الحاكم، فيتو qa-critic 2026-08-10) ───
 * لا يُسوّى بين محرّك يمنع فعلاً ومحرّك يُنصَح نصّاً. ثلاث درجات لا غير:
 *
 *   • `mechanical` — المحرّك نفسه يفرض حدّاً مقيساً (مفتاح إعداد أو متغيّر بيئة
 *     له قارئ مُثبَت في الثنائية)، **بالإضافة** إلى التوجيه النصّي.
 *   • `textual`    — لا حدّ يُفرض؛ التوجيه يُحقن في مطالبة النموذج فحسب،
 *     والامتثال سلوكيّ لا مضمون.
 *   • `none`       — لا قناة أصلاً (لا مُشعِل تشغيل على هذا النشر).
 *
 * ضبطُ اسمِ متغيّرٍ لا يقرؤه أحد ممنوع (درس B-548): كل ترقية إلى `mechanical`
 * تستوجب دليلاً — مسحَ ثنائية أو توثيقاً رسمياً أو تجربة — مذكوراً عند موضعها.
 */

export const COORDINATION_LEVELS = ['direct', 'delegate', 'delegate_review'] as const;

export type CoordinationLevel = (typeof COORDINATION_LEVELS)[number];

export type CoordinationEnforcement = 'mechanical' | 'textual' | 'none';

/**
 * النصّ المحقون لكل مستوى. `direct` بلا نصّ عمداً، وحقنُ
 * فقرةٍ تقول «تصرّف كالمعتاد» ضجيجٌ في كل جولة.
 *
 * النصّان أدناه منقولان حرفياً من `claude-sdk.js` (قبل هذا النقل) كي تبقى جولة
 * Claude مطابقةً بايتاً ببايت لما كانت عليه.
 */
export const COORDINATION_DIRECTIVES: Readonly<Record<'delegate' | 'delegate_review', string>>
  = Object.freeze({
    delegate: [
      'Coordination level for this turn: delegated.',
      'The coordinator delegates implementation work to the appropriate specialized agents,',
      'coordinates their results, and does not silently replace requested delegation with self-execution.',
    ].join(' '),
    delegate_review: [
      'Coordination level for this turn: delegated with ascending review.',
      'The coordinator is depth 0; delegation may reach depth 10 where supported, never depth 11.',
      'There is no product-level numerical cap on primary agents; native engine limits still apply.',
      'Check fresh CPU and memory before each launch and proceed only below 80%.',
      'Each parent critically reviews its children before returning, and the',
      'coordinator critically reviews the integrated result before completion.',
    ].join(' '),
  });

/**
 * القيمة الغائبة تستخدم افتراضي المنتج (`delegate`). أمّا القيمة الحاضرة غير
 * المعروفة فتسقط fail-closed إلى `direct`، فلا يستطيع مدخل تالف توسيع التفويض.
 */
export function normalizeCoordinationLevel(value: unknown): CoordinationLevel {
  if (value === undefined || value === null || value === '') {
    return 'delegate';
  }
  return value === 'delegate' || value === 'delegate_review' ? value : 'direct';
}

/** نصّ المستوى، أو `null` حين لا نصّ له (`direct` وكل مدخل غير معروف). */
export function getCoordinationDirective(value: unknown): string | null {
  const level = normalizeCoordinationLevel(value);
  return level === 'direct' ? null : COORDINATION_DIRECTIVES[level];
}

/**
 * قناة المطالبة للمحرّكات التي لا تملك سوى نصّ المطالبة (‏CLI providers).
 *
 * يُغلَّف التوجيه بوسم `<coordination>` كي يقرأه النموذج تعليماتِ جولةٍ لا جزءاً
 * من سؤال المستخدم — نفس نمط `<instructions>` الذي يستعمله `agy-cli.js` أصلاً.
 *
 * **موضع الاستدعاء يهمّ:** يُستدعى عند بناء argv/الحمولة، **بعد** تسجيل رسالة
 * المستخدم في السجلّ (‏`recordUserMessage`) — وإلا ظهر التوجيه في المحادثة نصّاً
 * كتبه المستخدم ولم يكتبه.
 *
 * `direct` (أو أي مدخل غير معروف) يُعيد الأمر كما هو حرفياً، فمسار اليوم بلا تغيير.
 */
export function withCoordinationDirective(command: string | null | undefined, value: unknown): string {
  const directive = getCoordinationDirective(value);
  const base = typeof command === 'string' ? command : '';
  if (!directive) {
    return base;
  }
  const wrapped = `<coordination>\n${directive}\n</coordination>`;
  return base ? `${wrapped}\n\n${base}` : wrapped;
}

/**
 * درجة الإنفاذ الفعلية لكل مزوّد — **الحقيقة المقيسة**، لا الطموح.
 *
 * هذا الجدول هو ما تعرضه الواجهة للمستخدم عبر واصف القدرات، فأي ترقية فيه بلا
 * دليل هي بعينها الادّعاءُ الذي أسقط الموجة الأولى.
 *
 * • claude — `mechanical`: ‏`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` (‏1/1/2) و
 *   `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` مقيسان على CLI 2.1.226 (حارس العمق
 *   في الثنائية `if (m >= h) throw`)، فوق التوجيه النصّي عبر `systemPrompt.append`.
 * • codex — `textual`: القناة النصّية هي مُدخَل الجولة (‏`thread.runStreamed`).
 *   والحدّ الميكانيكي `agents.max_depth` موجود لكنه **مثبَّت على 1 دائماً** بوصفه
 *   ضابطاً أمنياً (‏Gate 2 / T-886)، فلا يتحرّك مع المستوى ⇒ لا يُعدّ إنفاذاً
 *   للمستوى. رفعه عند `delegate_review` قرارٌ أمني ينتظر إذن المالك.
 * • antigravity/opencode/cursor/qwen/hermes/kimi — `textual`: لكلٍّ منها
 *   مُدخَل مطالبة واحد (‏`-p`/`--prompt`/وسيط موضعي) يُحقن فيه التوجيه؛ ولا
 *   مفتاحَ عمقٍ موثَّقاً لأيٍّ منها.
 * • deepseek/glm — `textual`: مسار HTTP، والتوجيه يُرسل في حقل `system` من صيغة
 *   Anthropic Messages (وهو حقل رسمي في الصيغة، وكان الجسم بلا رسالة نظام أصلاً).
 * • sakana — `none`: مزوّد stub بلا مُشعِل تشغيل في الموزّع أصلاً، فلا قناة.
 */
export const COORDINATION_ENFORCEMENT: Readonly<Record<string, CoordinationEnforcement>>
  = Object.freeze({
    claude: 'mechanical',
    codex: 'textual',
    opencode: 'textual',
    qwen: 'textual',
    antigravity: 'textual',
    cursor: 'textual',
    hermes: 'textual',
    kimi: 'textual',
    deepseek: 'textual',
    glm: 'textual',
    sakana: 'none',
  });

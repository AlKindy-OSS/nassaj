import type { AgentCategory, AgentProvider } from '../../../types/types';
import { COMING_SOON_SETTINGS_PROVIDERS } from './visibleAgents';

/**
 * فئات تبويب الوكلاء — **الفئة تظهر ⟺ لها لوحٌ يُصيَّر** (‏B-414).
 *
 * القاعدة ليست جديدة ولا مخترعة هنا: `bodyHasEngineAxis` تطبّقها على «المحرّكات»
 * منذ T-1152، وتعلّلها بأنّ سؤالين مختلفين (أيّ فئة تُعرض؟ وما الذي يُرسم فيها؟)
 * جوابُهما الواحد هو تبويبٌ يفتح على فراغ. وكانت مطبَّقةً في موضعٍ واحد فقط،
 * فسقطت فئتان:
 *
 *  • **الأذونات** — كانت في قاعدة الفئات لكل وكيل بلا استثناء، بينما
 *    `AgentCategoryContentSection` لا تُصيّر `PermissionsContent` إلا لخمسة
 *    معرّفات. القياس على الكتالوج الحيّ: `opencode` و`kimi` و`hermes` — ثلاثة من
 *    سبعة وكلاء ظاهرين — يفتحون لوحاً **أبيض تماماً**، والملف نفسه يحمل الادّعاء
 *    المضاد («‏so the Permissions tab is never blank»)، وهي جملةٌ صحيحة عن
 *    أنتيجرافيتي وحدها تُقرأ ضماناً عاماً.
 *  • **الإعداد** — حُذفت بالكامل: مُنشئها الوحيد كان `API_ONLY_PROVIDERS` وثلاثتها
 *    خارج الشريط أصلاً (‏`deepseek`/`glm` معطَّلان عالمياً، و`sakana` مُسقَطة يدوياً
 *    في `visibleAgents.ts`)، ولوحُها `ApiSetupContent` كان يُرجع `null` لأي وكيلٍ
 *    يبلغه بالرابط العميق. كودٌ ميّتٌ من طرفيه.
 *
 * الغياب ليس كتماناً: «لا أذونات قابلة للضبط» معلومةٌ صحيحة، ومكانُها لوحُ
 * «التعليمات» الذي يصف ما يُملى على الوكيل فعلاً، لا تبويبٌ فارغ عنوانه سؤال.
 */

/**
 * الوكلاء الذين يقبل `PermissionsContent` معرّفَهم — **نسخةٌ من نوعه لا تخمين**.
 *
 * `PermissionsContentProps` اتحادٌ من خمسة أشكال، وكلٌّ منها يُصيَّر بشرطٍ صريح في
 * `AgentCategoryContentSection`. القائمة هنا هي ذلك الاتحاد مسرودةً بياناً، وحارسُ
 * `agentCategorySurfaces.test.tsx` يُصيّر كل فئةٍ لكل وكيل فيسقط فوراً إن انحرفت
 * هذه القائمة عن الشرطيات هناك — فلا يحرس المصفوفةَ بل ما يراه القارئ.
 */
export const PERMISSIONS_PANEL_AGENTS: readonly AgentProvider[] = Object.freeze([
  'claude', 'cursor', 'codex', 'antigravity',
] as AgentProvider[]);

/** الوكلاء الذين لهم تبويب مهارات مخصّص. */
export const SKILLS_CAPABLE_PROVIDERS: readonly AgentProvider[] = Object.freeze([
  'claude', 'codex', 'cursor', 'opencode',
] as AgentProvider[]);

/** Providers whose generic MCP surface is currently exposed to members. */
export const MCP_PANEL_AGENTS: readonly AgentProvider[] = Object.freeze([
  'claude', 'codex', 'cursor',
] as AgentProvider[]);

/** هل لهذا الوكيل لوحُ أذوناتٍ يُصيَّر أصلاً؟ */
export function agentHasPermissionsPanel(agent: AgentProvider): boolean {
  return PERMISSIONS_PANEL_AGENTS.includes(agent);
}

/**
 * الفئات المعروضة لوكيلٍ بعينه، بالترتيب.
 *
 * دالّةٌ نقيّة خارج المكوّن عمداً: الحارس الآلي يسأل **نفس** المصدر الذي يرسم منه
 * الشريط، ونسخةٌ ثانية من هذا الحساب داخل الاختبار كانت ستحرس شيئاً غير المعروض.
 */
export function visibleCategoriesFor(agent: AgentProvider): AgentCategory[] {
  // Coming-soon providers have no real category content. The content section
  // renders a coming-soon panel for them, so the category tab bar is hidden
  // entirely (AgentCategoryTabsSection returns null on empty categories).
  if (COMING_SOON_SETTINGS_PROVIDERS.includes(agent)) return [];

  const categories: AgentCategory[] = ['account'];

  // ADR-073: محور المحرّكات مطويٌّ في الجسم الذي يصفه، وبعد «الحساب» مباشرةً لأنه
  // يجيب السؤال نفسه من الجهة الأخرى: على ماذا يُسمح لهذا الوكيل أن يعمل.
  //
  // ‏T-1232 — **ولكل وكيل بلا شرط.** كان مشروطاً بـ`bodyHasEngineAxis`، فاختفى عن
  // خمسة وكلاء لا بديلَ لهم؛ وقرأه المالك فوضى: «بعضهم فيهم تبويب المحرّكات
  // وبعضهم لا». والشرط كان يحمي من لوحٍ أبيض، وذاك الخطر زال: `EnginesContent`
  // تُجيب الآن «يعمل على محرّكه وحده» بدل أن تُرجع `null`. وهي نفس قاعدة تبويب
  // «التعليمات» (‏ADR-093 §2): لكل جسمٍ جوابٌ عن السؤال، ولو كان الجواب «لا بديل».
  categories.push('engines');

  if (agentHasPermissionsPanel(agent)) {
    categories.push('permissions');
  }

  // ADR-093 §2 — «التعليمات» فئةٌ لكل وكيل بلا استثناء: لكل جسمٍ جوابٌ عن هذا
  // السؤال، حتى الذي لا قناة له — فجوابه «لا قناة تعليمات لهذا المحرّك»، وهو
  // معلومةٌ لا فراغ. ولوحُها `standalone` يُصيّر رأسه دائماً، فالفئة لا تُخالف
  // قاعدة «⟺ لها محتوى».
  categories.push('instructions');
  if (MCP_PANEL_AGENTS.includes(agent)) {
    categories.push('mcp');
  }

  if (SKILLS_CAPABLE_PROVIDERS.includes(agent)) {
    categories.push('skills');
  }

  return categories;
}

import type { AgentProvider } from '../../../../../types/types';

/**
 * صفحات الفوترة/الاشتراك لكل مزوّد — لا تُغيَّر إلا بتحقّق من الرابط مباشرةً.
 *
 * المزوّدان الغائبان عمداً:
 * - opencode: مفتوح المصدر بالكامل (BYOK)، لا اشتراك مدير ولا صفحة فوترة.
 * - sakana: لم يُطلِق منتجاً مدفوعاً بعد.
 *
 * ملاحظة: الروابط هنا للاشتراك أو إدارة الخطة، لا لكونسول API.
 * deepseek وglm بلا اشتراك أصلاً — روابطهما إلى صفحة الرصيد/المفاتيح.
 */
export const BILLING_LINKS: Partial<Record<AgentProvider, string>> = {
  claude:      'https://claude.ai/settings/billing',
  cursor:      'https://cursor.com/settings/billing',
  codex:       'https://chatgpt.com/settings',
  gemini:      'https://gemini.google.com/app/subscriptions',
  antigravity: 'https://one.google.com/about/google-ai-plans/',
  kimi:        'https://www.kimi.com/membership',
  deepseek:    'https://platform.deepseek.com/top-up',
  glm:         'https://z.ai/manage-apikey/billing',
  hermes:      'https://portal.nousresearch.com',
  // opencode: absent — open-source BYOK, no subscription or billing page
  // sakana: absent — no paid product launched yet
};

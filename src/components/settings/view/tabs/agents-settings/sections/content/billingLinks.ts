import type { AgentProvider } from '../../../../../types/types';

/**
 * صفحات الفوترة/الاشتراك لكل مزوّد — لا تُغيَّر إلا بتحقّق من الرابط مباشرةً.
 *
 * ملاحظة: الروابط هنا للاشتراك أو إدارة الخطة، لا لكونسول API.
 * deepseek وglm بلا اشتراك أصلاً — روابطهما إلى صفحة الرصيد/المفاتيح.
 * opencode: صفحة خطة Zen (PAYG + اشتراك شهري عبر opencode.ai/zen).
 * qwen: كونسول Alibaba Cloud Model Studio (Bailian) لإدارة الرصيد والمفاتيح.
 * sakana: خطط API مدفوعة ($20/$100/$200/شهر) عبر console.sakana.ai.
 *
 * النوع Record<AgentProvider, string> (لا Partial) يضمن فشل الـtypecheck
 * حين يُضاف مزوّد جديد دون رابط فوترة.
 */
export const BILLING_LINKS: Record<AgentProvider, string> = {
  claude:      'https://claude.ai/settings/billing',
  cursor:      'https://cursor.com/settings/billing',
  codex:       'https://chatgpt.com/settings',
  antigravity: 'https://one.google.com/about/google-ai-plans/',
  opencode:    'https://opencode.ai/zen',
  kimi:        'https://www.kimi.com/membership',
  deepseek:    'https://platform.deepseek.com/top-up',
  glm:         'https://z.ai/manage-apikey/billing',
  hermes:      'https://portal.nousresearch.com',
  qwen:        'https://bailian.console.alibabacloud.com',
  sakana:      'https://console.sakana.ai/billing',
};

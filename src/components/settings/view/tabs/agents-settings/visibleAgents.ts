import { filterDisabledProviders } from '../../../../../../shared/disabledProviders';
import type { AgentProvider } from '../../../types/types';

/**
 * الأجساد التي يعرضها شريط الوكلاء في الإعدادات — **مصدرٌ واحد** (T-1205).
 *
 * كانت هذه القائمة حرفيةً داخل `AgentsSettingsTab`، فلمّا صار وصول المالك إلى
 * اعتماد كل شركة يمرّ من صفحة وكيلٍ ظاهر (بعد حذف تبويب «المورّدون») احتاج
 * الحارس الآلي أن يسأل نفس السؤال الذي يسأله الشريط. نسخةٌ ثانية من القائمة
 * كانت ستجعل الحارس يحرس شيئاً غير المعروض.
 *
 * Globally disabled providers (T-864) are dropped from the settings agent bar
 * (Account/Permissions/MCP); the full list stays for upstream sync.
 *
 * `sakana` is hidden here by owner's decision (T-1173) and NOT via
 * disabledProviders: it is a union-only placeholder with no backend of its own —
 * the auth refresher already skips it (provider-auth/types.ts), so a tile for it
 * could only ever say "not connected". Kept in the union and in the AGENT_NAMES
 * map so nothing that still references the id breaks.
 *
 * Ordered by the COMPANY'S FIRST GENERATIVE-AI RELEASE — a generative model or
 * tool, whichever came first (owner, 2026-09-12, T-1760; replaces the 2026-08-01
 * agent-CLI seniority order). Same-company tiles sit together.
 *
 *   antigravity  Google         Smart Reply (Inbox)    2015-11-04
 *   gemini       Google         (hidden, same company)
 *   codex        OpenAI         GPT-1                  2018-06
 *   cursor       Anysphere      Cursor code editor     2023-01-20
 *   claude       Anthropic      Claude 1               2023-03-14
 *   qwen         Alibaba        Tongyi Qianwen         2023-04-11
 *   hermes       Nous Research  GPT4-x-Vicuna-13b      2023-05-06
 *   kimi         Moonshot AI    Kimi                   2023-10-09
 *   deepseek     DeepSeek       DeepSeek-Coder         2023-11-02
 *   opencode     SST/Anomaly    OpenCode               2025-06-19
 *
 * Verified 2026-09-12: Smart Reply decodes replies with a word-level LSTM
 * (Google Research blog); Cursor's editor launch is the HN post of 2023-01-20
 * (cursor.so, "Code Editing, Redefined"); Nous's first Hugging Face model is
 * dated by the HF API (Nous-Hermes-13b followed on 2023-06-03). DeepSeek ships
 * its own agent too (deepseek-harness, first public 2026-08-13), but the
 * company's row is dated by its first release. glm stays hidden and undated at
 * the end.
 */
export const SETTINGS_AGENT_ORDER: readonly AgentProvider[] = Object.freeze([
  'antigravity', 'codex', 'cursor', 'claude', 'qwen', 'hermes', 'kimi',
  'deepseek', 'opencode', 'glm',
] as AgentProvider[]);

/**
 * Providers that appear in the settings strip as "coming soon" tiles — they are
 * globally disabled (spawn-blocked, no backend wiring) but the owner wants them
 * visible so users know they are planned. Selecting one shows a coming-soon panel
 * instead of the normal Account/Permissions/etc. category content, and no status
 * dot is rendered on their tile.
 *
 * They keep their place in `SETTINGS_AGENT_ORDER` like any other tile. `glm`
 * stays hidden entirely (folded into OpenCode carrier, ADR-062).
 *
 * T-1760: added 2026-09-12.
 */
export const COMING_SOON_SETTINGS_PROVIDERS: readonly AgentProvider[] = Object.freeze([
  'deepseek',
] as AgentProvider[]);

/** الشريط كما يُصيَّر فعلاً: الترتيب أعلاه بعد إسقاط المعطَّل عالمياً، مع إبقاء
 *  مزوّدات «قريباً» في مواضعها من الترتيب رغم تعطيلها. */
export function visibleSettingsAgents(): AgentProvider[] {
  const active = new Set(filterDisabledProviders([...SETTINGS_AGENT_ORDER]));
  return SETTINGS_AGENT_ORDER.filter(
    (provider) => active.has(provider) || COMING_SOON_SETTINGS_PROVIDERS.includes(provider),
  );
}

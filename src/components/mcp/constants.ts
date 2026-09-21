import type { McpFormState, McpProvider, McpScope, McpTransport } from './types';

// Some providers below are deliberately hidden from the connector rollout even
// when a backend adapter exists. This registry describes the generic MCP UI
// contract only; rollout targets remain an explicit server-side allowlist.

export const MCP_PROVIDER_NAMES: Record<McpProvider, string> = {
  claude: 'Claude',
  cursor: 'Cursor',
  codex: 'Codex',
  gemini: 'Gemini',
  antigravity: 'Antigravity',
  opencode: 'OpenCode',
  qwen: 'Qwen Code',
  kimi: 'Kimi',
  deepseek: 'DeepSeek',
  glm: 'GLM 5.2',
  hermes: 'Hermes',
  sakana: 'Sakana',
};

// Codex is user-only: codex-cli 0.147.0 reads $CODEX_HOME/config.toml and ignores
// <workspace>/.codex/config.toml (B-751). Never add `project` here without a new
// real-reader contract and the matching backend capability.
export const MCP_SUPPORTED_SCOPES: Record<McpProvider, McpScope[]> = {
  claude: ['user', 'project', 'local'],
  cursor: ['user', 'project'],
  codex: ['user'],
  // Gemini's generic writer has not passed the installed-reader/containment
  // contract yet (B-740). Keep the provider and model surfaces intact while
  // withholding MCP actions until that contract is proven.
  gemini: [],
  antigravity: [],
  // Backend adapter is contract-tested but rollout-disabled by default.
  opencode: [],
  qwen: [],
  kimi: [],
  deepseek: [],
  glm: [],
  hermes: [],
  sakana: [],
};

export const MCP_SUPPORTED_TRANSPORTS: Record<McpProvider, McpTransport[]> = {
  claude: ['stdio', 'http', 'sse'],
  cursor: ['stdio', 'http'],
  codex: ['stdio', 'http'],
  gemini: [],
  antigravity: [],
  opencode: [],
  qwen: [],
  kimi: [],
  deepseek: [],
  glm: [],
  hermes: [],
  sakana: [],
};

export const MCP_GLOBAL_SUPPORTED_SCOPES: McpScope[] = ['user', 'project'];

export const MCP_GLOBAL_SUPPORTED_TRANSPORTS: McpTransport[] = ['stdio', 'http'];

/**
 * Providers a global/manual MCP write can truthfully target for one shape.
 *
 * This is derived from the same capability registry that gates each provider's
 * MCP panel. It deliberately does not promise "all providers": Codex is
 * user-only, Gemini is dormant, and Cursor remains available for both user and
 * project manual MCP configuration.
 */
export function globalManualTargets(scope: McpScope, transport: McpTransport): McpProvider[] {
  if (!MCP_GLOBAL_SUPPORTED_SCOPES.includes(scope)
    || !MCP_GLOBAL_SUPPORTED_TRANSPORTS.includes(transport)) {
    return [];
  }

  return (Object.keys(MCP_PROVIDER_NAMES) as McpProvider[]).filter((provider) => (
    MCP_SUPPORTED_SCOPES[provider].includes(scope)
    && MCP_SUPPORTED_TRANSPORTS[provider].includes(transport)
  ));
}

// ‏`MCP_PROVIDER_BUTTON_CLASSES` حُذف في T-1207/ب-416: أحد عشر صفّاً من عائلات
// Tailwind الخام (purple/gray/blue/slate/zinc/rose/cyan/violet/teal) كانت تصبغ
// **الزرّ الأساسي** بلون علامة الوكيل المفتوح. وهو عين النمط الذي أُعدم في
// T-1172 على بطاقة الحساب، بعين علله الثلاث: لا واحدة من هذه الدرجات رمزٌ في
// `src/index.css` فكلّها خارج نظام النبرات؛ ولونُ الزرّ كان يقول «أيّ وكيل
// مفتوح» وهو ما يقوله المنتقي المضيء فوقه أصلاً؛ ولا أحد قاس تباين `text-white`
// فوق هذه الدرجات على البريستات الستة. العلامة التجارية لا تُلوّن تحكّماً
// وظيفياً — الزرّ الآن `Button` المشترك بنبراته (`default` للفعل الأساسي،
// `outline` لما دونه)، فصفحةُ Claude وصفحةُ Hermes من نظامٍ واحد.

export const MCP_SUPPORTS_WORKING_DIRECTORY: Record<McpProvider, boolean> = {
  claude: false,
  cursor: false,
  codex: true,
  gemini: true,
  antigravity: false,
  opencode: false,
  qwen: false,
  kimi: false,
  deepseek: false,
  glm: false,
  hermes: false,
  sakana: false,
};

export const DEFAULT_MCP_FORM: McpFormState = {
  name: '',
  scope: 'user',
  workspacePath: '',
  transport: 'stdio',
  command: '',
  args: [],
  env: {},
  cwd: '',
  url: '',
  headers: {},
  envVars: [],
  bearerTokenEnvVar: '',
  envHttpHeaders: {},
  importMode: 'form',
  jsonInput: '',
};

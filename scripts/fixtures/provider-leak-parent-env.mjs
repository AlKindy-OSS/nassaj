// B-1771 fixture: the operator-shaped environment a test runner inherits. Every
// value is a dummy tagged `parent-` so a probe can name a leak without printing
// a credential. It covers each provider's credential env var and the env knobs
// that steer its on-disk credential tree (claude, codex, agy/gemini, cursor,
// opencode, kimi, glm, deepseek, qwen, dsh, hermes, cloud routing).
export const PARENT_HOME = '/home/operator';

export const PARENT_PROVIDER_ENV = Object.freeze({
  CLAUDE_CONFIG_DIR: '/home/operator/.nassaj-users/1/.claude',
  CLAUDE_CODE_OAUTH_TOKEN: 'parent-claude-oauth',
  ANTHROPIC_API_KEY: 'parent-anthropic-key',
  ANTHROPIC_AUTH_TOKEN: 'parent-anthropic-auth',
  CODEX_HOME: '/home/operator/.nassaj-users/1/.codex',
  OPENAI_API_KEY: 'parent-openai-key',
  CODEX_API_KEY: 'parent-codex-key',
  GEMINI_API_KEY: 'parent-gemini-key',
  GOOGLE_API_KEY: 'parent-google-key',
  GOOGLE_APPLICATION_CREDENTIALS: '/home/operator/.config/gcloud/adc.json',
  CURSOR_API_KEY: 'parent-cursor-key',
  CURSOR_CONFIG_DIR: '/home/operator/.cursor',
  XDG_DATA_HOME: '/home/operator/.local/share',
  XDG_CONFIG_HOME: '/home/operator/.config',
  OPENCODE_CONFIG: '/home/operator/.config/opencode/opencode.json',
  OPENCODE_CONFIG_DIR: '/home/operator/.config/opencode',
  KIMI_API_KEY: 'parent-kimi-key',
  MOONSHOT_API_KEY: 'parent-moonshot-key',
  KIMI_CODE_HOME: '/home/operator/.kimi-code',
  KIMI_SHARE_DIR: '/home/operator/.kimi',
  GLM_API_KEY: 'parent-glm-key',
  ZAI_API_KEY: 'parent-zai-key',
  DEEPSEEK_API_KEY: 'parent-deepseek-key',
  QWEN_HOME: '/home/operator/.qwen',
  DASHSCOPE_API_KEY: 'parent-dashscope-key',
  HERMES_HOME: '/home/operator/.hermes',
  NOUS_API_KEY: 'parent-nous-key',
  OPENROUTER_API_KEY: 'parent-openrouter-key',
  OLLAMA_API_KEY: 'parent-ollama-key',
  AWS_SECRET_ACCESS_KEY: 'parent-aws-secret',
  AWS_SESSION_TOKEN: 'parent-aws-session',
});

/** Names of the probed env vars whose value still equals the parent's. */
export function leakedNames(env) {
  return Object.entries(PARENT_PROVIDER_ENV)
    .filter(([name, value]) => env[name] === value)
    .map(([name]) => name);
}

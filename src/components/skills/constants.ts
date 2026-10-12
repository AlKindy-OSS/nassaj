import type { SkillsProvider } from './types';

/** Display names for the harnesses, shared by the skills list and the harness-files section. */
export const PROVIDER_NAMES: Record<SkillsProvider, string> = {
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  qwen: 'Qwen Code',
  antigravity: 'Antigravity',
  kimi: 'Kimi',
  deepseek: 'DeepSeek',
  glm: 'GLM',
  hermes: 'Hermes',
  sakana: 'Sakana',
};

/** Name for a provider id the map may not know yet (a newer server). */
export const providerDisplayName = (provider: string): string => (
  (PROVIDER_NAMES as Record<string, string>)[provider] ?? provider
);

import { AbstractProvider } from '@/modules/providers/shared/base/abstract.provider.js';
import type {
  IProviderAuth,
  IProviderModels,
  IProviderSessionSynchronizer,
  IProviderSessions,
  IProviderSkills,
} from '@/shared/interfaces.js';

import { DeepSeekProviderAuth } from './deepseek-auth.provider.js';
import { DeepSeekProviderModels } from './deepseek-models.provider.js';
import { DeepSeekMcpProvider } from './deepseek-mcp.provider.js';
import { DeepSeekSessionSynchronizer } from './deepseek-session-synchronizer.provider.js';
import { DeepSeekSessionsProvider } from './deepseek-sessions.provider.js';
import { DeepSeekSkillsProvider } from './deepseek-skills.provider.js';

/**
 * DeepSeek provider wrapper. Cursor pattern: inherits shared MCP/Skills bases and
 * implements models/auth/sessions/sessionSynchronizer concretely via the shared
 * vendor bases. Hosted HTTP API over an independent client; never touches the
 * ANTHROPIC/CLAUDE namespace.
 */
export class DeepSeekProvider extends AbstractProvider {
  readonly models: IProviderModels = new DeepSeekProviderModels();
  readonly mcp = new DeepSeekMcpProvider();
  readonly auth: IProviderAuth = new DeepSeekProviderAuth();
  readonly skills: IProviderSkills = new DeepSeekSkillsProvider();
  readonly sessions: IProviderSessions = new DeepSeekSessionsProvider();
  readonly sessionSynchronizer: IProviderSessionSynchronizer = new DeepSeekSessionSynchronizer();

  constructor() {
    super('deepseek');
  }
}

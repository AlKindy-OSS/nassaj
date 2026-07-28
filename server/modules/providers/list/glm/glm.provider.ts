import { AbstractProvider } from '@/modules/providers/shared/base/abstract.provider.js';
import type {
  IProviderAuth,
  IProviderModels,
  IProviderSessionSynchronizer,
  IProviderSessions,
  IProviderSkills,
} from '@/shared/interfaces.js';

import { GlmProviderAuth } from './glm-auth.provider.js';
import { GlmProviderModels } from './glm-models.provider.js';
import { GlmMcpProvider } from './glm-mcp.provider.js';
import { GlmSessionSynchronizer } from './glm-session-synchronizer.provider.js';
import { GlmSessionsProvider } from './glm-sessions.provider.js';
import { GlmSkillsProvider } from './glm-skills.provider.js';

/**
 * GLM (Zhipu / Z.ai) provider wrapper. Cursor pattern: inherits shared MCP/Skills
 * bases and implements models/auth/sessions/sessionSynchronizer concretely via the
 * shared vendor bases. Hosted HTTP API over an independent client; never touches
 * the ANTHROPIC/CLAUDE namespace.
 */
export class GlmProvider extends AbstractProvider {
  readonly models: IProviderModels = new GlmProviderModels();
  readonly mcp = new GlmMcpProvider();
  readonly auth: IProviderAuth = new GlmProviderAuth();
  readonly skills: IProviderSkills = new GlmSkillsProvider();
  readonly sessions: IProviderSessions = new GlmSessionsProvider();
  readonly sessionSynchronizer: IProviderSessionSynchronizer = new GlmSessionSynchronizer();

  constructor() {
    super('glm');
  }
}

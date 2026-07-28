import { AbstractProvider } from '@/modules/providers/shared/base/abstract.provider.js';
import type {
  IProviderAuth,
  IProviderModels,
  IProviderSessionSynchronizer,
  IProviderSessions,
  IProviderSkills,
} from '@/shared/interfaces.js';

import { KimiProviderAuth } from './kimi-auth.provider.js';
import { KimiProviderModels } from './kimi-models.provider.js';
import { KimiMcpProvider } from './kimi-mcp.provider.js';
import { KimiSessionSynchronizer } from './kimi-session-synchronizer.provider.js';
import { KimiSessionsProvider } from './kimi-sessions.provider.js';
import { KimiSkillsProvider } from './kimi-skills.provider.js';

/**
 * Kimi (Moonshot) provider wrapper. Follows the Cursor pattern: inherits the
 * shared MCP/Skills bases and implements models/auth/sessions/sessionSynchronizer
 * concretely (here via the shared vendor bases). Hosted HTTP API reached over an
 * independent client that never touches the ANTHROPIC/CLAUDE namespace.
 */
export class KimiProvider extends AbstractProvider {
  readonly models: IProviderModels = new KimiProviderModels();
  readonly mcp = new KimiMcpProvider();
  readonly auth: IProviderAuth = new KimiProviderAuth();
  readonly skills: IProviderSkills = new KimiSkillsProvider();
  readonly sessions: IProviderSessions = new KimiSessionsProvider();
  readonly sessionSynchronizer: IProviderSessionSynchronizer = new KimiSessionSynchronizer();

  constructor() {
    super('kimi');
  }
}
